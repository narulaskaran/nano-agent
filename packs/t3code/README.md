# t3code pack

Lets Nano hand coding work to [T3 Code](https://github.com/pingdotgg/t3code). You text "have T3 fix the flaky test in repo X"; Nano starts a T3 Code thread in that project with a self-contained brief, replies with a link, checks back on a schedule and relays the result.

Needs the `mcp` pack: `NANO_PACKS=core,mcp,t3code`.

## Setup

1. Add the packs to `NANO_PACKS`, copy the settings you need from [env.example](env.example) into `.env` (at least `NANO_T3CODE_WEB_URL`), and run `docker compose up -d`.
2. On the T3 Code machine, create a single-use pairing code, valid for 5 minutes:
   ```bash
   t3 pair --scope orchestration:read --scope orchestration:operate --label Nano
   ```
   Or create one in T3 Code's Connections settings. Add `--scope settings:write --scope source-control:write` only if you want `full-access`.
3. Text Nano `T3 pairing code: <code>`, optionally followed by an access level, for example `T3 pairing code: <code> auto`. Texting "connect to T3 Code" walks you through the same steps. Without chat: `docker exec -it nano /app/packs/t3code/bin/t3code-connect pair --access approval-required`.
4. Nano confirms the access level and expiry date. `t3code-connect status` shows the same and tests the token.

The token lasts 30 days and cannot be refreshed. Nano reminds you two days ahead to repeat steps 2 and 3.

The pairing code never reaches the model: the pack redeems it and replaces it in your message before the model runs. Nano's daily log still records the raw text, but the code is spent by then and is never redeemed twice.

## What Nano can do in T3 Code

Only these tools are exposed, loaded on demand: `t3_project_list`, `t3_project_read`, `t3_thread_search`, `t3_thread_list`, `t3_thread_read`, `t3_thread_launch`, `t3_thread_send`, `t3_thread_interrupt`. It cannot create, change or delete projects, settings, scheduled tasks, previews or devices. To change this list, see [mcp.json.example](mcp.json.example).

Your access level is the ceiling on the threads Nano starts. Nano cannot approve actions inside a thread: with `approval-required`, threads wait for you in T3 Code, and Nano tells you when one is waiting.

T3 Code builds thread links from the address Nano connects to, usually `http://127.0.0.1:4096`, which works only on that machine. `NANO_T3CODE_WEB_URL` rewrites them to the address you open T3 Code at.

`nano-mcp list` does not show `t3code`; use `t3code-connect status`.
