"""Private webhook ingress for Nano's durable event outbox."""

import argparse
import hashlib
import hmac
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MAX_BODY = 16 * 1024


def ombi_message(event):
    if event.get("notificationType") != "RequestAvailable":
        return None
    request_id = event.get("requestId")
    media_type = event.get("type")
    title = event.get("title")
    if not isinstance(request_id, str) or not re.fullmatch(r"[1-9][0-9]{0,18}", request_id):
        raise ValueError("Invalid request ID")
    if not isinstance(media_type, str) or not media_type.strip() or len(media_type) > 64:
        raise ValueError("Invalid media type")
    if not isinstance(title, str) or not title.strip() or len(title) > 500:
        raise ValueError("Invalid title")

    identity = json.dumps([media_type.strip().casefold(), request_id]).encode()
    event_id = "ombi-" + hashlib.sha256(identity).hexdigest()
    text = "Ready to watch: " + " ".join(title.split())
    return event_id, {"kind": "message", "text": text}


def enqueue(spool, event_id, message):
    pending = spool / f"{event_id}.json"
    if pending.exists() or pending.with_suffix(".done").exists():
        return False
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=spool)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(message, output)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, pending)
        directory = os.open(spool, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)
    return True


class Receiver(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_args):
        # BaseHTTPRequestHandler normally logs the request line verbatim.
        pass

    def finish_request(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path != "/webhooks/ombi":
            return self.finish_request(404)
        supplied = self.headers.get("Access-Token", "").encode()
        if not hmac.compare_digest(supplied, self.server.token):
            return self.finish_request(401)
        if self.headers.get_content_type() != "application/json":
            return self.finish_request(415)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.finish_request(400)
        if length < 1 or length > MAX_BODY:
            return self.finish_request(413 if length > MAX_BODY else 400)
        try:
            raw = self.rfile.read(length)
            event = json.loads(raw)
            if len(raw) != length or not isinstance(event, dict):
                raise ValueError("Invalid event")
            message = ombi_message(event)
        except (ValueError, TimeoutError, RecursionError):
            return self.finish_request(400)
        if message is None:
            outcome = "test accepted" if event.get("notificationType") == "Test" else "ignored"
        else:
            try:
                queued = enqueue(self.server.spool, *message)
            except OSError:
                print("ombi: queue write failed", flush=True)
                return self.finish_request(503)
            outcome = "queued" if queued else "duplicate"
        print(f"ombi: {outcome}", flush=True)
        return self.finish_request(204)


def serve(bind, port, spool, token):
    if len(token) < 32:
        raise ValueError("Use a random token of at least 32 bytes")
    if not spool.is_dir() or not os.access(spool, os.W_OK):
        raise ValueError("The outbox must already exist and be writable")
    with HTTPServer((bind, port), Receiver) as server:
        server.spool = spool
        server.token = token
        server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--spool", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args()
    serve(args.bind, args.port, args.spool, args.token_file.read_bytes().strip())
