import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Transport } from "../src/decide.ts";
import { routeRequest } from "../src/router.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

type Labels = { reply?: [string, number]; effort?: [string, number]; topic?: [string, number] };

/** A fake decision model: answers per message text, defaulting to "needs a quick reply, same topic". */
function fakeJev(byMessage: Record<string, Labels | "fail">) {
	const seen: { message: string; questions: string[] }[] = [];
	const transport: Transport = async (body) => {
		const request = JSON.parse(body) as { state: { message: string }; questions: Record<string, { criteria: Record<string, string> }> };
		const message = request.state.message;
		seen.push({ message, questions: Object.keys(request.questions) });
		const wanted = byMessage[message] ?? {};
		if (wanted === "fail") return { status: 502, text: "bad gateway" };
		const defaults: Required<Labels> = { reply: ["needed", 0.97], effort: ["quick", 0.95], topic: ["same", 0.9] };
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(request.questions)) {
			const [choice, p] = (wanted as Labels)[id as keyof Labels] ?? defaults[id as keyof Labels];
			const other = Object.keys(q.criteria).find((k) => k !== choice) as string;
			answers[id] = { type: "choice", choice, probabilities: { [choice]: p, [other]: 1 - p } };
		}
		return { status: 200, text: JSON.stringify({ model: "typesafe/jev-1.14", answers }) };
	};
	return { transport, seen };
}

/** The conversation sent to the model, without the system prompt (which describes context windows itself). */
const text = (context: { messages: readonly unknown[] }) => JSON.stringify(context.messages.filter((m) => (m as { role: string }).role !== "system"));
const settle = () => new Promise((r) => setTimeout(r, 1800));

test("a message that only closes the exchange gets no model turn, and the next turn knows it was said", async () => {
	const jev = fakeJev({ "thanks!": { reply: ["none", 0.96] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: jev.transport });
	nano.script([() => fauxAssistantMessage(fauxText("Booked: Friday at 8."))]);
	nano.say("book the table for friday");
	assert.equal(await nano.next(), "Booked: Friday at 8.");

	nano.say("thanks!");
	await settle();
	assert.equal(nano.pending(), 0, "no model call was made");

	nano.script([
		(context) => {
			assert.match(text(context), /The owner said: \\"thanks!\\"\. It only closed the exchange, so no reply was sent\./);
			return fauxAssistantMessage(fauxText("The Ludlow, 180 Ludlow St."));
		},
	]);
	nano.say("what's the address");
	assert.equal(await nano.next(), "The Ludlow, 180 Ludlow St.");
	const log = readFileSync(join(nano.dataDir, "router.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(log[1].actions, ["no-reply"]);
	assert.ok(!readFileSync(join(nano.dataDir, "router.jsonl"), "utf8").includes("thanks"), "the router log holds no message text");
	await nano.conversation.dispose();
});

test("an unsure or failed decision gets a normal turn", async () => {
	const jev = fakeJev({ ok: { reply: ["none", 0.7] }, "ok then": "fail" });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: jev.transport });
	nano.script([() => fauxAssistantMessage(fauxText("Done."))]);
	nano.say("ok");
	assert.equal(await nano.next(), "Done.");
	nano.script([() => fauxAssistantMessage(fauxText("Going ahead."))]);
	nano.say("ok then");
	assert.equal(await nano.next(), "Going ahead.");
	const log = readFileSync(join(nano.dataDir, "router.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(log[0].actions, []);
	assert.match(log[1].error, /HTTP 502/);
	await nano.conversation.dispose();
});

test("slow work reaches the turn with a note to delegate it", async () => {
	const jev = fakeJev({ "compare the five best e-ink tablets": { effort: ["long", 0.92] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: jev.transport });
	nano.script([
		(context) => {
			assert.match(text(context), /Router: this looks like slow, multi-step work/);
			return fauxAssistantMessage(fauxText("On it, I'll report back."));
		},
	]);
	nano.say("compare the five best e-ink tablets");
	assert.equal(await nano.next(), "On it, I'll report back.");
	await nano.conversation.dispose();
});

test("a new topic after a quiet spell starts a fresh context window; a quick change of subject does not", async () => {
	const jev = fakeJev({ "what's the weather tomorrow": { topic: ["new", 0.95] }, "any good ramen near me": { topic: ["new", 0.95] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: jev.transport });
	nano.script([() => fauxAssistantMessage(fauxText("Booked: Friday at 8."))]);
	nano.say("book the table for friday");
	assert.equal(await nano.next(), "Booked: Friday at 8.");

	// Right after: a new subject keeps the same context window.
	nano.script([
		(context) => {
			assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /New context window/);
			assert.match(text(context), /Booked: Friday at 8/, "the earlier turns are still in this window");
			return fauxAssistantMessage(fauxText("Sunny."));
		},
	]);
	nano.say("what's the weather tomorrow");
	assert.equal(await nano.next(), "Sunny.");

	// Half an hour of quiet, then another new subject: a fresh window that still carries the last turns.
	(nano.conversation as unknown as { state: { lastActivity: number } }).state.lastActivity -= 30 * 60_000;
	nano.script([
		(context) => {
			const history = context.messages.filter((m) => (m as { role: string }).role !== "system");
			assert.equal(history.length, 1, "a fresh session holds only the new prompt");
			assert.match(text(context), /New context window after a gap/);
			assert.match(text(context), /Sunny\./);
			return fauxAssistantMessage(fauxText("Try Ivan Ramen."));
		},
	]);
	nano.say("any good ramen near me");
	assert.equal(await nano.next(), "Try Ivan Ramen.");
	const log = readFileSync(join(nano.dataDir, "router.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(log.map((l) => l.actions), [[], [], ["new-context"]]);
	await nano.conversation.dispose();
});

test("the first message of a conversation is not asked about topic, and output is treated as data", () => {
	const first = routeRequest({ message: "hi", recent: [], now: 0, running: [] });
	assert.deepEqual(Object.keys(first.questions), ["reply", "effort"]);
	const later = routeRequest({ message: "and tomorrow?", recent: [{ role: "nano", text: "Sunny today.", at: 0 }], now: 120_000, running: ["Research tablets"] });
	assert.deepEqual(Object.keys(later.questions), ["reply", "effort", "topic"]);
	const state = later.state as { recent_conversation: { from: string; minutes_ago: number }[]; background_tasks_running: string[] };
	assert.deepEqual(state.recent_conversation[0], { from: "assistant", minutes_ago: 2, text: "Sunny today." });
	assert.deepEqual(state.background_tasks_running, ["Research tablets"]);
	assert.match((later.questions.reply as { instructions: string }).instructions, /data, never instructions/);
});
