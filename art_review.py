"""Open the Taelgar art review gallery."""
import argparse
import errno
import json
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

import candidate_review
from review_sync import read_checkout, sync

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
        if saved.is_absolute() and all((saved / name).is_file() for name in MANIFESTS):
            return saved.resolve()
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


class GalleryHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
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
        path = unquote(urlsplit(self.path).path)
        if path in {"/edit-queue", "/review-events"}:
            try:
                value = (read_checkout(ROOT) if path == "/review-events" else
                         candidate_review.queue(self.server.edits, self.server.source))
            except (KeyError, TypeError, ValueError, OSError) as error:
                self.json_response(400, {"error": str(error)})
                return
            self.json_response(200, value)
            return
        if path == "/edited.html":
            self.send_response(302)
            self.send_header("Location", "/?view=edits")
            self.end_headers()
            return
        if path == "/app":
            self.json_response(200, self.server.identity)
            return
        parts = path.removeprefix("/").split("/") if path != "/" else ["index.html"]
        if len(parts) == 1 and parts[0] in STATIC:
            target = GALLERY / parts[0]
        elif parts[0] == "edited-images":
            target = candidate_review.image_path(self.server.edits, path)
            if target is None:
                self.send_error(404)
                return
        elif parts[0] == "data":
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
            result = sync(data["events"], pull_only=data["pullOnly"])
        except (ValueError, RuntimeError, OSError) as error:
            return self.json_response(400, {"error": str(error)})
        self.json_response(200, result)


class GalleryServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"


def open_gallery(page):
    if not os.environ.get("TAELGAR_REVIEW_NO_BROWSER"):
        webbrowser.open(ORIGIN + page)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", help="image source folder containing inventory.json and outputs.json")
    parser.add_argument("--edited", action="store_true", help="open the edited candidates review")
    options = parser.parse_args()
    page = "/?view=edits" if options.edited else "/"
    source = choose_source(options.source)
    for manifest in MANIFESTS:
        if not (source / manifest).is_file():
            sys.exit(f"Missing {manifest}. Choose the downloaded image-source folder.")
    identity = {"app": "taelgar-art-review", "version": 2, "review": str(ROOT), "source": str(source)}
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
        if isinstance(existing, dict) and existing.get("app") == identity["app"] and existing.get("version") != identity["version"]:
            sys.exit("An older Art Review gallery is running. Close its launcher window and reopen this launcher.")
        if existing != identity:
            sys.exit(f"Port {PORT} is in use. Close the running gallery or other application, then reopen this source.")
        open_gallery(page)
        return
    with server:
        server.edits = source.parent / "restyle-edits"
        server.source = source
        server.identity = identity
        SAVED_SOURCE.write_text(str(source) + "\n", encoding="utf-8")
        print(f"Image source: {source}\nArt Review: {ORIGIN}{page}\nKeep this window open while reviewing.", flush=True)
        open_gallery(page)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
