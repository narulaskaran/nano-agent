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
| `mcp` | Any MCP server listed in `data/pi/mcp.json`. [Setup](packs/mcp/README.md) |
| `purchases` | A headless browser and Stripe Link for buying things; Link's own app approval is the gate. [Setup](packs/purchases/README.md) |
| `vault` | Credentials the agent can use but not read, entered through a page on your tailnet. Needs `purchases`. [Setup](packs/vault/README.md) |
| `speech` | Voice memo transcription and spoken replies. Needs `vault`. [Setup](packs/speech/README.md) |
| `t3code` | Hands coding work to a T3 Code server. Needs `mcp`. [Setup](packs/t3code/README.md) |
| `agentmail` | Hands AgentMail inbox events to Nano; adapts an existing monitor. [Setup](packs/agentmail/README.md) |

Your own workflows go in `data/packs/<name>/` and never leave your machine. To write a pack, see [AGENTS.md](AGENTS.md#packs).

## How it behaves

- **Background tasks.** Only a task's final answer comes back to the conversation. Tasks cut off by a restart are reported on the next start.
- **Failing scheduled jobs.** Transient errors wait for the next run. A real failure gets one repair attempt, then you are told once. A reminder that fails to send is retried for 10 minutes, then delivered marked late.
- **Private work.** Work marked private runs only on the local model and is refused without one, but its final answer goes through the main model, so keep private instructions narrow.
- **Other programs can message you.** Drop a `.txt` file (sent as is) or a `.json` file (`{"text": "...", "kind": "message" | "task"}`, where `task` hands the text to the agent as instructions) into `data/outbox/`. Write to a temporary name and rename it, so a half-written file is never read.

## Contributing

Code layout, pack format, and development commands are in [AGENTS.md](AGENTS.md).
