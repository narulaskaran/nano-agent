---
name: scheduling
description: Patterns for reminders, conditional reminders, temporary monitors and project heartbeats using the schedule tools. Read before scheduling anything more involved than a plain one-time reminder.
---

# Scheduling patterns

All times are the owner's local time. Confirm in one short line what you scheduled and when.

## Plain reminder
"Remind me at 6 to call the dentist" → `schedule_add` with kind `message`, `at`, and the exact text to send. No model run happens when it fires, so write the text as the finished message.

## Conditional reminder
"Remind me Monday if I still haven't returned the shoes" → kind `task`. The body must stand alone: what to check (a note in the knowledge base, the conversation log, an order page), what to say if it is still open, and to answer `[silent]` if it is already done.

## Recurring nudge or digest
Use `cron`. Add `until` whenever there is a natural end (a trip date, a deadline) so the job removes itself.

## Temporary monitor that only speaks on change
For "tell me when X changes" (a price, a delivery status, a flight, a reply):
1. Write a small script in the workspace that prints one line when the thing changed since last run and prints nothing otherwise. Keep its last-seen value in a state file next to it. Exit 0 whether or not anything changed. A non-zero exit means the check itself is broken (see "When a job fails").
2. Schedule it with kind `script`, a `cron` interval that fits how fast the thing changes, and `until`.
3. Use `then: "send"` when the script's line is already a good message. When the check needs judgement ("is this a real change?", "is this worth telling them?"), let the script ask `nano-decide` and print a fixed message only for the answer that matters, still with `then: "send"`. If unsure cases matter, use `then: "task"` instead and have the script print the material only when `nano-decide` exits 3 (unsure), so you judge just those. Use `then: "task"` for every run only when the reply itself needs writing. Private material goes to `nano-local` instead.
4. Cancel it when the owner says it is resolved.

## Gated check: the script gathers, a decision decides
When whether to speak is a judgement ("is this new docket entry a ruling or just a filing?"), keep the script dumb and give the job a `gate` instead of calling `nano-decide` inside it:
1. The script prints the facts (new entries, changed fields) and nothing when there is nothing new. It writes no messages.
2. Schedule it with kind `script` and `gate: {notify: "<what is worth telling the owner>"}`. Use `then: "send"` when the facts read fine as they are, or `then: "task"` with `background: true` when a reply needs writing or a little research.
3. The gate drops output that does not match `notify`, and anything the job already told the owner. When it is unsure or the decision fails, the output goes through as if there were no gate.
4. For a check whose misses would hurt, start with `gate.shadow: true` for a few runs: the agent still sees everything, and `<data>/gate.jsonl` shows whether gate and agent agreed. Drop `shadow` once they do.
Not for private material: the gate asks the decision model, which may be a cloud service. Private checks call `nano-local` in the script.
A script check costs nothing when nothing changed. Prefer it over a recurring `task` whenever the check can be mechanical.

## Project heartbeat
For multi-week things (a trip, an event): keep one note in the knowledge base with open items and dates, and schedule a `task` on a daily or weekly `cron` with `until` set to the event date. The task reads the note, checks what moved, and messages the owner only with something they need to do or decide. Otherwise `[silent]`.

## Housekeeping
- Before adding, call `schedule_list` to avoid duplicates.
- One-time jobs disappear after firing. Recurring jobs run until cancelled or `until` passes.
- Missed while offline: one-time jobs fire on restart; recurring jobs skip the missed runs.
- `schedule_list` shows each job's health: `ok`, `FAILING xN` with the last error, or `UNUSABLE SCHEDULE`. Check it when the owner asks whether something is still running.

## When a job fails
The scheduler handles this; do not add your own retry jobs. A script that exits non-zero, or a background task run that fails:
- Timeouts, network errors, rate limits and 5xx responses wait for the next run. They count as a real failure after 3 runs in a row or an hour.
- A real failure starts one background repair, briefed with the job and its error. If you are that repair: fix the script, its state or its inputs, confirm by running it, and answer exactly `FIXED: <what was wrong and what you changed>`. That stays in the log; the owner is not messaged about successful fixes. Anything that needs the owner (logins, credentials, money, accounts, or what the job is for): say so in one or two lines for them, and stop.
- Still failing 30 minutes after the repair: the owner is told once, and hears again only when it works.
- A one-time reminder whose send fails is retried for 10 minutes, then the owner is told what was missed.
