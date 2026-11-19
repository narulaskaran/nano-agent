import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

from receiver import Receiver, ombi_message


class WebhookTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.spool = Path(temporary.name)
        server = HTTPServer(("127.0.0.1", 0), Receiver)
        server.spool = self.spool
        server.token = b"a" * 64
        self.url = f"http://127.0.0.1:{server.server_port}/webhooks/ombi"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop():
            server.shutdown()
            thread.join()
            server.server_close()

        self.addCleanup(stop)

    def post(self, event, token="a" * 64):
        request = urllib.request.Request(
            self.url, json.dumps(event).encode(),
            headers={"Content-Type": "application/json", "Access-Token": token},
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status
        except urllib.error.HTTPError as error:
            with error:
                return error.code

    def test_only_valid_availability_events_queue_a_message(self):
        self.assertEqual(self.post({"notificationType": "Test"}), 204)
        event = {
            "notificationType": "RequestAvailable", "requestId": "17",
            "type": "Movie", "title": "Example Movie", "to": "external", "kind": "task",
        }
        self.assertEqual(self.post(event, "wrong"), 401)
        self.assertEqual(self.post({**event, "requestId": "../17"}), 400)
        self.assertEqual(self.post({**event, "overview": "x" * 17000}), 413)
        self.assertEqual(list(self.spool.iterdir()), [])
        self.assertEqual(self.post(event), 204)
        self.assertEqual(self.post(event), 204)
        pending, = self.spool.glob("*.json")
        self.assertEqual(json.loads(pending.read_text()), {
            "kind": "message", "text": "Ready to watch: Example Movie",
        })
        receipt = pending.with_suffix(".done")
        pending.rename(receipt)
        self.assertEqual(self.post(event), 204)
        self.assertEqual(list(self.spool.iterdir()), [receipt])
        self.assertNotEqual(ombi_message(event)[0], ombi_message({**event, "type": "TV Show"})[0])
