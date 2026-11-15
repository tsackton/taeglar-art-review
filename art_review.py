"""Run the review gallery with an independently located image source."""
import argparse
import errno
import json
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from urllib.request import urlopen

from review_sync import PROJECT, sync

ROOT = Path(__file__).resolve().parent
GALLERY = ROOT / "gallery"
SAVED_SOURCE = ROOT / ".image-source"
PORT = 47831
HOST = "127.0.0.1"
ORIGIN = f"http://{HOST}:{PORT}"
STATIC = {"index.html", "review.js", "review.css", "review-editor.js", "review-editor.css", "review-log.js"}
MANIFESTS = {"inventory.json", "outputs.json"}
IMAGE_TYPES = {".webp", ".jpg", ".jpeg", ".png", ".gif", ".avif"}


def choose_source(argument):
    if argument:
        return Path(argument).expanduser().resolve()
    if SAVED_SOURCE.is_file():
        saved = Path(SAVED_SOURCE.read_text(encoding="utf-8").strip())
        if saved.is_absolute() and (saved / "inventory.json").is_file():
            return saved.resolve()
    sibling = ROOT.parent / "image-source"
    if (sibling / "inventory.json").is_file():
        return sibling.resolve()
    try:
        from tkinter import Tk, TclError, filedialog
    except ImportError:
        Tk = None
    if Tk:
        try:
            window = Tk()
            window.withdraw()
            try:
                folder = filedialog.askdirectory(parent=window, title="Choose the image source containing inventory.json",
                                                 mustexist=True)
            finally:
                window.destroy()
            if not folder:
                raise SystemExit("No image source selected.")
            return Path(folder).resolve()
        except TclError:
            pass
    if sys.stdin.isatty():
        folder = input("Image source folder (containing inventory.json): ").strip()
        if folder:
            return Path(folder).expanduser().resolve()
    raise SystemExit("Start the gallery with python art_review.py followed by the path to your image source.")


def project_id(source):
    for name in sorted(MANIFESTS):
        if not (source / name).is_file():
            raise ValueError(f"Missing {name} in {source}. Choose the folder containing the image inventory.")
    with (source / "inventory.json").open(encoding="utf-8") as inventory:
        data = json.load(inventory)
    identifier = data.get("projectId") if isinstance(data, dict) else None
    if not isinstance(identifier, str) or not PROJECT.fullmatch(identifier):
        raise ValueError(f"Set a valid projectId in {source / 'inventory.json'}.")
    return identifier


class GalleryHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        # A newly selected source can have different files with the same relative names.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_head(self):
        if self.headers.get("Host") != f"{HOST}:{PORT}":
            self.send_error(403)
            return
        url = urlsplit(self.path)
        path = unquote(url.path)
        if path == "/app":
            self.json_response(200, self.server.identity)
            return
        parts = path.removeprefix("/").split("/") if path != "/" else ["index.html"]
        if len(parts) == 1 and parts[0] in STATIC:
            target = GALLERY / parts[0]
        elif parts[0] == "data":
            project = parse_qs(url.query).get("project")
            if project and project != [self.server.project_id]:
                self.send_error(409, "Image source changed. Reload the gallery.")
                return
            parts = parts[1:]
            manifest = len(parts) == 1 and parts[0] in MANIFESTS
            image = (len(parts) >= 2 and parts[0] in {"originals", "thumbnails", "variants"}
                     and Path(parts[-1]).suffix.lower() in IMAGE_TYPES)
            if not (manifest or image) or any(
                not p or p in {".", ".."} or "\\" in p or ":" in p or "\0" in p for p in parts
            ):
                self.send_error(404)
                return
            target = self.server.source.joinpath(*parts).resolve()
            if not target.is_relative_to(self.server.source):
                self.send_error(404)
                return
        else:
            self.send_error(404)
            return
        if not target.is_file():
            self.send_error(404)
            return
        self.asset_path = str(target)
        return super().send_head()

    def translate_path(self, path):
        return self.asset_path

    def do_POST(self):
        if self.path != "/sync":
            return self.json_response(404, {"error": "Unknown request."})
        if self.headers.get("Host") != f"{HOST}:{PORT}" or self.headers.get("Origin") != ORIGIN:
            return self.json_response(403, {"error": "Open the gallery through its launcher."})
        if self.headers.get_content_type() != "application/json":
            return self.json_response(415, {"error": "Expected a JSON review log."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 20 * 1024 * 1024:
                return self.json_response(413, {"error": "Invalid review log size."})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or not isinstance(data.get("events"), list) or not isinstance(data.get("pullOnly"), bool):
                raise ValueError("Invalid review sync request.")
            if data.get("projectId") != self.server.project_id:
                raise ValueError("The selected image source has changed. Reload the gallery before syncing.")
            result = sync(data["events"], pull_only=data["pullOnly"], project_id=self.server.project_id)
        except (ValueError, RuntimeError, OSError) as error:
            return self.json_response(400, {"error": str(error)})
        self.json_response(200, result)


class GalleryServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"


def open_gallery():
    if not os.environ.get("TAELGAR_REVIEW_NO_BROWSER"):
        webbrowser.open(ORIGIN + "/")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", help="image source folder containing inventory.json and outputs.json")
    source = choose_source(parser.parse_args().source)
    try:
        identifier = project_id(source)
    except (ValueError, OSError) as error:
        sys.exit(str(error))
    identity = {"app": "taelgar-art-review", "review": str(ROOT), "source": str(source), "projectId": identifier}
    try:
        server = GalleryServer((HOST, PORT), GalleryHandler)
    except OSError as error:
        if error.errno not in (errno.EADDRINUSE, 10048):
            raise
        try:
            with urlopen(ORIGIN + "/app", timeout=2) as response:
                existing = json.load(response)
        except (OSError, ValueError):
            existing = None
        if existing != identity:
            sys.exit(f"Port {PORT} is in use. Close the running gallery or other application, then reopen this source.")
        open_gallery()
        return
    with server:
        server.source = source
        server.project_id = identifier
        server.identity = identity
        SAVED_SOURCE.write_text(str(source) + "\n", encoding="utf-8")
        print(f"Image source: {source}\nArt Review: {ORIGIN}/\nKeep this window open while reviewing.", flush=True)
        open_gallery()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
