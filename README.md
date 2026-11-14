# Nano

A small personal agent you text over iMessage, built to be cloned and run as your own copy. It is one Docker container on the [Pi](https://pi.dev) agent SDK, reaching iMessage through [Photon](https://photon.codes). No Mac, no public URL, no other chat platforms.

- **Chat over iMessage**: text and images in, text and files out. Only allow-listed numbers are answered.
- **Reminders and scheduled jobs** it creates itself: one-time and conditional reminders, recurring tasks, and monitors that only speak when something changed.
- **Memory on disk**: an owner profile, a Markdown knowledge base, and a searchable daily log. A new context window starts after a few hours of silence.
- **Background tasks**: heavy work (research, browsing, checkouts) runs in separate sessions while Nano keeps answering.
- **Optional local model** for private or light work that should not reach the cloud model.
- **Guided first run**: the first conversation asks your name, timezone and what you want help with.

## Deploy

You need a Linux or macOS host with Docker (Compose v2, about 4 GB of RAM for the container), a Photon project, and one model API key.

1. **Photon**: sign up at [app.photon.codes](https://app.photon.codes), create a project, enable iMessage, register your phone number, and copy the project ID and secret from its settings.
2. **Model key**: the default is DeepSeek (`DEEPSEEK_API_KEY`). Any other provider works; see [Configuration](#configuration).
3. **Clone and configure**:

   ```bash
   git clone https://github.com/narulaskaran/nano-agent.git nano && cd nano
   cp .env.example .env
   ```

   Edit `.env` and set `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `NANO_ALLOWED_USERS` (your own number in E.164 form, such as `+15551234567`; replace the example value) and your model key. If your host user is not uid 1000, also set `NANO_UID` and `NANO_GID` to `id -u` and `id -g` so `./data` stays yours.
4. **Build and check**. The first build is slow because every pack's system dependencies (including a browser) are installed.

   ```bash
   docker compose build
   docker compose run --rm nano node /app/src/index.ts --check   # must end with "nano: check ok"
   ```

   `--check` validates the model, its credentials and the local-model endpoint. It does not test Photon, so confirm that in the next step.
5. **Start and verify**:

   ```bash
   docker compose up -d
   docker compose logs -f nano    # expect "Spectrum started" and "nano: listening on photon"
   ```

   Text your Photon number from the allow-listed phone. The first reply, within about a minute, starts the onboarding chat.

No reply? Look in the logs for `ignoring message from non-allowed sender` (the number differs from `NANO_ALLOWED_USERS`) or a model error (missing or wrong key).

Handing the repo to a coding agent? [AGENTS.md](AGENTS.md) has the same procedure written for it.

## Run it

```bash
docker compose logs -f nano                # watch
docker compose restart nano                # after editing .env
git pull && docker compose up -d --build   # update, or after changing NANO_PACKS
docker compose down                        # stop
```

Two git-ignored directories hold everything that is yours, so **back up both**:

- `data/`: sessions, logs, profile, knowledge base, schedule state, and your own packs in `data/packs/`.
- `vault/`: credentials, used only by the `vault` pack and mounted separately on purpose.

## Security

- Nano has a shell and file tools inside the container, and it can read its own environment, so a model key in `.env` is visible to it. Use a dedicated key with a spend limit.
- Anyone in `NANO_ALLOWED_USERS` can drive the agent. List only yourself, or people you would hand a shell to.
- The [vault pack](packs/vault/README.md) keeps website logins and API keys where the agent can use them but not read them.

## Configuration

Everything is in `.env`; [.env.example](.env.example) documents each setting inline.

| Variable | Meaning |
|---|---|
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | **Required.** From your Photon project settings. |
| `NANO_ALLOWED_USERS` | **Required.** Phone numbers in E.164 form, comma separated. |
| A model key | **Required.** The key for the provider named in `NANO_MODEL` (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, ...). |
| `NANO_MODEL` | `provider/model-id`, default `deepseek/deepseek-flash`. |
| `NANO_THINKING` | Thinking effort: off, minimal, low (default), medium, high. |
| `NANO_PACKS` | Packs to load, default `core`. Rebuild after changing it. |
| `TZ` | Fallback timezone until Nano learns yours. |
| `BRAVE_SEARCH_API_KEY` | Enables the `web_search` tool. |
| `NANO_UID`, `NANO_GID` | Owner of `./data` inside the container, default 1000. |

<details>
<summary>Advanced settings</summary>

| Variable | Meaning |
|---|---|
| `NANO_IDLE_HOURS` | Silence before a fresh context window, default 4. |
| `NANO_INBOUND` | A text sent while Nano is working. `interrupt` (default): one reply answers everything you sent; a reply still being written is cancelled and never sent, a started tool call finishes first, and a scheduled job is never cancelled (the text gets its own turn right after). `steer`: once a model run has started, the text joins its next model call, so a reply already being written still goes out on its own. `queue`: the text waits for a turn of its own, in order. |
| `NANO_MAX_TASKS` | Background tasks at once, default 3; more wait in a queue. |
| `NANO_TASK_TIMEOUT_MINUTES` | A task still running after this is stopped and reported, default 30. |
| `NANO_LOCAL_MODEL`, `NANO_LOCAL_BASE_URL` | A local model id and its OpenAI-compatible `/v1` endpoint (llama.cpp, Ollama, ...). |
| `NANO_LOCAL_API_KEY`, `NANO_LOCAL_CONTEXT` | Its key if it needs one, and its context window in tokens (default 32768). |
| `NANO_EVENT_OUTBOX_DIRS` | Extra trusted spool directories, comma separated. |

To reach a local model on the Docker host, use `http://host.docker.internal:<port>/v1`. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to a `compose.override.yaml` (git-ignored).

</details>

## Packs

A pack adds one capability. Enable them in `NANO_PACKS` (for example `core,google`) and rebuild. Packs with their own settings ship an `env.example` to copy into `.env`.

| Pack | What it adds |
|---|---|
| `core` | Scheduling patterns for reminders, monitors and heartbeats. |
| `google` | Gmail and Google Calendar, connected over chat. [Setup](packs/google/README.md) |
| `mcp` | Any MCP server listed in `data/pi/mcp.json`. [Setup](packs/mcp/README.md) |
| `purchases` | A headless browser and Stripe Link for buying things; Link's own app approval is the gate. [Setup](packs/purchases/README.md) |
| `vault` | Credentials the agent can use and cannot read, plus a write-only portal that must be reachable from the container over a tailnet or LAN address. Needs `purchases`. [Setup](packs/vault/README.md) |
| `speech` | Voice memo transcription and spoken replies. Needs `vault`. [Setup](packs/speech/README.md) |
| `t3code` | Hands coding work to a T3 Code server. Needs `mcp`. [Setup](packs/t3code/README.md) |
| `agentmail` | Hands AgentMail inbox events to Nano; adapts an existing monitor. [Setup](packs/agentmail/README.md) |

Your own workflows go in `data/packs/<name>/` and never leave your machine. To write a pack, see [AGENTS.md](AGENTS.md#packs).

## How it behaves

- **Background tasks.** The agent hands heavy work to a separate session with the same tools, and only the final answer comes back. Tasks cut off by a restart are reported on the next start.
- **Failing scheduled jobs.** Transient errors wait for the next run. A real failure starts one background repair; if that cannot fix it, you are told what is wrong, once. One-time reminders that fail to send are retried for 10 minutes, then delivered with a note that they are late. Job health is in `data/schedule.json`.
- **Local and private work.** `model: "local"` prefers the local model and falls back to the main one. `private: true` runs only on the local model and is refused when none is configured; its final answer still goes through the main model so Nano can tell you about it, so keep private instructions narrow. `ask_local` and `nano-local` make one-shot classification calls that never enter a conversation.
- **Other programs can message you.** Drop a `.txt` file (sent as is) or a `.json` file (`{"text": "...", "kind": "message" | "task"}`, where `task` hands the text to the agent as instructions) into `data/outbox/`. Write to a temporary name and rename it so a half-written file is never picked up.

## Contributing

Code layout, pack format, and development commands are in [AGENTS.md](AGENTS.md).
