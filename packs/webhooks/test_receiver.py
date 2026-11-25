import base64
import hashlib
import hmac
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from receiver import Receiver, ombi_message


def svix_headers(secret_bytes, body, *, msg_id="msg_1", ts=None):
    timestamp = str(int(time.time()) if ts is None else ts)
    signed = hmac.digest(secret_bytes, f"{msg_id}.{timestamp}.".encode("ascii") + body, hashlib.sha256)
    return {
        "Content-Type": "application/json",
        "svix-id": msg_id,
        "svix-timestamp": timestamp,
        "svix-signature": "v1," + base64.b64encode(signed).decode("ascii"),
    }


class WebhookTest(unittest.TestCase):
    def start_server(self, agentmail=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        spool = Path(temporary.name) / "spool"
        spool.mkdir()
        server = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        server.spool = spool
        server.token = b"a" * 64
        server.agentmail = agentmail
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join()
            server.server_close()

        self.addCleanup(stop)
        return Path(temporary.name), spool, f"http://127.0.0.1:{server.server_port}"

    def send(self, url, body, headers):
        request = urllib.request.Request(url, body, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status
        except urllib.error.HTTPError as error:
            with error:
                return error.code

    def test_only_valid_availability_events_queue_a_message(self):
        _, spool, base = self.start_server()
        url = f"{base}/webhooks/ombi"
        post = lambda event, token="a" * 64: self.send(
            url, json.dumps(event).encode(),
            {"Content-Type": "application/json", "Access-Token": token},
        )
        self.assertEqual(post({"notificationType": "Test"}), 204)
        event = {
            "notificationType": "RequestAvailable", "requestId": "17",
            "type": "Movie", "title": "Example Movie", "to": "external", "kind": "task",
        }
        self.assertEqual(post(event, "wrong"), 401)
        self.assertEqual(post({**event, "requestId": "../17"}), 400)
        self.assertEqual(post({**event, "overview": "x" * 17000}), 413)
        self.assertEqual(list(spool.iterdir()), [])
        self.assertEqual(post(event), 204)
        self.assertEqual(post(event), 204)
        pending, = spool.glob("*.json")
        self.assertEqual(json.loads(pending.read_text()), {
            "kind": "message", "text": "Ready to watch: Example Movie",
        })
        receipt = pending.with_suffix(".done")
        pending.rename(receipt)
        self.assertEqual(post(event), 204)
        self.assertEqual(list(spool.iterdir()), [receipt])
        self.assertNotEqual(ombi_message(event)[0], ombi_message({**event, "type": "TV Show"})[0])
        # AgentMail route is disabled until configured.
        self.assertEqual(self.send(f"{base}/webhooks/agentmail-inbound", b"{}", {}), 404)

    def test_agentmail_verifies_svix_signature_filters_inbox_and_touches_trigger(self):
        secret_bytes = b"0123456789abcdef0123456789abcdef"
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        secret_file = root / "secret"
        secret_file.write_text("wh" + "sec_" + base64.b64encode(secret_bytes).decode("ascii"))
        trigger = root / "pending"
        _, _, base = self.start_server(agentmail={
            "secret_file": secret_file,
            "inbox": "user@example.com",
            "trigger_file": trigger,
        })
        url = f"{base}/webhooks/agentmail-inbound"
        valid = json.dumps({"event_type": "message.received", "message": {"inbox_id": "user@example.com"}}).encode()

        # Missing or invalid signature, or stale timestamp.
        self.assertEqual(self.send(url, valid, {"Content-Type": "application/json"}), 401)
        self.assertEqual(self.send(url, valid, svix_headers(b"wrong" * 6, valid)), 401)
        self.assertEqual(self.send(url, valid, svix_headers(secret_bytes, valid, ts=int(time.time()) - 600)), 401)
        self.assertFalse(trigger.exists())

        # Signed delivery for another inbox or event type is ignored.
        other_inbox = json.dumps({"event_type": "message.received", "message": {"inbox_id": "other@example.com"}}).encode()
        self.assertEqual(self.send(url, other_inbox, svix_headers(secret_bytes, other_inbox)), 200)
        other_type = json.dumps({"event_type": "message.sent", "message": {"inbox_id": "user@example.com"}}).encode()
        self.assertEqual(self.send(url, other_type, svix_headers(secret_bytes, other_type)), 200)
        self.assertFalse(trigger.exists())

        # Signed matching delivery touches the trigger file.
        self.assertEqual(self.send(url, valid, svix_headers(secret_bytes, valid)), 200)
        self.assertTrue(trigger.exists())
