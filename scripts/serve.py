#!/usr/bin/env python3
"""Worldly dev/launcher server.

A tiny static file server that behaves like `python -m http.server` but sends
no-cache headers on every response. Browsers aggressively cache files served
from localhost, which meant updates to the app (new branding, bug fixes such as
the map click handling) would not appear until a manual hard-refresh. Serving
with `Cache-Control: no-store` guarantees the browser always fetches the current
files, so the app is never stuck on a stale version.

Usage:  python serve.py [PORT]     (default 8000; serves the current directory)
"""
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True  # avoid "address already in use" on quick restarts


if __name__ == "__main__":
    with Server(("", PORT), NoCacheHandler) as httpd:
        print(f"Serving Worldly at http://localhost:{PORT}  (no-cache)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
