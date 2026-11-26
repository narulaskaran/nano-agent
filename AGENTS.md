# AGENTS.md

Instructions for coding agents working in this repository.

## Setting Nano up for someone

Goal: a running `nano` container that answers the owner's iMessages.

1. Check prerequisites: `docker --version` and `docker compose version` both work.
2. `cp .env.example .env`, then start `docker compose build` in the background; it is slow and does not need `.env`. If `id -u` is not 1000, set `NANO_UID` and `NANO_GID` to `id -u` and `id -g`.
3. Ask for their phone number (E.164, for example `+15551234567`) and model provider (OpenRouter is the default). Write the number into `NANO_ALLOWED_USERS`, and `NANO_MODEL` (`provider/model-id`) for a provider other than OpenRouter.
4. Walk them through each secret, one at a time: give them the link and the clicks, and ask them to copy the value and tell you when it is on their clipboard. Then move the clipboard straight into that line of `.env`, trimmed and single-quoted (`NAME='value'`, so Compose does not expand `$`). The value must never appear in your output: confirm with the name and length only. If the clipboard is empty, has spaces, or matches a key already set, they copied the wrong thing; ask again. Never ask for a secret in chat, print or read `.env`, or commit it.
   - `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`: sign up at https://app.photon.codes, create a project, enable iMessage, register their phone number, and copy each value from the project's settings.
   - The model key: `OPENROUTER_API_KEY` from https://openrouter.ai/settings/keys, or the key named in `.env.example` for their provider, from that provider's API keys page. Suggest a dedicated key with a spend limit.
   - Optional `BRAVE_SEARCH_API_KEY` for web search, from https://brave.com/search/api. Offer it; skip it if they would rather not.

   With no clipboard to read (a remote or headless host), ask them to paste each value into `.env` themselves in an editor on that host.
5. Once the build is done, `docker compose run --rm nano node /app/src/index.ts --check`. It must end with `nano: check ok`. If it reports a problem, fix exactly what it names; for a bad key, have the person copy it again and replace that line.
6. `docker compose up -d`, then `docker compose logs --tail 30 nano`. Expect `Spectrum started` and `nano: listening on photon`.
7. Ask the person to text their Photon number. A reply within a minute means setup is done. The first conversation is an onboarding chat; nothing else needs configuring by hand.

If there is no reply: check the logs for `ignoring message from non-allowed sender` (the allow-listed number does not match the sending number) or a model error (bad or missing key).

## Working on the code

- Node 24, TypeScript run directly with no build step. Use erasable syntax only (no enums, no parameter properties).
- `npm run typecheck && npm test` must pass before you call a change done. CI (`.github/workflows/ci.yml`) runs both on every pull request, plus the personal-data scan from the pre-commit hook.
- Dependabot opens weekly update pull requests and security fixes. Patch and minor updates merge on their own once CI passes; majors and the exact-pinned packages below wait for review.
- Test conversation behaviour locally with `NANO_CHANNEL=stdin` and a throwaway `NANO_DATA_DIR`: `npm install --ignore-scripts`, then `NANO_CHANNEL=stdin NANO_DATA_DIR=/tmp/nano-dev OPENROUTER_API_KEY=... npm start` and type messages on stdin.
- Keep the runtime small. Prefer a skill (Markdown) over new runtime code when instructions are enough.
- New capabilities are packs (see "Packs" below). A pack keeps everything it needs inside `packs/<name>/` and touches `src/` only when the runtime truly lacks a hook. Shipped packs must be useful to any owner; anything specific to one person belongs in `data/packs/`, outside the repository.
- `@spectrum-ts/*` and `@earendil-works/pi-*` are pinned to exact versions; both ship breaking changes. Read their type definitions in `node_modules` before changing calls into them.

## Touching a running container

`docker exec nano ...` runs as root, because only the entrypoint drops privileges. Anything it creates under `/data` is root-owned and unwritable (or unreadable, for mode-600 state files) to Nano, and a scheduled job that needs it fails with `Permission denied`. Always pass the owner's ids: `docker exec -u "$NANO_UID:$NANO_GID" nano ...`. That includes the first test run of a script you just wrote. Start-up hands root-owned files under `data/packs/` and `data/workspace/` back to that user, but only on restart, so do not rely on it.

## Layout

```
src/            the runtime (TypeScript, no build step)
  index.ts      wiring and shutdown
  channel.ts    Photon iMessage channel, plus a stdin channel for local testing
  agent.ts      one conversation: Pi session, idle rollover, message bursts, turn queue
  session.ts    Pi session setup shared by conversations and workers
  tasks.ts      background tasks: queue, limits, persistence, hand-back
  worker.ts     runs a background task in its own Pi session
  models.ts     model runtime, local model provider, main/local/private choice
  local.ts      one-shot local model calls (ask_local, nano-local)
  scheduler.ts  reminders, cron jobs, script monitors, outbox
  queue.ts      durable SQLite job queue with retries, dedupe and per-key ordering
  outbound.ts   duplicate-safe owner send queue on Photon clientMessageId
  capture.ts    background knowledge-base filer and confined KB tools
  decide.ts     typed decisions from the decision model (nano-decide), with a log
  gate.ts       the gate on scheduled script output
  router.ts     the decision made on each owner message before its turn
  packs.ts      pack loading
  tools.ts      tools added on top of Pi's built-ins
  task-tools.ts delegate and task management tools
  prompt.ts     system prompt assembly
bin/            commands on PATH (nano-local)
prompts/        the standing prompt
packs/<name>/   capabilities shipped with Nano
templates/kb/   starter knowledge base for new installs
data/           everything personal (git-ignored); vault/ holds credentials (git-ignored)
```

## Packs

A pack is a folder that adds one capability. `NANO_PACKS` lists the ones to load.

```
<pack>/skills/<skill>/SKILL.md   Agent Skills, advertised to the model and read on demand
<pack>/extension.ts              optional: tools and hooks (default export `(ctx) => ExtensionFactory`)
<pack>/capture.ts                optional: tools the background KB filer gets for this pack's items (default export `(ctx) => { <source>: { tools(payload) } }`)
<pack>/bin/                      optional: commands put on PATH for the agent's shell
<pack>/install.sh                optional: system dependencies, run when the image is built
<pack>/start-root.sh             optional: run as root at container start, before privileges drop (a pack under `data/packs/` cannot use this)
<pack>/env.example               optional: settings the pack reads
```

Packs in `packs/` ship with Nano and should be useful to anyone. Personal workflows go in `data/packs/<name>/` with the same layout. When you add a shipped pack, add a row to the pack table in the README.

## Zero personal data

This is a public repository. Never commit personal information:

- real names, email addresses, phone numbers, physical addresses
- API keys, tokens, secrets, payment method or token IDs, card digits
- non-localhost IP addresses, filesystem paths containing a username
- anything from `data/` or `vault/`

Use placeholders instead: `Jane Doe`, `user@example.com`, `+15551234567`, `123 Main St, Anytown, ST 12345`, `pm_visa_xxxxxxxxxxxx`, `/home/user/`, and `<angle-bracket>` placeholders in command examples.

A pre-commit hook scans staged files. Install it with `git config core.hooksPath .githooks`. If you commit personal data by accident, do not push; amend the commit first.
