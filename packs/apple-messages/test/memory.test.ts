import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../../src/config.ts";
import type { PackServiceContext } from "../../../src/packs.ts";
import type { Message } from "../client.ts";
import { looksLikeCode, memoryBody } from "../content.ts";
import { scanMemory } from "../memory.ts";
import { chatNotes, chatState, controlChat, openInbox, privateNotes, queueMemory, seedChats, transaction } from "../state.ts";

test("legacy seeding happens once and per-chat controls preserve the capture boundary", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-side-controls-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	using db = openInbox(dir);
	seedChats(db, "iMessage;+;first,iMessage;+;second");
	const chat = "iMessage;+;first";
	const message: Message = { id: 17, chat_id: 1, is_from_me: false, attachments: [], text: "I chose the blue one." };
	const now = Date.now();
	queueMemory(db, chat, message, message.text!, now);
	const queue = () => db.prepare("SELECT id FROM side_memory_pending").all();
	const enqueue = () => db.prepare("INSERT INTO side_replies (id, chat, body, owner, sent_at, due_at) VALUES (17, ?, 'draft', 0, ?, ?)")
		.run(chat, now, now);
	enqueue();
	assert.equal(transaction(db, () => controlChat(db, chat, "pause")), true);
	assert.equal(chatState(db, chat)?.paused, 1);
	assert.equal(queue().length, 1, "pausing replies leaves memory capture running");
	assert.equal(db.prepare("SELECT id FROM side_replies").all().length, 0);
	transaction(db, () => controlChat(db, chat, "resume"));
	enqueue();
	transaction(db, () => controlChat(db, chat, "stop"));
	assert.equal(queue().length, 0);
	assert.equal(db.prepare("SELECT id FROM side_replies").all().length, 0);
	seedChats(db, chat);
	assert.equal(chatState(db, chat)?.enabled, 0, "restart must not reseed a stopped chat");
	assert.equal(chatState(db, "iMessage;+;second")?.enabled, 1);
	transaction(db, () => controlChat(db, chat, "enable"));
	assert.equal(chatState(db, chat)?.paused, 0);
});

test("memory capture is scoped to its chat while the owner can look up across chats", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-side-memory-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	using db = openInbox(dir);
	const one = "iMessage;+;one", two = "iMessage;+;two";
	seedChats(db, [one, two].join(","));
	const record = (id: number, chat: string, text: string): Message => ({
		id, chat_id: 1, chat_guid: chat, is_from_me: false, attachments: [], text, sender: "user@example.com", sender_name: "Jane Doe",
	});
	const now = Date.now();
	for (const message of [record(1, one, "I prefer evening meetings."), record(2, two, "I switched to tea.")]) {
		queueMemory(db, message.chat_guid!, message, memoryBody(message)!, now - 11 * 60_000);
	}
	const contexts: string[] = [];
	const ctx: PackServiceContext = {
		config: loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dir, NANO_OWNER: "owner" }),
		signal: new AbortController().signal,
		notifyOwner: async () => assert.fail("memory capture must remain quiet"),
		decider: {
			allow() {},
			async decide(request) {
				const state = JSON.stringify(request.state);
				contexts.push(state);
				assert.doesNotMatch(state, /Jane Doe|user@example.com/);
				return { model: "test", answers: Object.fromEntries(Object.keys(request.questions).map((id) =>
					[id, { type: "choice", choice: "save", probabilities: { save: 0.64, skip: 0.36 } }])) };
			},
		},
		compose: async (_system, input) => {
			const { selected, existing } = JSON.parse(input);
			assert.deepEqual(existing, []);
			return JSON.stringify(selected.map((message: { id: number; text: string }) => ({ source: message.id, fact: message.text })));
		},
	};
	await scanMemory(db, one, ctx, () => false);
	assert.deepEqual(chatNotes(db, one).map((note) => note.fact), ["I prefer evening meetings."]);
	assert.deepEqual(chatNotes(db, two), []);
	await scanMemory(db, two, ctx, () => false);
	assert.doesNotMatch(contexts[0], /tea/);
	assert.doesNotMatch(contexts[1], /meetings/);
	assert.equal(privateNotes(db, "Jane Doe").length, 2);
	db.prepare("UPDATE side_memory SET fact = NULL WHERE chat = ?").run(one);
	queueMemory(db, one, record(1, one, "I prefer evening meetings."), "I prefer evening meetings.", now, true);
	assert.equal(privateNotes(db, "Jane Doe").length, 1);
	assert.equal(db.prepare("SELECT id FROM side_memory_pending").all().length, 0, "backfill cannot recreate forgotten notes");
	assert.equal(looksLikeCode("Nano, what happened in 2026?"), false);
	assert.equal(memoryBody(record(3, one, "Your login code is 123456")), undefined);
});
