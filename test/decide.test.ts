import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildQuestion, decide, decisionTransport, type DecisionRequest, top, type Transport } from "../src/decide.ts";

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
