#!/usr/bin/env python3
"""SPA-fallback static server for local dev and E2E.

Mirrors how Cloudflare Pages serves this site: a real file (│/css/styles.css,
/data/*.json, /sw.js) is served directly; any *other* path that looks like a
client route falls back to index.html with a 200, so deep links like
/leaderboard or /crises/sudan load the app shell and let the router take over.

Plain `python -m http.server` 404s on those paths, which is why the E2E suite —
which needs to test real deep-linking and reloads — points at this instead.

Requests under /api/* are 404'd rather than falling back, because on the real
site those are Pages Functions; serving the HTML shell for them would mask a
broken fetch in a test.

Usage:  python scripts/spa-serve.py [PORT]     (default 8000; serves CWD)
"""
import http.server
import os
import posixpath
import socketserver
import sys
from urllib.parse import unquote, urlsplit

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # No-cache so tests (and dev) never see a stale build.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def _disk_path(self, url_path):
        # Map a URL path to a file on disk the way SimpleHTTPRequestHandler does.
        path = posixpath.normpath(unquote(urlsplit(url_path).path))
        parts = [p for p in path.split("/") if p and p not in (os.curdir, os.pardir)]
        full = os.getcwd()
        for p in parts:
            full = os.path.join(full, p)
        return full

    def send_head(self):
        url_path = urlsplit(self.path).path
        disk = self._disk_path(url_path)
        is_file = os.path.isfile(disk)
        # Fall back to the SPA shell only for non-file, non-API, non-directory
        # paths — i.e. client routes. Everything else keeps default behavior.
        if not is_file and not os.path.isdir(disk) and not url_path.startswith("/api/"):
            self.path = "/index.html"
        return super().send_head()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("", PORT), SpaHandler) as httpd:
        print(f"SPA server on http://localhost:{PORT}  (index.html fallback)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
