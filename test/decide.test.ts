import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildQuestion, confident, createDecider, decide, DecisionError, decisionLogPath, decisionTransport, type DecisionRequest, LOG_MAX_BYTES, top, type Transport } from "../src/decide.ts";
import { logGate } from "../src/gate.ts";
import { logRoute } from "../src/router.ts";

const request: DecisionRequest = {
	state: "NAV Fund Services: we have received your updated ACH instructions.",
	questions: { confirmed: { type: "choice", instructions: "Has NAV confirmed ACH is on file?", criteria: { yes: "Confirmed", no: "Not confirmed" } } },
};
const reply = (body: object, status = 200): Transport => async () => ({ status, text: JSON.stringify(body) });

test("decide returns typed answers and logs probabilities but never the state", async () => {
	const log = join(mkdtempSync(join(tmpdir(), "nano-decide-")), "decisions.jsonl");
	let sent: unknown;
	const answer = { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.95, no: 0.05 } };
	const response = await decide(request, {
		logPath: log,
		source: "test",
		transport: async (body) => {
			sent = JSON.parse(body);
			return { status: 200, text: JSON.stringify({ model: "fixture/decision-model", answers: { confirmed: answer }, usage: { input_tokens: 40, output_tokens: 0 } }) };
		},
	});
	assert.deepEqual(sent, { state: request.state, questions: request.questions });
	assert.deepEqual(top(response.answers.confirmed!), { label: "yes", p: 0.95 });
	const line = readFileSync(log, "utf8");
	assert.ok(!line.includes("ACH instructions") && !line.includes("Has NAV"), "the log holds no state or question text");
	const entry = JSON.parse(line);
	assert.equal(entry.source, "test");
	assert.equal(entry.state.chars, (request.state as string).length);
	assert.deepEqual(entry.answers.confirmed.probabilities, { yes: 0.95, no: 0.05 });
});

test("decide rejects bad requests, failed calls and answers outside the options", async () => {
	await assert.rejects(decide({ state: " ", questions: request.questions }, { transport: reply({}) }), /needs state/);
	await assert.rejects(decide({ state: "x", questions: {} }, { transport: reply({}) }), /at least one question/);
	await assert.rejects(
		decide({ state: "x", questions: { c: { type: "choice", instructions: "?", criteria: { only: "one" } } } }, { transport: reply({}) }),
		/at least two options/,
	);
	await assert.rejects(decide(request, { transport: reply({ error: "no" }, 402) }), /HTTP 402/);
	await assert.rejects(decide(request, { transport: reply({ model: "m", answers: { confirmed: { type: "noul", noul: 1 } } }) }), /no choice answer/);
	await assert.rejects(decide(request, { transport: reply({ model: "m", answers: { confirmed: { type: "choice", choice: "maybe" } } }) }), /not one of its options/);
});

test("top reads yes/no, choice and score answers", () => {
	assert.deepEqual(top({ type: "noul", noul: 0.8 }), { label: "yes", p: 0.8 });
	assert.equal(top({ type: "noul", noul: 0.25 }).label, "no");
	assert.equal(top({ type: "noul", noul: 0.25 }).p, 0.75);
	assert.deepEqual(top({ type: "score", score: 1.7, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } }), { label: "2", p: 0.8 });
});

test("command-line options become one question", () => {
	assert.deepEqual(buildQuestion("Is it?", {}), { type: "noul", instructions: "Is it?" });
	assert.deepEqual(buildQuestion("Is it?", { yes: "It is", no: "It is not" }), { type: "noul", instructions: "Is it?", criteria: { true: "It is", false: "It is not" } });
	assert.deepEqual(buildQuestion("Which?", { option: ["a=First", "b"] }), { type: "choice", instructions: "Which?", criteria: { a: "First", b: "b" } });
	assert.deepEqual(buildQuestion("How urgent?", { level: ["Later", "Now"] }), { type: "score", instructions: "How urgent?", criteria: ["Later", "Now"] });
	assert.throws(() => buildQuestion("?", { option: ["a"], level: ["b"] }), /not both/);
});

async function sentBy(transport: Transport | undefined) {
	assert.ok(transport);
	const original = globalThis.fetch;
	let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		await transport(JSON.stringify(request));
	} finally {
		globalThis.fetch = original;
	}
	assert.ok(seen);
	return seen;
}
const ZDR = { zdr: true, data_collection: "deny" };

test("without the vault or a decision URL, decisions go to OpenRouter with the default model and ZDR required", async () => {
	assert.equal(decisionTransport({}), undefined);
	const seen = await sentBy(decisionTransport({ OPENROUTER_API_KEY: "fixture-key" }));
	assert.equal(seen.url, "https://openrouter.ai/api/v1/systemone");
	assert.equal(seen.headers.authorization, "Bearer fixture-key");
	assert.deepEqual(seen.body, { model: "typesafe/jev-1.14", ...request, provider: ZDR });
	const chosen = await sentBy(decisionTransport({ OPENROUTER_API_KEY: "fixture-key", NANO_DECIDE_MODEL: "typesafe/jev-1.13" }));
	assert.equal(chosen.body.model, "typesafe/jev-1.13");
});

test("a decision URL sends the configured model without OpenRouter's routing field, and needs no key", async () => {
	const env = { NANO_DECIDE_URL: "http://127.0.0.1:30000/v1/systemone", NANO_DECIDE_MODEL: "fixture/clef-flash", OPENROUTER_API_KEY: "fixture-key" };
	const local = await sentBy(decisionTransport(env));
	assert.equal(local.url, "http://127.0.0.1:30000/v1/systemone");
	assert.equal(local.headers.authorization, undefined, "the OpenRouter key never goes to another endpoint");
	assert.deepEqual(local.body, { model: "fixture/clef-flash", ...request });
	const keyed = await sentBy(decisionTransport({ ...env, NANO_DECIDE_API_KEY: "fixture-decide-key" }));
	assert.equal(keyed.headers.authorization, "Bearer fixture-decide-key");
	assert.equal(decisionTransport({ NANO_DECIDE_URL: env.NANO_DECIDE_URL, OPENROUTER_API_KEY: "fixture-key" }), undefined, "a custom endpoint has no default model");
});

test("an OpenRouter decision URL still requires ZDR", async () => {
	const seen = await sentBy(
		decisionTransport({ NANO_DECIDE_URL: "https://openrouter.ai/api/v1/systemone", NANO_DECIDE_MODEL: "fixture/decider", OPENROUTER_API_KEY: "fixture-key" }),
	);
	assert.equal(seen.headers.authorization, "Bearer fixture-key");
	assert.deepEqual(seen.body, { model: "fixture/decider", ...request, provider: ZDR });
});

test("nano-decide exits 2 when no decision model is configured and 64 without a question", () => {
	const env = { PATH: process.env.PATH, NANO_DATA_DIR: mkdtempSync(join(tmpdir(), "nano-decide-cli-")) };
	const cli = join(import.meta.dirname, "..", "src", "decide-cli.ts");
	const unconfigured = spawnSync(process.execPath, [cli, "Is it?"], { env, input: "some text", encoding: "utf8" });
	assert.equal(unconfigured.status, 2, unconfigured.stderr);
	assert.match(unconfigured.stderr, /no decision model is configured/);
	assert.equal(spawnSync(process.execPath, [cli], { env, input: "", encoding: "utf8" }).status, 64);
});

function decisionError(expected: DecisionError["reason"], pattern?: RegExp) {
	return (error: unknown) => {
		assert.ok(error instanceof DecisionError);
		assert.equal(error.reason, expected);
		if (pattern) assert.match(error.message, pattern);
		return true;
	};
}

test("decide reports each failure reason from what it observed", async () => {
	await assert.rejects(decide(request, { transport: undefined }), decisionError("unconfigured", /no decision model is configured/));
	await assert.rejects(decide(request, { transport: reply({ error: "down" }, 503) }), decisionError("transient", /HTTP 503/));
	await assert.rejects(decide(request, { transport: reply({ error: "slow" }, 429) }), decisionError("transient", /HTTP 429/));
	const net = new TypeError("fetch failed", { cause: Object.assign(new Error(""), { code: "ENETUNREACH" }) });
	await assert.rejects(decide(request, { transport: async () => { throw net; } }), decisionError("transient", /ENETUNREACH/));
	await assert.rejects(
		decide(request, { transport: async () => { throw new Error("The provider service is unavailable"); } }),
		decisionError("transient", /unavailable/),
	);
	await assert.rejects(
		decide(request, {
			transport: async () => {
				throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
			},
		}),
		decisionError("transient"),
	);
	await assert.rejects(decide(request, { transport: reply({ error: "no" }, 402) }), decisionError("invalid", /HTTP 402/));
	await assert.rejects(decide(request, { transport: async () => ({ status: 200, text: "not json" }) }), decisionError("invalid", /not JSON/));
	await assert.rejects(decide(request, { transport: reply({ model: "m", answers: { confirmed: { type: "noul", noul: 1 } } }) }), decisionError("invalid", /no choice answer/));
	await assert.rejects(
		decide(request, { transport: reply({ model: "m", answers: { confirmed: { type: "choice", choice: "maybe" } } }) }),
		decisionError("invalid", /not one of its options/),
	);

	const dataDir = mkdtempSync(join(tmpdir(), "nano-decider-"));
	let calls = 0;
	const decider = createDecider({
		dataDir,
		refusePrivate: true,
		transport: async () => {
			calls++;
			return { status: 200, text: JSON.stringify({ model: "m", answers: { confirmed: { type: "choice", choice: "yes", probabilities: { yes: 1 } } } }) };
		},
	});
	await assert.rejects(decider.decide(request, { private: true }), decisionError("private"));
	assert.equal(calls, 0, "private input is refused before any request");
	await decider.decide(request, { source: "unit" });
	assert.equal(calls, 1);
	assert.match(readFileSync(decisionLogPath(dataDir), "utf8"), /"source":"unit"/);
});

test("confident takes a number or a per-label minimum", () => {
	const yes = { type: "choice" as const, choice: "yes", probabilities: { yes: 0.8, no: 0.2 } };
	assert.equal(confident(yes, 0.8), "yes");
	assert.equal(confident(yes, 0.81), undefined);
	assert.equal(confident(undefined, 0.5), undefined);
	const owner = { type: "choice" as const, choice: "owner", probabilities: { owner: 0.85, fixable: 0.15 } };
	assert.equal(confident(owner, { owner: 0.9, fixable: 0.8 }), undefined);
	assert.equal(confident({ type: "choice", choice: "fixable", probabilities: { owner: 0.15, fixable: 0.85 } }, { owner: 0.9, fixable: 0.8 }), "fixable");
	assert.equal(confident(owner, { fixable: 0.5 }), undefined);
});

test("router and gate logs rotate at the same cap as the decisions log", () => {
	assert.equal(LOG_MAX_BYTES, 5 * 1024 * 1024);
	const dir = mkdtempSync(join(tmpdir(), "nano-logs-"));
	for (const [name, write] of [
		["router.jsonl", (path: string) => logRoute(path, { n: 1 })],
		["gate.jsonl", (path: string) => logGate(path, { n: 1 })],
	] as const) {
		const path = join(dir, name);
		writeFileSync(path, "x".repeat(LOG_MAX_BYTES + 1));
		write(path);
		assert.equal(readFileSync(`${path}.1`, "utf8").length, LOG_MAX_BYTES + 1);
		const fresh = readFileSync(path, "utf8");
		assert.match(fresh, /"n":1/);
		assert.ok(fresh.length < 500);
	}
	const small = join(dir, "small.jsonl");
	logRoute(small, { n: 1 });
	logRoute(small, { n: 2 });
	assert.equal(existsSync(`${small}.1`), false);
	assert.equal(readFileSync(small, "utf8").trim().split("\n").length, 2);
});
