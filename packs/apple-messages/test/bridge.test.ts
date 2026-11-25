import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../../../src/config.ts";
import type { Decider, DecisionRequest } from "../../../src/decide.ts";
import type { PackServiceContext } from "../../../src/packs.ts";
import { ChatDenylist } from "../denylist.ts";
import appleMessages, { excludedChats, messageDecision } from "../service.ts";

type DecisionResponse = Awaited<ReturnType<Decider["decide"]>>;

const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const bridge = fileURLToPath(new URL("../mac/bridge.mjs", import.meta.url));
const exec = promisify(execFile);

/** Sets environment variables for one test and restores them afterwards. */
function withEnv(t: TestContext, vars: Record<string, string>): void {
	const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
	Object.assign(process.env, vars);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

/** Runs the watch service against a test data directory. Drafting fails unless the test supplies compose. */
function startService(dir: string, signal: AbortSignal, ctx: Pick<PackServiceContext, "decider" | "notifyOwner"> & Partial<Pick<PackServiceContext, "compose">>): Promise<void> {
	return appleMessages({
		config: loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dir, NANO_OWNER: "owner" }),
		signal,
		compose: async () => {
			throw new Error("drafting is off in this test");
		},
		...ctx,
	});
}

test("Messages watcher filters locally, checkpoints while the model is down and resumes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-watch-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const setup = {
		PATH: `${dir}:${process.env.PATH}`,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_APPLE_MESSAGES_WATCH: "on",
		NANO_APPLE_MESSAGES_REPLY: "off",
	};
	withEnv(t, setup);
	await writeFile(join(dir, "ssh"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).once("line", (line) => {
  const { start } = JSON.parse(line);
  const cursor = start?.cursor ?? 0;
  console.log(JSON.stringify({ kind: "ready", generation: "guest-1", cursor }));
  const emit = (id, text, overrides = {}) => console.log(JSON.stringify({ kind: "message", message: {
    id, chat_id: 1, chat_guid: "iMessage;+;chat123", sender: "user@example.com", is_from_me: false, attachments: [], text, ...overrides,
  }}));
  if (!cursor) {
    emit(1, "What a day");
    emit(2, "Nano, your OTP is 123 456");
    emit(3, "Nano, can you help?", { chat_guid: "iMessage;+;denied" });
    emit(4, "Nano, can you help?", { is_from_me: true });
    emit(5, "Nano, can you help?", { attachments: [{ mime_type: "audio/mp4" }] });
    emit(6, "Nano, please remind the owner about dinner", { attachments: [{ mime_type: "image/png", transfer_name: "private.png" }] });
    emit(7, "nanotech party");
    process.stdin.unref();
  } else if (cursor === 7) {
    emit(7, "Nano, this is a duplicate");
    emit(8, "Please ask NANO to tell the owner about our trip", { sender: "other@example.com", chat_guid: "iMessage;+;chat123" });
  }
});
`, { mode: 0o700 });
	using denylist = new ChatDenylist(dir);
	denylist.set("iMessage;+;denied", true);
	const calls: DecisionRequest[] = [];
	const notices: string[] = [];
	const abort = new AbortController();
	const service = startService(dir, abort.signal, {
		decider: {
			allow() {},
			async decide(request) {
				calls.push(request);
				if (calls.length === 1) throw new Error("temporarily offline");
				return { model: "test-model", answers: { action: { type: "choice", choice: "notify", confidence: 0.98 } } };
			},
		},
		notifyOwner: async (message) => void notices.push(message),
	});
	try {
		const deadline = Date.now() + 6000;
		while (notices.length < 2 && Date.now() < deadline) await sleep(25);
		assert.deepEqual(calls.map((request) => request.state), [
			{ message: "Nano, please remind the owner about dinner", has_attachments: true },
			{ message: "Nano, please remind the owner about dinner", has_attachments: true },
			{ message: "Please ask NANO to tell the owner about our trip", has_attachments: false },
		]);
		assert.match(notices[0], /message 6/);
		assert.match(notices[1], /message 8/);
		const db = new DatabaseSync(join(dir, "apple-messages", "inbox.sqlite"), { readOnly: true });
		try {
			assert.equal(db.prepare("SELECT cursor FROM stream").get()?.cursor, 8);
			assert.equal(db.prepare("SELECT received FROM stream").get()?.received, 7);
			assert.equal(db.prepare("SELECT count(*) AS n FROM pending").get()?.n, 0);
		} finally {
			db.close();
		}
	} finally {
		abort.abort();
		await service;
	}
});

test("read-only guest requests and original attachment download", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-read-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const library = join(dir, "Library", "Messages", "Attachments");
	await mkdir(library, { recursive: true });
	const original = Buffer.from([0, 10, 255, 17]);
	await writeFile(join(library, "photo.png"), original);
	await writeFile(join(dir, "outside"), "private");
	await symlink(join(dir, "outside"), join(library, "escape"));
	const db = new DatabaseSync(join(dir, "Library", "Messages", "chat.db"));
	db.exec("CREATE TABLE message (body TEXT); INSERT INTO message (rowid, body) VALUES (41, 'Old message');");
	db.close();
	await writeFile(join(dir, "imsg"), `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { join } = require("node:path");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const attachment = (file) => ({ transfer_name: file, mime_type: "image/png", original_path: join(process.env.HOME, "Library", "Messages", "Attachments", file) });
  const message = { id: 42, text: "Nano, look at this", attachments: params.attachments ? [attachment("photo.png"), attachment("escape")] : [] };
  if (method === "watch.subscribe") {
    if (params.since_rowid !== 41) process.exit(1);
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { subscription: 1 } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "message", params: { message } }));
    return;
  }
  const result = method === "chats.list" ? { chats: [{ id: 1 }] } : { messages: [message] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
});
`, { mode: 0o700 });
	await writeFile(join(dir, "ssh"), `#!/bin/sh
exec "$NANO_TEST_NODE" "$NANO_TEST_BRIDGE" "$HOME/imsg"
`, { mode: 0o700 });
	const env = {
		...process.env,
		HOME: dir,
		PATH: `${dir}:${process.env.PATH}`,
		NANO_CHANNEL: "stdin",
		NANO_DATA_DIR: dir,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_TEST_NODE: process.execPath,
		NANO_TEST_BRIDGE: bridge,
	};
	const run = async (...args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], { env })).stdout);
	assert.equal((await run("chats")).chats[0].id, 1);
	assert.equal((await run("search", "look")).messages[0].id, 42);
	assert.equal((await run("history", "1")).messages[0].attachments[0].transfer_name, "photo.png");
	assert.equal((await run("read", "42")).attachments[0].original_path, undefined);
	const file = await run("attachment", "42", "0");
	assert.match(file.path, /photo\.png$/);
	assert.deepEqual(await readFile(file.path), original);
	await assert.rejects(run("attachment", "42", "1"), /unavailable or incomplete/);
	const watcher = spawn(process.execPath, [bridge, join(dir, "imsg")], { env, stdio: ["pipe", "pipe", "ignore"] });
	const stopped = new Promise((resolve) => watcher.once("close", resolve));
	const lines = createInterface({ input: watcher.stdout });
	watcher.stdin.write('{"op":"watch"}\n');
	try {
		const events = [];
		for await (const line of lines) {
			events.push(JSON.parse(line));
			if (events.length === 2) break;
		}
		assert.equal(events[0]?.kind, "ready");
		assert.equal(events[0].cursor, 41);
		assert.equal(events[1]?.message.id, 42);
		assert.equal(events[1].message.attachments[0].original_path, undefined);
	} finally {
		watcher.stdin.end();
		await stopped;
	}
	const unauthorized = spawn(process.execPath, [bridge, join(dir, "imsg")], { env, stdio: ["pipe", "ignore", "ignore"] });
	unauthorized.stdin.end('{"op":"send"}\n');
	assert.equal(await new Promise((resolve) => unauthorized.once("close", resolve)), 1);
});

test("replies are drafted with only the web tools, checked by the decision model, and posted once", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-reply-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const setup = {
		PATH: `${dir}:${process.env.PATH}`,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_APPLE_MESSAGES_WATCH: "on",
		NANO_APPLE_MESSAGES_REPLY: "on",
		NANO_TEST_SENT: join(dir, "sent.jsonl"),
	};
	withEnv(t, setup);
	await writeFile(join(dir, "ssh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "send" && request.text.includes("delivery failure")) {
    console.error("Messages did not answer in time");
    process.exitCode = 1;
    return;
  }
  if (request.op === "send") return appendFileSync(process.env.NANO_TEST_SENT, line + "\\n");
  if (request.op === "chat") return console.log(JSON.stringify({ chat: { id: 7 } }));
  if (request.op === "history") return console.log(JSON.stringify({ messages: JSON.parse(process.env.NANO_TEST_HISTORY || "[]") }));
  console.log(JSON.stringify({ kind: "ready", generation: "guest-1", cursor: request.start?.cursor ?? 0 }));
  if (request.start) return;
  const emit = (id, text, is_from_me = false, chat_guid = "iMessage;+;chat123") => console.log(JSON.stringify({ kind: "message", message: {
    id, chat_id: 7, chat_guid, sender: "friend@example.com", is_from_me, attachments: [], text,
  }}));
  emit(1, "Nano, where does the owner live?");
  emit(2, "Nano, please share a link");
  emit(3, "Nano, say nothing");
  emit(4, "Nano, what can you do?", true);
  emit(5, "Nano, one more thing");
  emit(6, "Nano, deny during drafting", false, "iMessage;+;blocked-while-drafting");
  emit(7, "Nano, test delivery failure");
  process.stdin.unref();
});
`, { mode: 0o700 });
	const drafts: Record<string, string> = {
		"where does the owner live": "They live at 12 Main St",
		"share a link": "Sure: https://example.com " + "x".repeat(700),
		"say nothing": "NO_REPLY",
		"what can you do": "🤖 I can answer general questions here.",
		"one more thing": "",
		"test delivery failure": "Simulated delivery failure",
	};
	using denylist = new ChatDenylist(dir);
	const composed: string[] = [];
	const verdicts: unknown[] = [];
	const notices: string[] = [];
	const abort = new AbortController();
	const service = startService(dir, abort.signal, {
		decider: {
			allow() {},
			async decide(request): Promise<DecisionResponse> {
				if (request.questions.verdict) {
					verdicts.push(request.state);
					const block = /12 Main/.test(JSON.stringify(request.state));
					return { model: "test-model", answers: { verdict: { type: "choice", choice: block ? "block" : "send", confidence: 0.97 } } };
				}
				return { model: "test-model", answers: { action: { type: "choice", choice: "notify", confidence: 0.98 } } };
			},
		},
		compose: async (system, user, _signal, options) => {
			assert.match(system, /only tools are web_search and web_fetch, which read the public web, and read_chat/);
			assert.deepEqual(options?.tools?.map((tool) => tool.name), ["web_fetch", "read_chat"]);
			assert.doesNotMatch(user, /owner@|profile/);
			composed.push(user);
			if (user.includes("deny during drafting")) {
				denylist.set("iMessage;+;blocked-while-drafting", true);
				return "A draft that must never be sent";
			}
			return Object.entries(drafts).find(([key]) => user.includes(key))?.[1] ?? "NO_REPLY";
		},
		notifyOwner: async (message) => void notices.push(message),
	});
	try {
		const deadline = Date.now() + 8000;
		while (notices.length < 1 && Date.now() < deadline) await sleep(25);
		assert.equal(notices.length, 1);
		assert.match(notices[0], /could not send my reply .*message 7/);
		assert.equal(verdicts.length, 4);
		assert.equal(composed.length, 7);
		const sent = (await readFile(setup.NANO_TEST_SENT, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(sent.map((request) => request.text), [
			"🤖 I can’t answer that here.",
			"🤖 " + drafts["share a link"],
			"🤖 I can’t answer that here.",
			"🤖 I can answer general questions here.",
			"🤖 I can’t answer that here.",
		]);
		assert.ok(sent.every((request) => request.op === "send" && request.chat_guid === "iMessage;+;chat123"));
	} finally {
		abort.abort();
		await service;
	}
});

test("a mention in any chat that is not denied gets the same gated reply, and the denylist still excludes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-all-chats-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const setup = {
		PATH: `${dir}:${process.env.PATH}`,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_APPLE_MESSAGES_WATCH: "on",
		NANO_APPLE_MESSAGES_REPLY: "on",
		NANO_TEST_SENT: join(dir, "sent.jsonl"),
		// No chat allowlist: every chat not denied is watched.
		NANO_APPLE_MESSAGES_CHATS: "",
	};
	withEnv(t, setup);
	await writeFile(join(dir, "ssh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "send") return appendFileSync(process.env.NANO_TEST_SENT, line + "\\n");
  if (request.op === "chat") return console.log(JSON.stringify({ chat: { id: 7 } }));
  if (request.op === "history") return console.log(JSON.stringify({ messages: JSON.parse(process.env.NANO_TEST_HISTORY || "[]") }));
  console.log(JSON.stringify({ kind: "ready", generation: "guest-1", cursor: request.start?.cursor ?? 0 }));
  if (request.start) return;
  const emit = (id, chat_id, chat_guid) => console.log(JSON.stringify({ kind: "message", message: {
    id, chat_id, chat_guid, sender: "friend@example.com", is_from_me: false, attachments: [], text: "Nano, what is up?",
  }}));
  emit(1, 6, "iMessage;+;group-chat");
  emit(2, 24, "iMessage;-;+15550100");
  emit(3, 175, "iMessage;-;+15550101");
  emit(4, 90, "iMessage;+;another-group");
  emit(5, 91, "iMessage;-;friend@example.com");
  emit(6, 92, "iMessage;+;denied-group");
  emit(7, 93, "iMessage;-;+15550199");
  process.stdin.unref();
});
`, { mode: 0o700 });
	using denylist = new ChatDenylist(dir);
	denylist.set("iMessage;+;denied-group", true);
	denylist.set("iMessage;-;+15550199", true);
	const gated: unknown[] = [];
	const decided: string[] = [];
	const toolNames: string[][] = [];
	const abort = new AbortController();
	const service = appleMessages({
		// The Brave key is set, so both tools are offered: web_search and web_fetch are the whole allowlist.
		config: loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dir, NANO_OWNER: "owner", BRAVE_SEARCH_API_KEY: "test-key" }),
		signal: abort.signal,
		decider: {
			allow() {},
			async decide(request, options): Promise<DecisionResponse> {
				decided.push(String(options?.source));
				if (request.questions.verdict) {
					gated.push(request.state);
					return { model: "test-model", answers: { verdict: { type: "choice", choice: "send", confidence: 0.97 } } };
				}
				return { model: "test-model", answers: { action: { type: "choice", choice: "notify", confidence: 0.98 } } };
			},
		},
		compose: async (_system, _user, _signal, options) => {
			toolNames.push((options?.tools ?? []).map((tool) => tool.name));
			return "All good here.";
		},
		notifyOwner: async () => {},
	});
	try {
		const deadline = Date.now() + 8000;
		const sentPath = setup.NANO_TEST_SENT;
		const count = async () => existsSync(sentPath) ? (await readFile(sentPath, "utf8")).trim().split("\n").filter(Boolean).length : 0;
		while (await count() < 5 && Date.now() < deadline) await sleep(25);
		await sleep(300);
		const sent = (await readFile(sentPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(sent.map((request) => request.chat_guid), [
			"iMessage;+;group-chat",
			"iMessage;-;+15550100",
			"iMessage;-;+15550101",
			"iMessage;+;another-group",
			"iMessage;-;friend@example.com",
		]);
		assert.ok(sent.every((request) => request.op === "send" && request.text === "🤖 All good here."));
		// Every sent draft passed the approval gate, and no draft ever had more than the two web tools.
		assert.equal(gated.length, 5);
		assert.equal(decided.filter((source) => source === "apple-messages-reply").length, 5);
		assert.deepEqual(toolNames, Array.from({ length: 5 }, () => ["web_search", "web_fetch", "read_chat"]));
		// The denied chats got nothing: no decision, no draft, no send.
		assert.equal(decided.filter((source) => source === "apple-messages").length, 5);
	} finally {
		abort.abort();
		await service;
	}
});

test("the draft and the approval check both see the chat just before the mention, and the draft answers from it", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-context-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const mentionId = 200;
	const at = (minutesBefore: number) => new Date(Date.now() - 60_000 - minutesBefore * 60_000).toISOString();
	const line = (id: number, text: string, minutesBefore: number, extra: Record<string, unknown> = {}) =>
		({ id, chat_id: 7, chat_guid: "iMessage;+;chat123", sender: "+15550123", sender_name: "Sam", is_from_me: false, attachments: [], created_at: at(minutesBefore), text, ...extra });
	// Newest first, the way a history read may return it.
	const history = [
		line(203, "Nano, a later message that must not appear", -1),
		line(mentionId, "Nano which one should I try", 0),
		line(199, "Or codex", 1),
		line(198, "Do I try Claude for a month", 1),
		line(197, "Not sure what to do now", 2),
		line(196, "Both grok model usage and 3rd party", 2),
		line(195, "🤖 An earlier robot reply", 3),
		line(194, "Your verification code is 482913", 3),
		line(193, "I blasted through my $200 free cursor plan this month", 3, { sender_name: undefined, sender: "+15550123" }),
		line(192, "Sure, go ahead", 4, { is_from_me: true }),
		line(100, "A message from long ago", 120),
	];
	const setup = {
		PATH: `${dir}:${process.env.PATH}`,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_APPLE_MESSAGES_WATCH: "on",
		NANO_APPLE_MESSAGES_REPLY: "on",
		NANO_TEST_SENT: join(dir, "sent.jsonl"),
		NANO_TEST_HISTORY: JSON.stringify(history),
		NANO_TEST_MENTION: JSON.stringify(history.find((message) => message.id === mentionId)),
	};
	withEnv(t, setup);
	await writeFile(join(dir, "ssh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "send") return appendFileSync(process.env.NANO_TEST_SENT, line + "\\n");
  if (request.op === "chat") return console.log(JSON.stringify({ chat: { id: 7 } }));
  if (request.op === "history") {
    if (request.id !== 7) { console.error("wrong chat"); process.exitCode = 1; return; }
    return console.log(JSON.stringify({ messages: JSON.parse(process.env.NANO_TEST_HISTORY) }));
  }
  console.log(JSON.stringify({ kind: "ready", generation: "guest-1", cursor: request.start?.cursor ?? 0 }));
  if (request.start) return;
  console.log(JSON.stringify({ kind: "message", message: JSON.parse(process.env.NANO_TEST_MENTION) }));
  process.stdin.unref();
});
`, { mode: 0o700 });
	const prompts: { system: string; user: string }[] = [];
	const gated: Record<string, string>[] = [];
	const abort = new AbortController();
	const service = startService(dir, abort.signal, {
		decider: {
			allow() {},
			async decide(request): Promise<DecisionResponse> {
				if (request.questions.verdict) {
					gated.push(request.state as Record<string, string>);
					return { model: "test-model", answers: { verdict: { type: "choice", choice: "send", confidence: 0.97 } } };
				}
				return { model: "test-model", answers: { action: { type: "choice", choice: "notify", confidence: 0.98 } } };
			},
		},
		// Stands in for the model: it answers specifically only when the prompt carries the options and the situation.
		compose: async (system, user) => {
			prompts.push({ system, user });
			const known = /Claude/.test(user) && /codex/i.test(user) && /\$200 free cursor plan/.test(user);
			return known
				? "Since you've used up the $200 Cursor plan, I'd try Claude first, then Codex if it falls short."
				: "Happy to help you choose! What are the options?";
		},
		notifyOwner: async () => {},
	});
	try {
		const deadline = Date.now() + 8000;
		while (!existsSync(setup.NANO_TEST_SENT) && Date.now() < deadline) await sleep(25);
		await sleep(200);
		const sent = (await readFile(setup.NANO_TEST_SENT, "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
		assert.equal(sent.length, 1);
		assert.match(sent[0].text, /^🤖 /);
		assert.match(sent[0].text, /\$200 Cursor plan/);
		assert.match(sent[0].text, /Claude/);
		assert.match(sent[0].text, /Codex/);
		assert.doesNotMatch(sent[0].text, /what are the options/i);
		const expected = [
			"Sam (2 h before): A message from long ago",
			"Owner (4 min before): Sure, go ahead",
			"Someone (3 min before): I blasted through my $200 free cursor plan this month",
			"Sam (2 min before): Both grok model usage and 3rd party",
			"Sam (2 min before): Not sure what to do now",
			"Sam (just before): Do I try Claude for a month",
			"Sam (just before): Or codex",
		].join("\n");
		// The owner's turn is kept and labelled with its age, an unnamed sender shows as Someone, never their handle. Old messages stay (the latest few count, however old); robot replies, codes and later messages do not.
		assert.equal(prompts.length, 1);
		assert.ok(prompts[0].user.includes(expected), prompts[0].user);
		assert.ok(prompts[0].user.indexOf(expected) < prompts[0].user.indexOf("Nano which one should I try"));
		assert.doesNotMatch(prompts[0].user.split("Message that mentioned Nano")[0], /robot reply|482913|later message|which one should I try/);
		assert.doesNotMatch(prompts[0].user, /15550123/);
		assert.match(prompts[0].system, /only tools are web_search and web_fetch, which read the public web, and read_chat/);
		assert.match(prompts[0].system, /Never ask what the options are when they were named in the chat/);
		// The approval check gets exactly the same context.
		assert.equal(gated.length, 1);
		assert.equal(gated[0].recent_chat_context, expected);
		assert.equal(gated[0].incoming_message_from_a_third_party, "Nano which one should I try");
	} finally {
		abort.abort();
		await service;
	}
});

test("an unsure decision produces the fixed fallback", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-unsure-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const setup = {
		PATH: `${dir}:${process.env.PATH}`,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_APPLE_MESSAGES_WATCH: "on",
		NANO_APPLE_MESSAGES_REPLY: "on",
		NANO_TEST_SENT: join(dir, "sent.jsonl"),
	};
	withEnv(t, setup);
	await writeFile(join(dir, "ssh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "send") return appendFileSync(process.env.NANO_TEST_SENT, line + "\\n");
  if (request.op === "chat") return console.log(JSON.stringify({ chat: { id: 7 } }));
  if (request.op === "history") return console.log(JSON.stringify({ messages: JSON.parse(process.env.NANO_TEST_HISTORY || "[]") }));
  console.log(JSON.stringify({ kind: "ready", generation: "guest-1", cursor: request.start?.cursor ?? 0 }));
  if (request.start) return;
  console.log(JSON.stringify({ kind: "message", message: { id: 1, chat_id: 7, chat_guid: "iMessage;+;chat123", sender: "a@example.com", is_from_me: false, attachments: [], text: "Nano, hello" } }));
  process.stdin.unref();
});
`, { mode: 0o700 });
	const notices: string[] = [];
	const abort = new AbortController();
	const service = startService(dir, abort.signal, {
		decider: {
			allow() {},
			async decide(request): Promise<DecisionResponse> {
				return request.questions.verdict
					? { model: "test-model", answers: { verdict: { type: "choice", choice: "send", confidence: 0.6 } } }
					: { model: "test-model", answers: { action: { type: "choice", choice: "notify", confidence: 0.98 } } };
			},
		},
		compose: async () => "Hi there!",
		notifyOwner: async (message) => void notices.push(message),
	});
	try {
		const deadline = Date.now() + 5000;
		while (!existsSync(setup.NANO_TEST_SENT) && Date.now() < deadline) await sleep(25);
		const sent = JSON.parse(await readFile(setup.NANO_TEST_SENT, "utf8"));
		assert.equal(sent.text, "🤖 I can’t answer that here.");
		assert.deepEqual(notices, []);
	} finally {
		abort.abort();
		await service;
	}
});

test("the guest bridge forwards reply text and reports transport failure", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-guest-send-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "Library", "Messages"), { recursive: true });
	await mkdir(join(dir, ".local", "share", "nano-messages"), { recursive: true });
	await writeFile(join(dir, "imsg"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	// A stand-in for the send agent in the GUI session.
	const received: { chat_guid: string; text: string }[] = [];
	const agent = createServer((connection) => {
		connection.setEncoding("utf8");
		connection.once("data", (line) => {
			received.push(JSON.parse(String(line)));
			connection.end(JSON.stringify({ status: "sent" }) + "\n");
		});
	});
	const sendSocket = join(dir, ".local", "share", "nano-messages", "send.sock");
	await new Promise<void>((resolve) => agent.listen(sendSocket, resolve));
	t.after(() => agent.close());
	const env = { ...process.env, HOME: dir };
	let stderr = "";
	const send = async (request: object) => {
		const child = spawn(process.execPath, [bridge, join(dir, "imsg")], { env, stdio: ["pipe", "ignore", "pipe"] });
		stderr = "";
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.stdin.end(JSON.stringify({ op: "send", ...request }) + "\n");
		return new Promise<number | null>((resolve) => child.once("close", resolve));
	};
	const chat = { chat_id: 7, chat_guid: "iMessage;+;chat123" };
	const text = "x".repeat(9000);
	for (let i = 0; i < 7; i++) assert.equal(await send({ ...chat, text }), 0);
	assert.deepEqual(received, Array.from({ length: 7 }, () => ({ chat_guid: chat.chat_guid, text })));
	await new Promise((resolve) => agent.close(resolve));
	assert.equal(await send({ ...chat, text: "nobody home" }), 1);
	assert.match(stderr, /send agent is not running/);
});

test("the send agent passes through reply text and explains failures", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-agent-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const state = join(dir, ".local", "share", "nano-messages");
	await mkdir(state, { recursive: true });
	await writeFile(join(dir, "osascript"), `#!/bin/sh
printf '%s\\n' "$*" >> "$NANO_TEST_CALLS"
case "$*" in *denied*) echo "execution error: Not authorized to send Apple events to Messages. (-1743)" >&2; exit 1;; esac
`, { mode: 0o700 });
	const calls = join(dir, "calls.txt");
	const child = spawn(process.execPath, [join(bridge, "..", "send-agent.mjs"), join(dir, "osascript")], { env: { ...process.env, HOME: dir, NANO_TEST_CALLS: calls }, stdio: "ignore" });
	t.after(() => child.kill());
	const socket = join(state, "send.sock");
	for (let attempt = 0; attempt < 50 && !existsSync(socket); attempt++) await sleep(100);
	const ask = (request: object) => new Promise<{ status?: string; error?: string }>((resolve, reject) => {
		const connection = connect(socket);
		let output = "";
		connection.setEncoding("utf8");
		connection.on("error", reject);
		connection.on("data", (chunk) => (output += chunk));
		connection.on("close", () => resolve(JSON.parse(output)));
		connection.write(JSON.stringify(request) + "\n");
	});
	assert.deepEqual(await ask({ chat_guid: "iMessage;+;chat123", text: "🤖 hi there" }), { status: "sent" });
	assert.match(await readFile(calls, "utf8"), /-- 🤖 hi there iMessage;\+;chat123\n$/);
	assert.match((await ask({ chat_guid: "iMessage;+;chat123", text: "🤖 denied" })).error ?? "", /Click Allow on the guest console/);
	const longText = "x".repeat(9000);
	assert.deepEqual(await ask({ chat_guid: "iMessage;+;other", text: longText }), { status: "sent" });
	assert.ok((await readFile(calls, "utf8")).includes(longText));
	assert.equal(((await readFile(calls, "utf8")).match(/^-e /gm) ?? []).length, 3);
	// A ping asks Messages for its name and sends nothing.
	assert.deepEqual(await ask({ op: "ping" }), { status: "sent" });
	assert.match(await readFile(calls, "utf8"), /get name/);
});

test("a chat allowlist, when set, excludes every other chat, and the denylist still applies", () => {
	const denied = { has: (guid: string) => guid === "iMessage;+;both" };
	const chats = excludedChats(denied, " iMessage;-;+15550100 , iMessage;+;GROUP,iMessage;+;both");
	assert.equal(chats.has("iMessage;-;+15550100"), false);
	assert.equal(chats.has("iMessage;+;group"), false);
	assert.equal(chats.has("iMessage;+;both"), true);
	assert.equal(chats.has("iMessage;+;other"), true);
	const open = excludedChats(denied, "");
	assert.equal(open.has("iMessage;+;other"), false);
	assert.equal(open.has("iMessage;+;both"), true);
});

test("the owner's own mentions count only with replies on, never Nano's own replies, and stale messages are ignored", () => {
	const denied = (guid: string) => guid === "iMessage;+;denied";
	const message = { id: 1, chat_id: 1, chat_guid: "iMessage;+;chat123", sender: "me", is_from_me: true, attachments: [], text: "Nano, are you there?" };
	const now = Date.parse("2026-11-25T01:00:00Z");
	assert.equal(messageDecision(message, denied, false, now), undefined);
	assert.ok(messageDecision(message, denied, true, now));
	assert.equal(messageDecision({ ...message, text: "🤖 Nano here, hello" }, denied, true, now), undefined);
	assert.equal(messageDecision({ ...message, chat_guid: "iMessage;+;denied" }, denied, true, now), undefined);
	assert.ok(messageDecision({ ...message, chat_guid: "iMessage;+;other" }, denied, true, now));
	assert.ok(messageDecision({ ...message, is_from_me: false, created_at: "2026-11-25T00:50:00Z" }, denied, true, now));
	assert.equal(messageDecision({ ...message, is_from_me: false, created_at: "2026-11-25T00:30:00Z" }, denied, true, now), undefined);
});

test("the guest looks up chat metadata by ID and GUID", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-guest-allow-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "Library", "Messages"), { recursive: true });
	const db = new DatabaseSync(join(dir, "Library", "Messages", "chat.db"));
	db.exec("CREATE TABLE chat (guid TEXT, display_name TEXT, style INTEGER);");
	db.exec("INSERT INTO chat (rowid, guid, display_name, style) VALUES (7, 'iMessage;+;chat123', 'Friends', 43), (8, 'iMessage;-;+15550100', '', 45);");
	db.close();
	await writeFile(join(dir, "imsg"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	const run = (request: object) => new Promise<{ code: number | null; out: string }>((resolve) => {
		const child = spawn(process.execPath, [bridge, join(dir, "imsg")], { env: { ...process.env, HOME: dir }, stdio: ["pipe", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stdin.end(JSON.stringify(request) + "\n");
		child.once("close", (code) => resolve({ code, out }));
	});
	const chat = { id: 7, guid: "iMessage;+;chat123", name: "Friends", group: true };
	assert.deepEqual(JSON.parse((await run({ op: "chat", chat_id: 7 })).out).chat, chat);
	assert.deepEqual(JSON.parse((await run({ op: "chat", chat_guid: "imessage;+;chat123" })).out).chat, chat);
	assert.equal(JSON.parse((await run({ op: "chat", chat_id: 999 })).out).chat, null);
	assert.equal((await run({ op: "chat", chat_id: "7" })).code, 1);

});

test("the chat denylist starts empty and applies additions and removals across open connections", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-denied-chats-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	using watcher = new ChatDenylist(dir);
	using cli = new ChatDenylist(dir);
	assert.deepEqual(watcher.list(), []);
	cli.set("iMessage;+;NewChat", true);
	cli.set("IMESSAGE;+;NEWCHAT", true);
	assert.equal(watcher.has("iMessage;+;NewChat"), true);
	assert.deepEqual(watcher.list(), ["imessage;+;newchat"]);
	assert.equal(watcher.has("iMessage;+;OtherChat"), false);
	cli.set("iMessage;+;NewChat", false);
	assert.equal(watcher.has("iMessage;+;NewChat"), false);
});
