"""Sync the gallery's immutable review entries through the signed-in GitHub CLI."""

import io
import json
import re
import subprocess
from datetime import datetime
from urllib.parse import quote
from zipfile import BadZipFile, ZipFile

REPO = "repos/tsackton/taeglar-art-review"
BRANCH = "main"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,219}")
ITEM = re.compile(r"(?:catalog-[0-9]+|vault-[a-f0-9]+)")
FINGERPRINT = re.compile(r"[a-f0-9]{64}")
CHOICES = (None, "original", "plain-faithful", "plain-corrected", "setting-faithful",
           "setting-corrected", "light-faithful", "light-corrected", "dark-faithful",
           "dark-corrected", "faithful", "light-correction", "full-correction")
BASE_FIELDS = {"id", "itemId", "sourceSha256", "type", "at", "author"}
FIELDS = {
    "choice": {"choice", "mode", "editNote", "variantSha256", "parents"},
    "comment": {"text", "requestId", "proposalId"},
    "review": {"text", "requestId", "proposalId", "parents", "status"},
}


def gh_api(endpoint, method="GET", body=None, binary=False):
    args = ["gh", "api", "--hostname", "github.com", "--method", method, REPO + "/" + endpoint]
    payload = None
    if body is not None:
        args.extend(["--input", "-"])
        payload = json.dumps(body, ensure_ascii=True, allow_nan=False).encode("ascii")
    try:
        result = subprocess.run(args, input=payload, capture_output=True, timeout=120)
    except FileNotFoundError as error:
        raise RuntimeError("Install GitHub CLI and sign in with gh auth login.") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("GitHub did not respond in time. Try Sync again.") from error
    if result.returncode:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(message or "GitHub request failed. Check your connection and gh auth status.")
    if binary:
        return result.stdout
    return json.loads(result.stdout) if result.stdout.strip() else None


def short_text(value, limit=32000):
    # JavaScript counts text length in UTF-16 code units.
    return isinstance(value, str) and len(value.encode("utf-16-le", "surrogatepass")) <= limit * 2


def valid_id(value):
    return isinstance(value, str) and ID.fullmatch(value)


def event_path(event):
    """Only recognized review records can create files, always under their image ID."""
    if not isinstance(event, dict):
        raise ValueError("Invalid review entry.")
    extra = FIELDS.get(event.get("type")) if isinstance(event.get("type"), str) else None
    if extra is None or set(event) != BASE_FIELDS | extra:
        raise ValueError("Unexpected fields in a review entry.")
    for name, pattern in (("id", ID), ("itemId", ITEM), ("sourceSha256", FINGERPRINT)):
        if not isinstance(event[name], str) or not pattern.fullmatch(event[name]):
            raise ValueError("Invalid review entry " + name + ".")
    if not short_text(event["author"], 200) or not short_text(event["at"], 40):
        raise ValueError("Invalid review date or author.")
    datetime.fromisoformat(event["at"].replace("Z", "+00:00"))
    if "parents" in event:
        parents = event["parents"]
        if not isinstance(parents, list) or not all(valid_id(ref) for ref in parents) or event["id"] in parents:
            raise ValueError("Invalid review revision links.")
    if event["type"] == "choice":
        choice, mode, fingerprint = event["choice"], event["mode"], event["variantSha256"]
        if choice not in CHOICES or mode not in ("use", "edits") or not short_text(event["editNote"]):
            raise ValueError("Invalid selection.")
        if choice is None and mode != "use":
            raise ValueError("Invalid selection mode.")
        if choice in (None, "original"):
            if fingerprint is not None:
                raise ValueError("Unexpected variant fingerprint.")
        elif not isinstance(fingerprint, str) or not FINGERPRINT.fullmatch(fingerprint):
            raise ValueError("Invalid variant fingerprint.")
    else:
        if not short_text(event["text"]) or any(
            ref is not None and not valid_id(ref) for ref in (event["requestId"], event["proposalId"])
        ):
            raise ValueError("Invalid review note or reference.")
        if event["type"] == "comment" and not event["text"].strip():
            raise ValueError("A comment needs text.")
        if event["type"] == "review":
            status = event["status"]
            if status not in ("requested", "approved", "rejected") or (status == "requested") != (event["requestId"] is None):
                raise ValueError("Invalid review status.")
    return "reviews/" + event["itemId"] + "/" + quote(event["id"], safe="") + ".json"


def read_remote(head):
    # The archive is pinned to the same commit used as the parent of any write.
    # Reading it in memory also works on Windows with legacy IDs containing colons.
    data = gh_api("zipball/" + head, binary=True)
    events = {}
    try:
        downloaded = ZipFile(io.BytesIO(data))
    except BadZipFile as error:
        raise RuntimeError("The GitHub download was incomplete. Try Sync again.") from error
    with downloaded as archive:
        for info in archive.infolist():
            path = info.filename.partition("/")[2]
            if not path.startswith("reviews/") or not path.endswith(".json"):
                continue
            event = json.loads(archive.read(info))
            if event_path(event) != path or event["id"] in events:
                raise ValueError("Duplicate or misplaced shared review entry: " + path)
            events[event["id"]] = event
    return events


def sync(events, pull_only=False):
    if not isinstance(events, list) or not isinstance(pull_only, bool):
        raise ValueError("Invalid sync request.")
    local = {}
    for event in events:
        event_path(event)
        if event["id"] in local and local[event["id"]] != event:
            raise ValueError("Two local review entries share an ID with different contents.")
        local[event["id"]] = event

    first_count = None
    failed_head = None
    failure = ""
    for _ in range(6):
        commit = gh_api("branches/" + BRANCH)["commit"]
        head = commit["sha"]
        remote = read_remote(head)
        for key in remote.keys() & local.keys():
            if remote[key] != local[key]:
                raise ValueError("Shared and local copies of a review entry disagree: " + key)
        incoming = [event for key, event in remote.items() if key not in local]
        if incoming or pull_only:
            # Browser validates and persists incoming events before sending a new push request.
            return {"events": incoming, "pulled": len(incoming), "pushed": 0}

        missing = [event for key, event in local.items() if key not in remote]
        if first_count is None:
            first_count = len(missing)
        if not missing:
            return {"events": [], "pulled": 0, "pushed": first_count}
        if head == failed_head:
            raise RuntimeError("GitHub could not update the shared log. " + failure)

        entries = [
            {"path": event_path(e), "mode": "100644", "type": "blob",
             "content": json.dumps(e, ensure_ascii=True, indent=2, sort_keys=True) + "\n"}
            for e in missing
        ]
        tree = gh_api("git/trees", "POST", {"base_tree": commit["commit"]["tree"]["sha"], "tree": entries})
        proposal = gh_api("git/commits", "POST", {
            "message": "Sync art review entries", "tree": tree["sha"], "parents": [head],
        })
        try:
            gh_api("git/refs/heads/" + BRANCH, "PATCH", {"sha": proposal["sha"], "force": False})
            return {"events": [], "pulled": 0, "pushed": first_count}
        except RuntimeError as error:
            # Another reviewer can advance main, or the reply to a successful write can be lost.
            # Re-read the branch before retrying so neither case produces a duplicate.
            failed_head, failure = head, str(error)
    raise RuntimeError("The shared log kept changing. Click Sync again.")
