"""Start the local Taelgar art gallery. Requires Python 3.9+ and GitHub CLI for sync."""
import errno
import json
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

from review_sync import sync

ROOT = Path(__file__).resolve().parent
PORT = 47831
HOST = "127.0.0.1"
ORIGIN = f"http://{HOST}:{PORT}"
GALLERY = "/vault-restyle/"
URL = ORIGIN + GALLERY + "index.html"
STATIC = {"index.html", "review.js", "review.css", "review-editor.js", "review-editor.css",
          "review-log.js", "inventory.js", "outputs.js"}
IMAGE_TYPES = {".webp", ".jpg", ".jpeg", ".png", ".gif", ".avif"}


class GalleryHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT.parent), **kwargs)

    def log_message(self, *args):
        pass

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_head(self):
        if self.headers.get("Host") != f"{HOST}:{PORT}":
            self.send_error(403)
            return
        path = unquote(urlsplit(self.path).path)
        if path == "/":
            self.send_response(302)
            self.send_header("Location", GALLERY + "index.html")
            self.end_headers()
            return
        if path == "/app":
            self.json_response(200, {"app": "taelgar-art-review", "folder": str(ROOT)})
            return
        parts = path.lstrip("/").split("/")
        if any(not part or part in {".", ".."} or "\\" in part or ":" in part or "\0" in part for part in parts):
            self.send_error(404)
            return
        if parts[0] == "vault-restyle":
            base, relative = ROOT, parts[1:]
            asset = len(relative) == 1 and relative[0] in STATIC
            artwork = len(relative) >= 2 and relative[0] in {"variants", "originals", "thumbnails"}
        else:
            base, relative = ROOT.parent, parts
            asset = False
            artwork = len(relative) == 2 and relative[0] in {"originals", "thumbnails"}
        target = base.joinpath(*relative)
        if not (asset or artwork and target.suffix.lower() in IMAGE_TYPES) or not target.is_file():
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


def open_gallery():
    if not os.environ.get("TAELGAR_REVIEW_NO_BROWSER"):
        webbrowser.open(URL)


def main():
    try:
        server = ThreadingHTTPServer((HOST, PORT), GalleryHandler)
    except OSError as error:
        if error.errno not in (errno.EADDRINUSE, 10048):
            raise
        try:
            with urlopen(ORIGIN + "/app", timeout=2) as response:
                existing = json.load(response)
        except (OSError, ValueError):
            existing = None
        if existing != {"app": "taelgar-art-review", "folder": str(ROOT)}:
            sys.exit(f"Port {PORT} is already being used. Close the other application and reopen the gallery.")
        open_gallery()
        return
    with server:
        print(f"Art Review is open at {URL}\nKeep this window open while reviewing. Press Ctrl+C to quit.", flush=True)
        open_gallery()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
