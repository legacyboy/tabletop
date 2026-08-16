#!/usr/bin/env python3
"""
Local dev server for Executive Tabletop D20.

The app loads scenarios via fetch(), which does not work over the file://
protocol (browsers block it as a CORS/security restriction). Run this server
and open http://localhost:8000 instead of double-clicking index.html.

Usage:
    python3 serve.py [port]
    (default port: 8000)
"""
import http.server
import functools
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=".")

print(f"Serving Executive Tabletop D20 at http://localhost:{PORT}")
http.server.HTTPServer(("", PORT), handler).serve_forever()
