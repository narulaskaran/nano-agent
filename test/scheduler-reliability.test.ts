import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { handBackPrompt } from "../src/tasks.ts";
import { noDecisionModel } from "./helpers/no-decision-model.ts";
import { type BackgroundWork, cronMatches, isTransient, type JobSink, REPAIR_GRACE_MS, RETRY_MS, Scheduler } from "../src/scheduler.ts";

/** A scheduler on a temp directory with a sink whose sends can be made to fail. */
function setup() {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-scheduler-"));
	mkdirSync(join(dataDir, "workspace"));
	const sent: string[] = [];
	const repairs: BackgroundWork[] = [];
	const state = { failFor: (_text: string) => false, failRepair: false };
	const sink: JobSink = {
		send: async (_space, text) => {
			if (state.failFor(text)) throw new Error("channel down");
			sent.push(text);
		},
		task: async () => {},
		background: async (_space, work) => {
			if (work.repairOf && state.failRepair) throw new Error("no worker available");
			if (work.repairOf) repairs.push(work);
		},
	};
	const config = { dataDir, owner: "owner" } as Config;
	const scheduler = new Scheduler(config, sink, { decisionTransport: noDecisionModel });
	/** Wait for every job started by the last tick to finish. */
	const idle = async () => {
		const running = (scheduler as unknown as { running: Set<string> }).running;
		for (let i = 0; i < 500 && running.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(running.size, 0, "jobs still running");
	};
	const tick = async (at: number) => {
		await scheduler.tick(new Date(at));
		await idle();
	};
	return { dataDir, sent, repairs, state, scheduler, tick };
}

const REMINDER = { name: "dentist", kind: "message", body: "call the dentist", spaceId: "owner" } as const;
const MINUTE = Date.UTC(2026, 10, 14, 10, 0, 5);

test("a malformed cron field is rejected even when the minute does not match", () => {
	const at = new Date("2026-11-14T10:07:00Z");
	assert.throws(() => cronMatches("0 25 * * *", at, "UTC"), /bad cron field/);
	assert.throws(() => cronMatches("5,99 * * * *", new Date("2026-11-14T10:05:00Z"), "UTC"), /bad cron field/);
	assert.equal(cronMatches("7 10 * * *", at, "UTC"), true);
	const { scheduler } = setup();
	assert.throws(() => scheduler.add({ ...REMINDER, cron: "0 25 * * *" }), /bad cron field/);
	assert.equal(scheduler.list().length, 0);
});

test("a reminder whose send fails stays scheduled and is delivered once the channel recovers", async () => {
	const { sent, state, scheduler, tick } = setup();
	scheduler.add({ ...REMINDER, at: MINUTE });
	state.failFor = () => true;
	await tick(MINUTE);
	await tick(MINUTE + 60_000);
	assert.deepEqual(sent, []);
	assert.equal(scheduler.list().length, 1);

	state.failFor = () => false;
	await tick(MINUTE + 120_000);
	assert.deepEqual(sent, ["call the dentist"]);
	assert.equal(scheduler.list().length, 0);
	await tick(MINUTE + 180_000);
	assert.deepEqual(sent, ["call the dentist"], "delivered once, not again");
});

test("a reminder that cannot be sent for ten minutes is dropped and the owner is told what was missed", async () => {
	const { sent, state, scheduler, tick } = setup();
	scheduler.add({ ...REMINDER, at: MINUTE });
	state.failFor = (text) => text === REMINDER.body; // the notice itself still gets through
	await tick(MINUTE);
	assert.equal(scheduler.list().length, 1);
	await tick(MINUTE + RETRY_MS + 1_000);
	assert.equal(scheduler.list().length, 0);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /could not deliver a reminder.*call the dentist/);
});

test("a recurring job fires once per minute even though the scheduler ticks more often", async () => {
	const { sent, scheduler, tick } = setup();
	scheduler.add({ name: "ping", kind: "message", body: "ping", cron: "* * * * *", spaceId: "owner" });
	await tick(MINUTE);
	await tick(MINUTE + 20_000);
	await tick(MINUTE + 40_000);
	assert.equal(sent.length, 1);
	await tick(MINUTE + 60_000);
	assert.equal(sent.length, 2);
});

test("errors that usually clear on their own are told apart from real failures", () => {
	for (const e of ["timed out after 120s", "curl: (6) Could not resolve host", "getaddrinfo ENOTFOUND x", "HTTP 503 Service Unavailable", "429 Too Many Requests"]) {
		assert.equal(isTransient(e), true, e);
	}
	for (const e of ["Command failed: bash -c x: jq: error: Cannot index null", "No such file or directory", "401 Unauthorized"]) {
		assert.equal(isTransient(e), false, e);
	}
});

test("a failing script gets one repair first, then the owner is told once, then hears when it works again", async () => {
	const { dataDir, sent, repairs, scheduler, tick } = setup();
	const flag = join(dataDir, "workspace", "ok");
	const job = scheduler.add({ name: "price check", kind: "script", body: `test -f ${flag} || { echo "jq: error: Cannot index null" >&2; exit 1; }`, cron: "* * * * *", spaceId: "owner" });

	await tick(MINUTE);
	assert.equal(repairs.length, 1, "first real failure starts a repair");
	assert.match(repairs[0]?.instructions ?? "", /Cannot index null/);
	assert.deepEqual(sent, [], "the owner is not pulled in yet");

	await tick(MINUTE + 60_000);
	assert.equal(repairs.length, 1, "one repair per failure streak");
	assert.deepEqual(sent, [], "quiet while the repair has time to work");

	await tick(MINUTE + REPAIR_GRACE_MS + 60_000);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /"price check" keeps failing and I could not fix it/);
	await tick(MINUTE + REPAIR_GRACE_MS + 120_000);
	assert.equal(sent.length, 1, "told once per streak");
	assert.equal(scheduler.list().find((j) => j.id === job.id)?.health?.failures, 4);

	writeFileSync(flag, "");
	await tick(MINUTE + REPAIR_GRACE_MS + 180_000);
	assert.equal(sent.length, 2);
	assert.match(sent[1] ?? "", /"price check" is working again/);
	assert.equal(scheduler.list().find((j) => j.id === job.id)?.health?.failures, 0);
});

test("a transient failure waits for later runs before any repair", async () => {
	const { sent, repairs, scheduler, tick } = setup();
	scheduler.add({ name: "status", kind: "script", body: `echo "HTTP 503 Service Unavailable" >&2; exit 1`, cron: "* * * * *", spaceId: "owner" });
	await tick(MINUTE);
	await tick(MINUTE + 60_000);
	assert.equal(repairs.length, 0);
	await tick(MINUTE + 120_000); // third in a row: no longer treated as a blip
	assert.equal(repairs.length, 1);
	assert.deepEqual(sent, []);
});

test("a recovered job that the owner was never told about recovers silently", async () => {
	const { dataDir, sent, repairs, scheduler, tick } = setup();
	const flag = join(dataDir, "workspace", "ok");
	scheduler.add({ name: "feed", kind: "script", body: `test -f ${flag} || exit 1`, cron: "* * * * *", spaceId: "owner" });
	await tick(MINUTE);
	assert.equal(repairs.length, 1);
	writeFileSync(flag, ""); // the repair fixed it
	await tick(MINUTE + 60_000);
	assert.deepEqual(sent, [], "a successful repair stays silent");
});

test("a repair that fixed the job stays silent; one that could not reaches the owner", () => {
	const base = { id: "t1", title: 'Repair "feed"', instructions: "", role: "main", private: false, spaceId: "owner", source: "delegate", repairOf: "abc", createdAt: 0 } as const;
	assert.equal(handBackPrompt({ ...base, status: "done", result: "FIXED: the page moved, updated the URL" }), undefined);
	assert.match(handBackPrompt({ ...base, status: "done", result: "The feed now needs a login. Please sign in again." }) ?? "", /needs a login/);
	assert.match(handBackPrompt({ ...base, status: "failed", error: "worker crashed" }) ?? "", /failed: worker crashed/);
	assert.equal(handBackPrompt({ ...base, status: "failed", error: "The provider service is unavailable" }), undefined);
});

test("a failed background run of a scheduled task goes through the same policy", async () => {
	const { sent, repairs, scheduler } = setup();
	const job = scheduler.add({ name: "digest", kind: "task", body: "summarize", cron: "0 8 * * *", background: true, spaceId: "owner" });
	scheduler.taskEnded({ jobId: job.id, spaceId: "owner", title: "digest", status: "failed", error: "tool crashed" }, MINUTE);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(repairs.length, 1);
	assert.deepEqual(sent, []);
	scheduler.taskEnded({ jobId: job.id, spaceId: "owner", title: "digest", status: "done" }, MINUTE + 60_000);
	assert.equal(scheduler.list()[0]?.health?.failures, 0);
});

test("when a repair cannot be started, the owner is told right away", async () => {
	const { sent, state, scheduler, tick } = setup();
	state.failRepair = true;
	scheduler.add({ name: "broken", kind: "script", body: "exit 2", cron: "* * * * *", spaceId: "owner" });
	await tick(MINUTE);
	assert.equal(sent.length, 1);
	assert.match(sent[0] ?? "", /"broken" keeps failing:/);
});

test("an unreadable schedule file is set aside, not silently wiped", () => {
	const { dataDir } = setup();
	writeFileSync(join(dataDir, "schedule.json"), "{ not json");
	const scheduler = new Scheduler({ dataDir, owner: "owner" } as Config, { send: async () => {}, task: async () => {}, background: async () => {} }, { decisionTransport: noDecisionModel });
	assert.equal(scheduler.list().length, 0);
	assert.ok(readdirSync(dataDir).some((name) => name.startsWith("schedule.json.corrupt-")));
});

test("a script job's output goes out with the job's name on top", async () => {
	const { sent, scheduler, tick } = setup();
	scheduler.add({ name: "Weekly summary", kind: "script", then: "send", body: "echo Weight is steady.", cron: "* * * * *", spaceId: "owner" });
	await tick(MINUTE);
	assert.deepEqual(sent, ["Weekly summary:\nWeight is steady."]);
});
