# vault

A credential store Nano can use and cannot read. Website logins (username, password, optional TOTP seed), API keys and model-provider keys live in a directory owned by a second Unix user, `nano-vault`. The agent talks to a daemon over a Unix socket that has no operation returning a password, seed, TOTP code, key or browser cookie.

Enable it with `NANO_PACKS=core,purchases,vault`. The purchases pack's browser then runs as `nano-vault` too.

## Trust model

The boundary is the user id. The agent runs as `nano` and can read anything that user can, including `/data`. `nano-vault` owns the secret directory (mode `0700`, mounted at `/vault`), the browser profile and the daemon. The agent can connect to the daemon's socket but not replace it, and it gets back metadata and redacted page text.

The model still sees, on purpose:

- Page content after a login, such as a statement or balance.
- The logged-in session: once `browser login` succeeds, it can click around as that user.
- The last four characters of an API key, to tell keys apart.

Honest leftovers:

- The store is not encrypted; the directory mode and user id are the boundary. Root or `nano-vault` can read it.
- The portal trusts every device in the allowed networks except this machine (the tailnet by default). There is no passphrase. A hostile device there can add, replace or delete entries, but not read a secret back.
- The saved site is trusted with the password. If its page script is compromised, it can re-encode the password past redaction. Save the most specific host you can (`platform.example.com`, not `example.com`).
- Logins are typed only on the saved host over https on the default port. API keys are sent only to the saved hosts on port 443.
- The default portal address is IPv4. An IPv6 tailnet address needs `NANO_VAULT_BIND` and `NANO_VAULT_ALLOW`.

## Portal

A small web page, for the owner, where you add, replace or delete entries. It never shows a secret again (API keys show their last four characters), and blank secret fields on edit keep the current value. Ask Nano for the link; it runs `vault url`. Open it with Tailscale on.

It needs the host's network to see a tailnet or LAN address, which the shipped `compose.yaml` does not give it; without it the daemon logs `no tailnet address found; portal not started`. On a Linux host, add a git-ignored `compose.override.yaml` and run `docker compose up -d`. Docker Desktop's host networking may not expose a Mac's Tailscale address.

```yaml
services:
  nano:
    network_mode: host
```

It binds to `NANO_VAULT_BIND`, or else the first local address in Tailscale's CGNAT range, never to every interface or loopback. It accepts only connections from inside `NANO_VAULT_ALLOW` (the same range by default) that are not from this machine, and checks `Host`, `Origin` and a CSRF token. For LAN access too, list both interface addresses in `NANO_VAULT_BIND` and both networks in `NANO_VAULT_ALLOW`; LAN traffic is plain HTTP, so use it only on a trusted network.

## Providers and Models & voice

The portal's **Providers** page saves a model connection (base URL, key, API format, capabilities). **Models & voice** assigns connections to the main conversation, background tasks, private work, speech to text and text to speech (the last two need the `speech` pack), and decisions. **Decisions** (used by `nano-decide`) must be an OpenRouter connection with a System One model such as `typesafe/jev-1.14`; left blank, they use the main conversation's connection when it is OpenRouter. The daemon forwards only the decision fields and requires zero data retention on every request. Blank assignments keep the `.env` settings. **Test connection** checks the key and loads model IDs. Changes apply on the next request.

Formats: **OpenAI-compatible** (DeepSeek and OpenRouter presets), **Anthropic Messages**, **Bark / Woof** (local speech), and **Custom**. Custom maps each capability to a `path`, a `request` template and response field paths such as `result.text`, with no executable code. Template variables: `{{model}}`, `{{messages}}`, `{{system}}`, `{{tools}}`, `{{text}}`, `{{audio_base64}}`, `{{voice}}`, `{{max_tokens}}`; an exact placeholder keeps the value's JSON type. Put credentials in the key field, not in templates.

Guarantees:

- Keys are never returned in settings, and changing a connection's base URL clears its key.
- Requests go only to the configured endpoint. Hosted connections need HTTPS and cannot resolve to private addresses; private work and its fallback need local connections.
- A fallback is used only if you assign one, after a network failure, rate limit or server error, never after an authentication error.
- Replies are redacted before they reach the agent, so model output arrives only once the upstream response is complete.

## Commands

```
vault list
vault url [--add <site>]
vault fetch <name> [-X METHOD] [-H 'Name: value']... [-d body] <url>
browser login <name> [--user ref] [--password ref] [--otp ref]
```

`vault fetch` sends the key only as the header saved with it (default `Authorization: Bearer <key>`), and only to a saved host or, for a `*.` pin, its subdomains. It refuses redirects off that set, and refuses names that resolve to private addresses unless the pin is that literal address.

`browser login` runs only when the top-level page and the password frame are `https` on the saved site or a subdomain. `deepseek.com.evil.example` does not match `deepseek.com`.

## Settings

See [env.example](env.example). None are required.
