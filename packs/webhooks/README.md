# Webhook ingress

The receiver accepts authenticated Ombi events and adds plain owner messages to
Nano's durable event outbox. Run it as a separate process so it can accept events
while Nano is down. Python 3.12 and its standard library are sufficient.

1. Create a dedicated spool owned by the account Nano runs as, with mode 0700.
   Run the receiver as that same account and give both processes write access to
   the spool. Mount it into Nano and append its container path to
   `NANO_EVENT_OUTBOX_DIRS` (comma-separated).
2. Generate a random secret with `openssl rand -hex 32` and save it in a file
   readable by the receiver. Start the receiver using
   `python3 receiver.py --spool <spool> --token-file <token-file>`. The default
   bind is loopback on port 8791. For a container deployment, bind to the
   private Docker network and leave the port unpublished.
3. In Ombi's webhook notification settings, set the URL to
   `http://<receiver>:8791/webhooks/ombi` and set Application Token to that same
   secret. Ombi sends it in the `Access-Token` header. If the connection leaves a
   trusted local network, use HTTPS. An Ombi test is acknowledged and logged.
4. Confirm an availability event is queued and Nano turns the pending JSON file
   into a `.done` receipt. Keep existing notification channels active during
   validation.

Only `RequestAvailable` produces a message. Requests are deduplicated by media
type and request ID while pending and while their receipts are retained. Run one
receiver and one Nano consumer on each spool. Keep the spool on persistent
storage. If a sender retries after acceptance, the receiver acknowledges the
duplicate. Nano retries failed sends, and a crash between sending and recording a
receipt can still cause a duplicate notification. Events that never reach the
receiver depend on the source for retry or reconciliation.

Add future providers as explicit routes with their own authentication and
schema. Webhook data never chooses the recipient or becomes task instructions.

Run the receiver tests with
`python3 -m unittest discover -s packs/webhooks -p 'test_*.py'`.
