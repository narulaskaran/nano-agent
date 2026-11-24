import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { Transport } from "../src/decide.ts";
import { triageFailure } from "../src/triage.ts";
import { type BackgroundWork, Scheduler } from "../src/scheduler.ts";
import { testDecider } from "./helpers/no-decision-model.ts";

const MINUTE = Date.UTC(2026, 10, 14, 10, 0, 5);

/** A scheduler whose failure triage answers `kind` with probability `p` (or fails), running a script that fails with `error`. */
function setup(
	answer: { kind?: string; p?: number; status?: number; throwError?: Error },
	error: string,
	extra: { private?: boolean } = {},
) {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-triage-"));
	mkdirSync(join(dataDir, "workspace"));
	const sent: string[] = [];
	const repairs: BackgroundWork[] = [];
	let calls = 0;
	const transport: Transport = async () => {
		calls++;
		if (answer.throwError) throw answer.throwError;
		if (answer.status) return { status: answer.status, text: "error" };
		const p = answer.p ?? 0.95;
		const kind = answer.kind ?? "fixable";
		const rest = ["transient", "fixable", "owner"].filter((k) => k !== kind);
		return { status: 200, text: JSON.stringify({ model: "m", answers: { failure: { type: "choice", choice: kind, probabilities: { [kind]: p, [rest[0] as string]: (1 - p) / 2, [rest[1] as string]: (1 - p) / 2 } } } }) };
	};
	const scheduler = new Scheduler(
		{ dataDir, owner: "owner" } as Config,
		{ send: async (_s, text) => void sent.push(text), task: async () => {}, background: async (_s, work) => void (work.repairOf && repairs.push(work)) },
		{ decider: testDecider(dataDir, transport) },
	);
	const job = scheduler.add({ name: "Price watch", kind: "script", body: `echo '${error}' >&2; exit 1`, cron: "* * * * *", spaceId: "owner", ...(extra.private ? { private: true, then: "task", background: true } : {}) });
	const tick = async (at: number) => {
		await scheduler.tick(new Date(at));
		const running = (scheduler as unknown as { running: Set<string> }).running;
		for (let i = 0; i < 500 && running.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
	};
	return { sent, repairs, scheduler, job, tick, calls: () => calls };
}

test("a failure only the owner can fix reaches them at once, with no repair attempt", async () => {
	const { sent, repairs, scheduler, tick } = setup({ kind: "owner" }, "invalid_grant: Token has been expired or revoked");
	await tick(MINUTE);
	assert.equal(repairs.length, 0);
	assert.equal(sent.length, 1);
	assert.match(sent[0] as string, /"Price watch" is failing and needs you: .*invalid_grant/);
	await tick(MINUTE + 60_000);
	assert.equal(sent.length, 1, "told once");
	assert.equal(scheduler.list()[0]?.health?.escalated, true);
});

test("a failure the decision calls transient waits, even when the regex would not", async () => {
	const { sent, repairs, tick } = setup({ kind: "transient" }, "upstream gave an empty page, try later");
	await tick(MINUTE);
	assert.equal(repairs.length, 0);
	assert.deepEqual(sent, []);
});

test("a failure the decision calls fixable gets a repair, even when the regex calls it transient", async () => {
	const { repairs, tick } = setup({ kind: "fixable" }, "parse failed: timeout field missing in response");
	await tick(MINUTE);
	assert.equal(repairs.length, 1);
});

test("an unsure or non-transiently failed triage falls back to the regex", async () => {
	for (const answer of [{ kind: "owner", p: 0.5 }, { status: 401 }]) {
		const transient = setup(answer, "connection reset by peer");
		await transient.tick(MINUTE);
		assert.equal(transient.repairs.length, 0, "regex: transient waits");
		const real = setup(answer, "KeyError: price");
		await real.tick(MINUTE);
		assert.equal(real.repairs.length, 1, "regex: not transient, repaired");
		assert.deepEqual(real.sent, []);
	}
});

test("a transiently unavailable triage waits instead of starting a repair", async () => {
	const netError = new TypeError("fetch failed", { cause: Object.assign(new Error(""), { code: "ENETUNREACH" }) });
	const cases = [
		{ answer: { status: 502 }, error: "curl failed after 2 attempts: curl exit 7:" },
		{ answer: { throwError: new Error("The provider service is unavailable") }, error: "RuntimeError: vault fetch failed rc=1" },
		{ answer: { throwError: netError }, error: "curl failed after 2 attempts: curl exit 7:" },
	];
	for (const { answer, error } of cases) {
		const { sent, repairs, tick } = setup(answer, error);
		await tick(MINUTE);
		assert.equal(repairs.length, 0, "waits on first failure while triage is down");
		assert.deepEqual(sent, []);
		await tick(MINUTE + 60_000);
		assert.equal(repairs.length, 0, "waits on second failure while triage is down");
		await tick(MINUTE + 120_000);
		assert.equal(repairs.length, 1, "after TRANSIENT_RUNS, repairs as a lasting streak");
		assert.deepEqual(sent, []);
	}
});

test("only a near-certain owner verdict skips the repair", async () => {
	const unsure = setup({ kind: "owner", p: 0.85 }, "KeyError: price");
	await unsure.tick(MINUTE);
	assert.equal(unsure.repairs.length, 1, "0.85 is not enough to page the owner");
	assert.deepEqual(unsure.sent, []);
	assert.match(unsure.repairs[0]?.instructions as string, /rename it aside/);
	const sure = setup({ kind: "owner", p: 0.95 }, "invalid_grant: Token has been expired or revoked");
	await sure.tick(MINUTE);
	assert.equal(sure.repairs.length, 0);
	assert.equal(sure.sent.length, 1);
});

test("a transient decision error is triage's own transient result", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-triage-direct-"));
	const decider = testDecider(dataDir, async () => ({ status: 503, text: "down" }));
	const result = await triageFailure({ name: "Price watch", kind: "script", error: "KeyError: price", source: "triage:test", decider });
	assert.deepEqual(result, { kind: "transient" });
});

test("a private failure is not sent to the decision model and falls back to the regex", async () => {
	const skipped = setup({ kind: "owner" }, "KeyError: price", { private: true });
	await skipped.tick(MINUTE);
	assert.equal(skipped.calls(), 0, "private failures are not sent to the decision model");
	assert.equal(skipped.repairs.length, 1, "regex: not transient, repaired");
	const waiting = setup({ kind: "owner" }, "connection reset by peer", { private: true });
	await waiting.tick(MINUTE);
	assert.equal(waiting.calls(), 0);
	assert.equal(waiting.repairs.length, 0, "regex: transient waits");
});
