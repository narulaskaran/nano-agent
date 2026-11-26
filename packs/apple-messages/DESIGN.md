# Side-chat Nano design

Scope agreed. The [pack README](README.md) describes the current implementation.

## Sessions and memory

- Main Nano remains the owner's private assistant. It can read across chats and consolidate useful details about people in private memory, with the source, date, and any uncertainty.
- Each side chat has its own conversation and saved memory. A fresh model call handles each request using that chat's recent history, including earlier Nano replies, and can look further back in the same chat. The runtime binds access to the current chat ID, even when participants overlap.
- Side chats can save shared plans, preferences, and decisions in their own memory. They can pass attributed facts to main Nano through a one-way handoff. Only main Nano can read the consolidated memory.
- Capture useful details automatically from opted-in chats, including ordinary messages without a Nano mention. Memory capture runs independently of replies and stays quiet.
- Start with a memory scan every 10 minutes per chat when new messages are available. Give Jev the new messages, source IDs, timestamps, and stable labels scoped to that chat. Include a few earlier messages when needed to resolve references. Jev flags durable facts, preferences, plans, and corrections. Nano checks the relevant existing notes before saving an update.
- Automatic capture starts when the chat is enabled. Older messages remain available as context. Backfill saved memory only on the owner's request.
- The owner can ask main Nano privately to correct or forget a saved detail. Apply the change to the source chat's memory and any private summary derived from it.

## Tools and content

- Side Nano can read its chat history, read and write its chat memory, and search or fetch public pages. Public web requests can use public terms and URLs. Keep chat excerpts, contact details, and credentials out of those requests.
- Main Nano keeps its configured private tools. The side-chat runtime owns delivery and sends replies only to the invoking chat.
- Outbound checks cover credentials, private contact details, saved contact names, internal setup details, sexual content, insults, and claims or commitments on the owner's behalf. They apply to replies to everyone because those replies come from the owner's account. Keep credentials and verification codes out of saved memory.

## Inbound

1. The owner's first eligible message containing the word `nano` adds that chat to the allowlist and triggers a reply. In allowlisted chats, the same case-insensitive word match applies to people and other bots. Match locally and skip Nano's own posts.
2. Deduplicate by source message ID. Use context to identify likely verification codes, and preserve the invocation and ask when trimming long text. Build the reply context from this chat alone.
3. When catching up after a sync outage, skip reply requests more than one hour old, measured from the original message timestamp.

### Follow-ups

Use the same trigger for follow-ups, such as `What about Friday, Nano?`. Include Nano's earlier replies and intervening messages from the same chat so the next response can resolve what the person means. Inline iMessage replies use the same word match.

## Outbound proposal

1. Give Jev the draft, triggering message, and relevant context from that chat. Start by stopping the draft when Jev returns `block` with probability at or above 0.80. Any other valid verdict permits sending. Tune the cutoff over time by reviewing false blocks and missed violations. If Jev is still unavailable after retries, send “I can’t answer right now. Try again in a bit.” in the source chat.
2. Give a draft with a fixable violation one rewrite and check it again. If the final outcome is a policy decline, post a short decline in the source chat and privately tell the owner why, regardless of who invoked Nano. Log the reason category without message bodies. Alert the owner privately when sync or delivery is stuck.
3. Track delivery per chat with bounded retries. If a send's outcome is unknown, check Messages history before retrying.

## Reply controls

- The owner can say `Nano, stop responding in this chat` to remove the chat from the allowlist. Handle the stop command before the general mention rule. Removal stops automatic replies and memory capture and cancels replies that have yet to send. A later eligible mention from the owner can enable the chat again.
- Store allowlist changes in persistent runtime state and apply them immediately, without a code change, deployment, or restart.
- The owner can pause or resume replies per chat, either from that chat or privately through main Nano. In-chat commands such as `Nano, pause replies` and `Nano, resume replies` work even while replies are paused.
- Pausing stops new replies and cancels queued replies that have yet to send. Memory capture continues. Resuming applies to new messages.

## Migration

- Seed the live allowlist from the existing allowlist and preserve any disabled chats, per-chat pauses, and global reply settings. Deployment must preserve which chats can currently receive replies.
