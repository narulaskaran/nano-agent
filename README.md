# Nano

A small personal agent you text over iMessage, built to be cloned and run as your own copy. It is one Docker container on the [Pi](https://pi.dev) agent SDK, reaching iMessage through [Photon](https://photon.codes). No Mac, no public URL, no other chat platforms.

- **Chat over iMessage**: text and images in, text and files out. Only allow-listed numbers are answered.
- **Reminders and scheduled jobs** it creates itself: one-time and conditional reminders, recurring tasks, and monitors that only speak when something changed.
- **Memory on disk**: an owner profile, a Markdown knowledge base, and a searchable daily log. A new context window starts after a few hours of silence.
- **Background tasks**: heavy work (research, browsing, checkouts) runs in separate sessions while Nano keeps answering.
- **Optional local model** for private or light work that should not reach the cloud model.
- **Guided first run**: the first conversation asks your name, timezone and what you want help with.

## Quick start

Paste this into a coding agent such as Claude Code, Codex or Cursor, running on the machine that will host Nano:

```text
Set up Nano for me: clone https://github.com/narulaskaran/nano-agent and follow "Setting Nano up for someone" in its AGENTS.md. Walk me through getting each API key, one at a time.
```

It checks Docker, starts the build, and walks you through each account and key with links. For every key you copy it in your browser and say so; the agent moves it from your clipboard into `.env`. Keys never pass through the chat, and you never edit a file. On a remote host with no clipboard, it asks you to paste them into `.env` yourself.

You need a Linux or macOS host with Docker (Compose v2) and about 1 GB of free RAM, a [Photon](https://app.photon.codes) account, and one model API key.

### Without an agent

1. **Photon**: sign up at [app.photon.codes](https://app.photon.codes), create a project, enable iMessage, register your phone number, and copy the project ID and secret from its settings.
2. **Model key**: the default is OpenRouter (`OPENROUTER_API_KEY`). For another provider, set its key and `NANO_MODEL`.
3. **Clone and configure**:

   ```bash
   git clone https://github.com/narulaskaran/nano-agent.git nano && cd nano
   cp .env.example .env
   ```

   Edit `.env` and set `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `NANO_ALLOWED_USERS` (your own number, such as `+15551234567`) and your model key. If your host user is not uid 1000, also set `NANO_UID` and `NANO_GID` (`id -u`, `id -g`) so `./data` stays yours. Every other setting is documented in the file.
4. **Build and check**. The first build is slow; it installs every pack's dependencies, including a browser.

   ```bash
   docker compose build
   docker compose run --rm nano node /app/src/index.ts --check   # must end with "nano: check ok"
   ```

   `--check` tests the model and its key, not Photon.
5. **Start and verify**:

   ```bash
   docker compose up -d
   docker compose logs -f nano    # expect "Spectrum started" and "nano: listening on photon"
   ```

   Text your Photon number from the allow-listed phone. The first reply, within about a minute, starts the onboarding chat.

No reply? Look in the logs for `ignoring message from non-allowed sender` (the number differs from `NANO_ALLOWED_USERS`) or a model error (missing or wrong key).

## Run it

```bash
docker compose logs -f nano                # watch
docker compose up -d                       # after editing .env (restart does not reread it)
git pull && docker compose up -d --build   # update
docker compose down                        # stop
```

Two git-ignored directories hold everything that is yours, so **back up both**:

- `data/`: sessions, logs, profile, knowledge base, schedule state, and your own packs in `data/packs/`.
- `vault/`: credentials, used only by the `vault` pack.

### Customize Nano's voice

Put lasting preferences for Nano's voice and personality in the optional `data/SOUL.md`, or text Nano something like “Use dry humor in casual chats and save that as my default.” Nano reads the file when it opens a new conversation session. An absent or empty file uses the default voice, and background workers use their own instructions.

Deployment-specific operating instructions belong in `data/LOCAL.md`.

## Security

- Nano has a shell inside the container and can read its own environment, so it can see any key in `.env`. Use a dedicated key with a spend limit.
- The [vault pack](packs/vault/README.md) holds website logins, API keys and model keys where the agent can use them but not read them.
- Anyone in `NANO_ALLOWED_USERS` can drive the agent. List only yourself, or people you would hand a shell to.

## Packs

A pack adds one capability. List the ones you want in `NANO_PACKS` (for example `core,google`) and run `docker compose up -d`. A pack's own settings are in its `env.example`.

| Pack | What it adds |
|---|---|
| `core` | Scheduling patterns for reminders, monitors and heartbeats. |
| `google` | Gmail and Google Calendar, connected over chat. [Setup](packs/google/README.md) |
| `apple-messages` | Streams, searches and reads the owner's synced Messages from a Mac, with on-demand attachments. [Setup](packs/apple-messages/README.md) |
| `mcp` | Any MCP server listed in `data/pi/mcp.json`. [Setup](packs/mcp/README.md) |
| `purchases` | A headless browser and Stripe Link for buying things; Link's own app approval is the gate. [Setup](packs/purchases/README.md) |
| `vault` | Credentials the agent can use but not read, entered through a page on your tailnet. Needs `purchases`. [Setup](packs/vault/README.md) |
| `speech` | Voice memo transcription and spoken replies. Needs `vault`. [Setup](packs/speech/README.md) |
| `t3code` | Hands coding work to a T3 Code server. Needs `mcp`. [Setup](packs/t3code/README.md) |
| `agentmail` | Hands AgentMail inbox events to Nano; adapts an existing monitor. [Setup](packs/agentmail/README.md) |
| `webhooks` | Accepts authenticated Ombi and AgentMail webhooks for Nano. [Setup](packs/webhooks/README.md) |

Your own workflows go in `data/packs/<name>/` and never leave your machine. To write a pack, see [AGENTS.md](AGENTS.md#packs).

## How it behaves

- **Background tasks.** Only a task's final answer comes back to the conversation. Tasks cut off by a restart are reported on the next start.
- **Failing scheduled jobs.** Transient errors wait for the next run. A real failure gets one repair attempt, then you are told once.
- **Messages outside a reply.** Reminders, job output and notices from packs go through a durable queue in `data/nano.sqlite`. Each send carries a stable iMessage idempotency key, so a retry after a timeout or a restart never posts it twice. A send that keeps failing is retried for 10 minutes (an unknown chat or a rejected login gives up at once), then you get one "couldn't deliver" note.
- **Filing what you tell it.** When the router judges that a text states something lasting (a decision, preference, plan, or the state of an ongoing matter), a background filer saves it to the knowledge base after the reply, following the KB's own `INDEX.md` rules. The Gmail inbox watch files mail it is sure about the same way. The filer never messages anyone; what it changed, with a copy of each note before the edit, is in `data/capture/`. Set `NANO_CAPTURE=off` for the inbox watch to hand everything to the agent instead.
- **Routing your texts.** Before a model turn, each text gets one decision from the decision model (about 200 ms with Jev). A text that only closes the exchange ("thanks", 👍) gets no reply; slow multi-step work is handed to a background task; a new topic after 20 quiet minutes starts a fresh context window, carrying the last few messages over. Unsure or failed decisions change nothing. Answers and probabilities go to `data/router.jsonl`, never the text. `NANO_ROUTER=off` turns it off.
- **Gated checks.** A scheduled script can have a `gate`: it prints facts, and a decision on whether they are worth telling you runs before anything is sent or any agent starts. It drops what the job already told you.
- **Decisions.** Scripts and scheduled checks can ask `nano-decide` a typed question (yes/no, pick one, rate) about a file or stdin. It asks the decision model: any endpoint that speaks the System One API, for example Jev on OpenRouter (the default with an OpenRouter key, with zero data retention required) or a self-hosted Clef server (`NANO_DECIDE_URL` and `NANO_DECIDE_MODEL`, or a vault connection). It costs a fraction of a model turn. Every decision is logged to `data/decisions.jsonl` with its probabilities, never its input. The decision model may be a cloud service, so private material goes to `nano-local` instead.
- **Private work.** Work marked private runs only on the local model and is refused without one, but its final answer goes through the main model, so keep private instructions narrow.
- **Other programs can message you.** Drop a `.txt` file (sent as is) or a `.json` file (`{"text": "...", "kind": "message" | "task"}`, where `task` hands the text to the agent as instructions) into `data/outbox/`. Write to a temporary name and rename it, so a half-written file is never read.

## Contributing

Code layout, pack format, and development commands are in [AGENTS.md](AGENTS.md).
