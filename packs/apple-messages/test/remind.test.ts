import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "../../../src/config.ts";
import { ownerReminders, type PackServiceContext } from "../../../src/packs.ts";
import { Scheduler } from "../../../src/scheduler.ts";
import { ChatDenylist } from "../denylist.ts";
import { REMINDER_HINT } from "../remind.ts";
import appleMessages from "../service.ts";

const NY = "America/New_York";
const CHAT = "iMessage;+;chat123";

test("only wording about reminding is read as a possible reminder request", () => {
	for (const text of ["Nano remind Sam to call", "Nano, set a reminder", "nano ping me at 5", "Nano don’t let me forget the tickets", "Nano REMINDERS please"]) {
		assert.match(text, REMINDER_HINT, text);
	}
	for (const text of ["Nano what is the weather", "Nano is the remainder zero?", "Nano grab me a ping pong table"]) {
		assert.doesNotMatch(text, REMINDER_HINT, text);
	}
});

test("the owner's side-chat reminder request becomes a private scheduler reminder; nobody else can set one", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "nano-messages-remind-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "settings.json"), JSON.stringify({ timezone: NY }));
	const request = "Nano remind Sam to book the table at 11am tomorrow";
	const messages: [text: string, fromMe: boolean][] = [
		[request, true],
		["Nano remind me at 11am tomorrow to wire money", false],
		["Nano remind me what we said about dinner", true],
		["Nano remind me to call", true],
		["Nano remind me yesterday to call", true],
		["Nano remind me every Monday at 9 to call", true],
		["Nano remind me about the garbled one", true],
		["Nano remind me about the impossible date", true],
		["Nano remind me, then withdraw", true],
	];
	const setup = {
		PATH: `${dir}:${process.env.PATH}`,
		NANO_APPLE_MESSAGES_SSH_CONFIG: join(dir, "unused"),
		NANO_APPLE_MESSAGES_WATCH: "on",
		NANO_APPLE_MESSAGES_REPLY: "on",
		NANO_APPLE_MESSAGES_CHATS: CHAT,
		NANO_APPLE_MESSAGES_WEB: "off",
		NANO_TEST_SENT: join(dir, "sent.jsonl"),
		NANO_TEST_MESSAGES: JSON.stringify(messages),
	};
	const previous = Object.fromEntries(Object.keys(setup).map((key) => [key, process.env[key]]));
	Object.assign(process.env, setup);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	await writeFile(join(dir, "ssh"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).once("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "send") return appendFileSync(process.env.NANO_TEST_SENT, line + "\\n");
  if (request.op === "chat") return console.log(JSON.stringify({ chat: { id: 7 } }));
  if (request.op === "history") return console.log(JSON.stringify({ messages: [] }));
  console.log(JSON.stringify({ kind: "ready", generation: "guest-1", cursor: request.start?.cursor ?? 0 }));
  if (request.start) return;
  JSON.parse(process.env.NANO_TEST_MESSAGES).forEach(([text, is_from_me], i) => console.log(JSON.stringify({ kind: "message", message: {
    id: i + 1, chat_id: 7, chat_guid: "${CHAT}", sender: "friend@example.com", is_from_me, attachments: [], text,
  }})));
  process.stdin.unref();
});
`, { mode: 0o700 });

	// Tomorrow's date on the owner's wall clock, as a model resolving "tomorrow" would write it.
	const day = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: NY }).format(Date.now() + offset * 86_400_000);
	const tomorrow = `${day(1)}T11:00`;
	const readings: [match: string, reading: string][] = [
		["book the table", "```json\n" + JSON.stringify({ kind: "set", at: tomorrow, task: "remind Sam to\nbook the table" }) + "\n```"],
		["what we said", JSON.stringify({ kind: "none" })],
		["remind me to call", JSON.stringify({ kind: "no_time" })],
		["yesterday", JSON.stringify({ kind: "set", at: `${day(-1)}T09:00`, task: "call" })],
		["every Monday", JSON.stringify({ kind: "repeat" })],
		["garbled", "Sure, I will!"],
		["impossible date", JSON.stringify({ kind: "set", at: "2027-02-30T09:00", task: "call" })],
		["withdraw", JSON.stringify({ kind: "set", at: tomorrow, task: "never saved" })],
	];

	const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dir, NANO_OWNER: "owner" });
	const delivered: { spaceId: string; text: string }[] = [];
	const decider: PackServiceContext["decider"] = {
		allow() {},
		async decide() {
			return { model: "test-model", answers: { verdict: { type: "choice", choice: "send", confidence: 0.97 } } };
		},
	};
	const scheduler = new Scheduler(config, {
		send: async (spaceId, text) => void delivered.push({ spaceId, text }),
		task: async () => assert.fail("a reminder never starts an agent turn"),
		background: async () => assert.fail("a reminder never starts a worker"),
	}, { decider });
	const remindOwner = ownerReminders(scheduler, config.owner);
	using denylist = new ChatDenylist(dir);
	const read: string[] = [];
	const drafted: string[] = [];
	const abort = new AbortController();
	const service = appleMessages({
		config,
		signal: abort.signal,
		decider,
		notifyOwner: async () => {},
		remindOwner,
		compose: async (system, user, _signal, options) => {
			if (/set a reminder/.test(system)) {
				assert.equal(options, undefined, "reading a request lends no tools");
				const input = JSON.parse(user);
				assert.equal(input.timezone, NY);
				read.push(input.message);
				if (input.message.includes("withdraw")) denylist.set(CHAT, true);
				const found = readings.find(([match]) => JSON.stringify(input).includes(match));
				assert.ok(found, input.message);
				return found[1];
			}
			drafted.push(JSON.parse(user).message);
			return "An ordinary reply.";
		},
	});
	try {
		const sentTexts = async () => (await readFile(setup.NANO_TEST_SENT, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).text as string);
		const deadline = Date.now() + 10_000;
		while ((read.length < 8 || (await sentTexts()).length < 8) && Date.now() < deadline) await sleep(25);
		await sleep(300);
		const sent = await sentTexts();

		assert.deepEqual(read, messages.filter(([, fromMe]) => fromMe).map(([text]) => text), "only the owner's requests are read as reminders");
		assert.deepEqual(drafted, [messages[1][0], messages[2][0]], "a participant and a non-reminder go to the ordinary draft");
		assert.match(sent[0], /^🤖 Reminder set for \w{3}, \w{3} \d{1,2}, \d{4}, 11:00\sAM\. It will arrive privately, so nothing will be posted here then\.$/u);
		assert.doesNotMatch(sent[0], /Sam/);
		assert.deepEqual(sent.slice(1), [
			"🤖 An ordinary reply.",
			"🤖 An ordinary reply.",
			"🤖 When should that reminder be? Send the whole request again with a day and time.",
			"🤖 That time has already passed. Send the whole request again with a later time.",
			"🤖 I can only set a one-time reminder here. Send it again with one day and time.",
			"🤖 I can’t answer right now. Try again in a bit.",
			"🤖 I can’t answer right now. Try again in a bit.",
		], "a request withdrawn while being read gets no reply");

		const jobs = scheduler.list();
		assert.equal(jobs.length, 1);
		const [job] = jobs;
		assert.equal(job.kind, "message");
		assert.equal(job.spaceId, "owner");
		assert.equal(job.name, "Messages reminder: remind Sam to book the table");
		assert.equal(job.body, `Reminder: remind Sam to book the table\nYou asked in Messages: “${request}” (message 1)`);
		assert.equal(new Intl.DateTimeFormat("sv-SE", { timeZone: NY, dateStyle: "short", timeStyle: "short" }).format(job.at), tomorrow.replace("T", " "));

		// The same request processed twice adds nothing, including after a restart.
		const again = { key: job.key!, name: "other", text: "other", at: job.at! + 60_000 };
		assert.deepEqual(remindOwner(again), { at: job.at });
		const restarted = new Scheduler(config, { send: async (spaceId, text) => void delivered.push({ spaceId, text }), task: async () => {}, background: async () => {} }, { decider });
		assert.deepEqual(ownerReminders(restarted, "owner")(again), { at: job.at });
		assert.equal(restarted.list().length, 1);

		// It fires once, at its time, into the owner's conversation.
		await restarted.tick(new Date(job.at! - 1000));
		assert.deepEqual(delivered, []);
		await restarted.tick(new Date(job.at! + 1000));
		await sleep(25);
		assert.deepEqual(delivered, [{ spaceId: "owner", text: job.body }]);
		assert.deepEqual(restarted.list(), []);
	} finally {
		abort.abort();
		await service;
	}
});
