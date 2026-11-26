import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createOutbound, isDefiniteSendFailure, isDuplicateSend, outboundKey, outboundRetry, RETRY_WINDOW_MS, sendIds } from "../src/outbound.ts";
import { createQueue, enqueueJob, type Job, openQueueDb } from "../src/queue.ts";

const tempDir = () => mkdtempSync(join(tmpdir(), "nano-queue-"));

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await sleep(10);
	}
}

test("the queue db is private, WAL, and shared by a second connection that only enqueues", async () => {
	const dir = tempDir();
	const db = openQueueDb(dir);
	assert.equal(statSync(join(dir, "nano.sqlite")).mode & 0o777, 0o600);
	assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
	const ran: string[] = [];
	const queue = createQueue<{ n: string }>({ db, table: "jobs", pollMs: 20, handler: async (job) => void ran.push(job.payload.n) });
	const stop = new AbortController();
	const running = queue.run(stop.signal);
	const other = openQueueDb(dir);
	assert.equal(enqueueJob(other, "jobs", { key: "k", payload: { n: "from another process" }, dedupe: "d1" }), true);
	assert.equal(enqueueJob(other, "jobs", { key: "k", payload: { n: "again" }, dedupe: "d1" }), false, "dedupe");
	other.close();
	await until(() => ran.length === 1);
	assert.deepEqual(ran, ["from another process"]);
	stop.abort();
	await running;
});

test("jobs run one at a time per key, in order, and across keys in parallel up to the cap", async () => {
	const db = new DatabaseSync(":memory:");
	const log: string[] = [];
	let inFlight = 0;
	let most = 0;
	const queue = createQueue<{ n: number }>({
		db, table: "jobs", concurrency: 2, pollMs: 20,
		handler: async (job) => {
			inFlight++;
			most = Math.max(most, inFlight);
			await sleep(20);
			log.push(`${job.key}${job.payload.n}`);
			inFlight--;
		},
	});
	for (const n of [1, 2, 3]) queue.enqueue({ key: "a", payload: { n } });
	for (const n of [1, 2]) queue.enqueue({ key: "b", payload: { n } });
	queue.enqueue({ key: "c", payload: { n: 1 } });
	const stop = new AbortController();
	const running = queue.run(stop.signal);
	await until(() => log.length === 6);
	stop.abort();
	await running;
	assert.equal(most, 2);
	assert.deepEqual(log.filter((x) => x.startsWith("a")), ["a1", "a2", "a3"]);
	assert.deepEqual(log.filter((x) => x.startsWith("b")), ["b1", "b2"]);
});

test("a later job waits behind an earlier one of its key that is not due yet; reschedule releases it", async () => {
	let now = 1_000_000;
	const db = new DatabaseSync(":memory:");
	const ran: number[] = [];
	const queue = createQueue<{ n: number }>({ db, table: "jobs", pollMs: 10, now: () => now, handler: async (job) => void ran.push(job.payload.n) });
	queue.enqueue({ key: "k", payload: { n: 1 }, dedupe: "held", dueAt: now + 60_000 });
	queue.enqueue({ key: "k", payload: { n: 2 } });
	queue.enqueue({ key: "other", payload: { n: 3 } });
	const stop = new AbortController();
	const running = queue.run(stop.signal);
	await until(() => ran.includes(3));
	await sleep(50);
	assert.deepEqual(ran, [3]);
	assert.equal(queue.reschedule("held"), true);
	await until(() => ran.length === 3);
	assert.deepEqual(ran, [3, 1, 2]);
	now += 1;
	stop.abort();
	await running;
});

test("failures back off, give up once, and finished jobs stay as tombstones so the dedupe key holds", async () => {
	const db = new DatabaseSync(":memory:");
	let calls = 0;
	const gaveUp: Job<unknown>[] = [];
	const queue = createQueue<{ n: number }>({
		db, table: "jobs", pollMs: 10,
		retry: (job) => (job.attempts >= 3 ? undefined : 5),
		handler: async () => {
			calls++;
			throw new Error("nope");
		},
		onGiveUp: (job) => void gaveUp.push(job),
	});
	queue.enqueue({ key: "k", payload: { n: 1 }, dedupe: "once" });
	const stop = new AbortController();
	const running = queue.run(stop.signal);
	await until(() => gaveUp.length === 1);
	stop.abort();
	await running;
	assert.equal(calls, 3);
	assert.equal(gaveUp[0]?.attempts, 3);
	const row = db.prepare("SELECT state, payload, error FROM jobs").get() as { state: string; payload: string | null; error: string };
	assert.deepEqual({ ...row }, { state: "failed", payload: null, error: "nope" });
	assert.equal(queue.enqueue({ key: "k", payload: { n: 2 }, dedupe: "once" }), false);
	assert.equal(queue.pending(), 0);
});

test("a hung handler times out and is retried; shutdown leaves an unfinished job for the restart", async () => {
	const db = new DatabaseSync(":memory:");
	let attempts = 0;
	const queue = createQueue<null>({
		db, table: "jobs", pollMs: 10, timeoutMs: 30, retry: () => 5,
		handler: async () => {
			attempts++;
			if (attempts === 1) await new Promise(() => {}); // never settles
		},
	});
	queue.enqueue({ key: "k", payload: null });
	const stop = new AbortController();
	const running = queue.run(stop.signal);
	await until(() => queue.pending() === 0);
	stop.abort();
	await running;
	assert.equal(attempts, 2);

	const slow = createQueue<null>({ db, table: "slow", pollMs: 10, handler: () => new Promise(() => {}) });
	slow.enqueue({ key: "k", payload: null });
	const stop2 = new AbortController();
	const running2 = slow.run(stop2.signal, 30);
	await sleep(40);
	stop2.abort();
	await running2;
	const row = db.prepare("SELECT state, attempts FROM slow").get() as { state: string; attempts: number };
	assert.deepEqual({ ...row }, { state: "pending", attempts: 0 }, "an abort at shutdown is not a failed attempt");
});

test("tx-free handlers: a handler's own writes are not rolled into another job", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE side (n INTEGER)");
	const queue = createQueue<{ n: number }>({
		db, table: "jobs", pollMs: 10,
		handler: async (job) => {
			await sleep(5);
			db.prepare("INSERT INTO side VALUES (?)").run(job.payload.n);
			if (job.payload.n === 2) throw new Error("fails after its write");
		},
		retry: () => undefined,
	});
	for (const n of [1, 2, 3]) queue.enqueue({ key: `k${n}`, payload: { n } });
	const stop = new AbortController();
	const running = queue.run(stop.signal);
	await until(() => queue.pending() === 0);
	stop.abort();
	await running;
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM side").get() as { n: number }).n, 3);
});

test("outbound keys, error classes and the retry window", () => {
	assert.equal(outboundKey("any;-;+15550100"), "+15550100");
	assert.equal(outboundKey("+15550100"), "+15550100");
	assert.equal(outboundKey("Owner@Example.com"), "owner@example.com");
	assert.equal(isDuplicateSend({ code: "duplicateMessage" }), true);
	assert.equal(isDuplicateSend(new Error("wrapped", { cause: { code: "duplicateMessage" } })), true);
	assert.equal(isDuplicateSend(Object.assign(new Error("[upstream] Operation already processed with this client message ID"), { code: "internalError" })), true, "the live server's answer");
	assert.equal(isDuplicateSend(Object.assign(new Error("[upstream] boom"), { code: "internalError" })), false);
	assert.equal(isDefiniteSendFailure(Object.assign(new Error("x"), { name: "NotFoundError" })), true);
	assert.equal(isDefiniteSendFailure(new Error("cannot resolve conversation abc")), true);
	assert.equal(isDefiniteSendFailure(Object.assign(new Error("deadline"), { code: "timeout" })), false);
	const job = (attempts: number, createdAt: number) => ({ id: 1, key: "k", dedupe: null, payload: null, attempts, createdAt, dueAt: 0 });
	assert.equal(outboundRetry(job(1, 0), new Error("net"), 0), 2000);
	assert.equal(outboundRetry(job(7, 0), new Error("net"), 0), 60_000);
	assert.equal(outboundRetry(job(3, 0), new Error("net"), RETRY_WINDOW_MS), undefined);
	assert.equal(outboundRetry(job(1, 0), { code: "chatNotFound" }, 0), undefined);
});

test("outbound sends once with a stable clientMessageId, treats duplicateMessage as delivered, and records after the send", async () => {
	const db = new DatabaseSync(":memory:");
	const ids: (string | undefined)[] = [];
	const sent: string[] = [];
	const recorded: string[] = [];
	let fail = 1;
	const outbound = createOutbound({
		db,
		channel: {
			async send(spaceId, text) {
				ids.push(sendIds.getStore()?.clientMessageId);
				if (fail-- > 0) throw Object.assign(new Error("deadline exceeded"), { code: "timeout" });
				if (text === "dup") throw Object.assign(new Error("duplicate"), { code: "duplicateMessage" });
				sent.push(`${spaceId}:${text}`);
			},
		},
		delivered: (_spaceId, text) => void recorded.push(text),
	});
	outbound.queue; // exposed for inspection
	outbound.send("+15550100", "hello", "reminder:1:2");
	outbound.send("+15550100", "hello", "reminder:1:2"); // a re-fire after a crash
	outbound.send("+15550100", "dup");
	const stop = new AbortController();
	const running = outbound.run(stop.signal);
	await until(() => recorded.length === 2, 8000);
	stop.abort();
	await running;
	assert.deepEqual(sent, ["+15550100:hello"]);
	assert.deepEqual(recorded, ["hello", "dup"], "a duplicateMessage answer counts as delivered");
	assert.equal(ids[0], ids[1], "the retry reuses the clientMessageId");
	assert.notEqual(ids[1], ids[2]);
	assert.match(ids[0] ?? "", /^nano-[a-z0-9]+-\d+$/);
});

test("outbound gives up at once on a definite failure and sends one notice, never a notice about the notice", async () => {
	const db = new DatabaseSync(":memory:");
	const attempts: string[] = [];
	const outbound = createOutbound({
		db,
		channel: {
			async send(_spaceId, text) {
				attempts.push(text);
				throw Object.assign(new Error("no chat"), { code: "chatNotFound" });
			},
		},
	});
	outbound.send("+15550100", "the reminder");
	const stop = new AbortController();
	const running = outbound.run(stop.signal);
	await until(() => attempts.length === 2);
	await sleep(100);
	stop.abort();
	await running;
	assert.deepEqual(attempts, ["the reminder", "I couldn't deliver a message earlier: the reminder"]);
	assert.equal(outbound.queue.pending(), 0);
});
