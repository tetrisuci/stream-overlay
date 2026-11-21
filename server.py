#!/usr/bin/env python3
"""Server for the Cascade Clash overlay.

Serves the scenes and control panel, and keeps the bracket's live state (players, scores, current match)
in a JSON file so the control panel can change what the scenes show while they're on air.

Locally:
    python3 server.py                  # http://localhost:7999, no password needed (this computer only)
    python3 server.py --port 9000

Hosted (see docker-compose.yml): set a password and listen on all addresses, behind an HTTPS reverse proxy.
    CONTROL_PASSWORD=... HOST=0.0.0.0 STATE_FILE=/data/state.json python3 server.py

Settings (command line flag, or environment variable if the flag isn't given):
    --host / HOST                 address to listen on (default 127.0.0.1)
    --port / PORT                 port (default 7999)
    --state-file / STATE_FILE     where state is saved (default ./state.json)
    CONTROL_PASSWORD              password required to change anything. Reading is always public, since it's on stream.
                                  Required whenever the server listens on anything other than this computer.
"""
import argparse
import hmac
import json
import os
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
# Everything the browser loads lives in src/, and only src/ is ever served: server.py, state.json,
# Docker files and the like are outside it.
WEB_ROOT = os.path.join(ROOT, "src")
MAX_BODY = 256 * 1024
LOOPBACK = {"127.0.0.1", "localhost", "::1"}

lock = threading.Lock()


def clean_state(raw):
    """Keep only the fields we know about, with sane types and sizes. Raises ValueError if unusable."""
    if not isinstance(raw, dict):
        raise ValueError("state must be an object")
    players = raw.get("players")
    if not isinstance(players, list) or len(players) > 256:
        raise ValueError("players must be a list of at most 256 names")
    results = raw.get("results", {})
    if not isinstance(results, dict) or len(results) > 1024:
        raise ValueError("results must be an object")
    first_to = raw.get("firstTo")
    if first_to is not None and not (isinstance(first_to, int) and not isinstance(first_to, bool) and 1 <= first_to <= 99):
        raise ValueError("firstTo must be a whole number or null")

    clean_results = {}
    for match_id, scores in results.items():
        if (
            isinstance(match_id, str) and len(match_id) <= 12
            and isinstance(scores, list) and len(scores) == 2
            and all(isinstance(n, (int, float)) and not isinstance(n, bool) and 0 <= n <= 999 for n in scores)
        ):
            clean_results[match_id] = [scores[0], scores[1]]

    # Who is playing right now (shown by the main overlay).
    current = raw.get("current") if isinstance(raw.get("current"), dict) else {}
    clean_current = {}
    for side in ("p1", "p2"):
        entry = current.get(side) if isinstance(current.get(side), dict) else {}
        clean_current[side] = {
            "name": str(entry.get("name", ""))[:64],
            "pronouns": str(entry.get("pronouns", ""))[:32],
        }

    # Pronouns remembered per player name.
    remembered = raw.get("pronounsByName") if isinstance(raw.get("pronounsByName"), dict) else {}
    clean_pronouns = {
        str(name)[:64]: str(value)[:32]
        for name, value in list(remembered.items())[:256]
        if isinstance(value, str) and value.strip()
    }

    return {
        "title": str(raw.get("title", ""))[:80],
        "players": [str(name)[:64] for name in players],
        "results": clean_results,
        "firstTo": first_to,
        "current": clean_current,
        "pronounsByName": clean_pronouns,
    }


class Handler(SimpleHTTPRequestHandler):
    # Set in main().
    password = ""
    state_file = os.path.join(ROOT, "state.json")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "/api/state" in (self.path or "") and self.command == "GET":
            return  # the scenes poll every second; keep the log readable
        super().log_message(fmt, *args)

    # ---- static files

    def is_public(self):
        """True for files inside src/ (no directory listings, no dotfiles, nothing outside src/, even via symlinks)."""
        real = os.path.realpath(self.translate_path(self.path))
        if real == WEB_ROOT:
            return True  # "/" serves index.html
        rel = os.path.relpath(real, WEB_ROOT)
        if rel.startswith(".."):
            return False
        return os.path.isfile(real) and not any(part.startswith(".") for part in rel.split(os.sep))

    def send_head(self):
        if self.path.split("?")[0].startswith("/api/") or not self.is_public():
            self.send_error(404)
            return None
        return super().send_head()

    # ---- api

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        """Checks the control password (if one is set). A wrong guess costs a second, to slow down guessing."""
        if not self.password:
            return True
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.startswith("Bearer ") else ""
        if hmac.compare_digest(supplied.encode(), self.password.encode()):
            return True
        time.sleep(1)
        return False

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/session":
            return self.send_json(200, {"authRequired": bool(self.password)})
        if route == "/api/state":
            with lock:
                try:
                    with open(self.state_file, encoding="utf-8") as f:
                        state = json.load(f)
                except (FileNotFoundError, json.JSONDecodeError):
                    # Nothing saved yet: 204 (not an error) so browsers don't log a failed request.
                    self.send_response(204)
                    self.end_headers()
                    return
            return self.send_json(200, state)
        super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route not in ("/api/state", "/api/session"):
            return self.send_json(404, {"error": "not found"})
        # Requiring JSON means other websites can't write to this server from a visitor's browser
        # (that would need a cross-origin preflight, which this server never approves).
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
            return self.send_json(415, {"error": "send application/json"})
        if not self.authorized():
            return self.send_json(401, {"error": "wrong or missing password"})
        if route == "/api/session":
            return self.send_json(200, {"ok": True})  # lets the control panel check a password without saving anything

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self.send_json(413, {"error": "body missing or too large"})
        try:
            state = clean_state(json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeDecodeError) as error:
            return self.send_json(400, {"error": str(error)})
        with lock:
            directory = os.path.dirname(self.state_file) or "."
            os.makedirs(directory, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=directory, prefix=".state-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2)
            os.replace(tmp, self.state_file)
        self.send_json(200, state)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "7999")))
    parser.add_argument("--state-file", default=os.environ.get("STATE_FILE", os.path.join(ROOT, "state.json")))
    args = parser.parse_args()

    password = os.environ.get("CONTROL_PASSWORD", "")
    if not password and args.host not in LOOPBACK:
        raise SystemExit(
            f"Refusing to listen on {args.host} without a password: anyone who can reach the server could change the bracket.\n"
            "Set CONTROL_PASSWORD, or listen on 127.0.0.1 only."
        )

    Handler.password = password
    Handler.state_file = os.path.abspath(args.state_file)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    shown = "localhost" if args.host in LOOPBACK else args.host
    print(f"Overlay server running on {args.host}:{args.port}\n"
          f"  control panel  http://{shown}:{args.port}/control.html{'  (password required to save)' if password else ''}\n"
          f"  bracket scene  http://{shown}:{args.port}/bracket.html\n"
          f"  main overlay   http://{shown}:{args.port}/index.html\n"
          f"  state file     {Handler.state_file}\nPress Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
