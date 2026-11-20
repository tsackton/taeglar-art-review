"""Expose complete, fingerprinted edit sets as inputs to the existing art review gallery."""
import hashlib
import json
import re
from functools import lru_cache
from urllib.parse import quote

IMAGE_ROUTE = re.compile(r"/edited-images/([\w-]+)/([\w-]+)/([123])\.png")


@lru_cache(maxsize=4096)
def fingerprint(path, modified, size):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def digest(path):
    stat = path.stat()
    return fingerprint(path, stat.st_mtime_ns, stat.st_size)


def image_path(root, url):
    match = IMAGE_ROUTE.fullmatch(url)
    if not match:
        return None
    item, request, number = match.groups()
    path = (root / "candidates" / item / request / (number + ".png")).resolve()
    return path if path.is_relative_to((root / "candidates").resolve()) else None


def completed_set(root, source, row):
    urls = [f"/edited-images/{row['id']}/{row['request']}/{n}.png" for n in (1, 2, 3)]
    files = [image_path(root, url) for url in urls]
    if not all(path and path.is_file() and path.stat().st_size for path in files):
        return None
    base = (source / row["base"]).resolve()
    if not base.is_relative_to(source.resolve()) or not base.is_file() or digest(base) != row["baseHash"]:
        return None
    hashes = [digest(path) for path in files]
    if len(set(hashes)) != 3:
        return None
    key = hashlib.sha256("|".join([row["request"], row["baseHash"], *hashes]).encode()).hexdigest()
    return dict(row, key=key, revision=1, images=urls, hashes=hashes, baseUrl="/data/" + quote(row["base"]))


def queue(root, source):
    manifest = root / "requests.json"
    rows = json.loads(manifest.read_text(encoding="utf-8")) if manifest.is_file() else []
    sets = [s for row in rows if (s := completed_set(root, source, row))]
    return {"total": len(rows), "sets": sorted(sets, key=lambda s: s["label"].casefold())}
