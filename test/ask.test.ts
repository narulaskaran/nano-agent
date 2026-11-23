import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { ask, type ChatFn, fitInput, matchChoice } from "../src/ask.ts";
import { mainOnOpenRouter, privateRefusal } from "../src/models.ts";
import { assertPrivateAllowed } from "../src/tools.ts";

const on = (modelProvider: string, mainCatalogProvider?: string) => ({ modelProvider, mainCatalogProvider }) as Config;

test("private work needs the main model on OpenRouter, directly or through a vault connection", () => {
	assert.equal(mainOnOpenRouter(on("openrouter")), true);
	assert.equal(mainOnOpenRouter(on("nano-vault-main", "openrouter")), true);
	assert.equal(mainOnOpenRouter(on("nano-vault-main", "deepseek")), false);
	assert.equal(mainOnOpenRouter(on("nano-vault-main")), false);
	assert.equal(mainOnOpenRouter(on("deepseek")), false);
	assert.equal(privateRefusal(on("openrouter")), undefined);
	assert.match(privateRefusal(on("deepseek")) ?? "", /zero data retention/);
});

test("private work is refused up front when zero data retention cannot be required", () => {
	assert.throws(() => assertPrivateAllowed(on("deepseek"), true), /was not run/);
	assert.doesNotThrow(() => assertPrivateAllowed(on("openrouter"), true));
	assert.doesNotThrow(() => assertPrivateAllowed(on("deepseek"), false));
});

test("choice answers are matched leniently but never guessed", () => {
	const labels = ["bill", "newsletter", "personal"];
	assert.equal(matchChoice("Bill", labels), "bill");
	assert.equal(matchChoice('"newsletter".', labels), "newsletter");
	assert.equal(matchChoice("<think>maybe a bill</think>personal", labels), "personal");
	assert.equal(matchChoice("This looks like a newsletter.", labels), "newsletter");
	assert.equal(matchChoice("bill or newsletter", labels), undefined);
	assert.equal(matchChoice("spam", labels), undefined);
});

test("long input is cut to fit the context window", () => {
	assert.equal(fitInput("short", 8192), "short");
	const cut = fitInput("x".repeat(100_000), 8192);
	assert.ok(cut.length < 25_000);
	assert.match(cut, /input cut at/);
});

function scripted(replies: { status: number; text: string }[]): { chat: ChatFn; calls: { constrained: boolean; user: string }[] } {
	const calls: { constrained: boolean; user: string }[] = [];
	const chat: ChatFn = async (messages, extra) => {
		calls.push({ constrained: Boolean(extra.response_format), user: messages.at(-1)?.content ?? "" });
		return replies.shift() ?? { status: 500, text: "no more replies" };
	};
	return { chat, calls };
}

test("choices use constrained output when the endpoint supports it", async () => {
	const { chat, calls } = scripted([{ status: 200, text: '"newsletter"' }]);
	assert.equal(await ask(chat, { instruction: "Sort", input: "Weekly digest", choices: ["bill", "newsletter"] }, 8192), "newsletter");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.constrained, true);
	assert.match(calls[0]?.user ?? "", /<input>\nWeekly digest\n<\/input>/);
});

test("without constrained output, an invalid answer is retried once and then rejected", async () => {
	const ok = scripted([
		{ status: 400, text: "response_format not supported" },
		{ status: 200, text: "probably spam" },
		{ status: 200, text: "bill" },
	]);
	assert.equal(await ask(ok.chat, { instruction: "Sort", choices: ["bill", "newsletter"] }, 8192), "bill");
	assert.deepEqual(
		ok.calls.map((c) => c.constrained),
		[true, false, false],
	);
	assert.match(ok.calls[2]?.user ?? "", /not one of the labels/);

	const bad = scripted([
		{ status: 400, text: "no" },
		{ status: 200, text: "spam" },
		{ status: 200, text: "still spam" },
	]);
	await assert.rejects(ask(bad.chat, { instruction: "Sort", choices: ["bill", "newsletter"] }, 8192), /did not answer with one of/);
});
