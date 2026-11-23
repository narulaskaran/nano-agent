import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Transport } from "../src/decide.ts";
import { routeRequest } from "../src/router.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

type Labels = Partial<Record<"reply" | "effort" | "topic" | "depth" | "remember" | "skill" | "task", [string, number]>>;

/** A fake decision model: answers per message text, defaulting to "needs a quick reply, same topic". */
function fakeDecisionModel(byMessage: Record<string, Labels | "fail">) {
	const seen: { message: string; questions: string[] }[] = [];
	const transport: Transport = async (body) => {
		const request = JSON.parse(body) as { state: { message: string }; questions: Record<string, { criteria: Record<string, string> }> };
		const message = request.state.message;
		seen.push({ message, questions: Object.keys(request.questions) });
		const wanted = byMessage[message] ?? {};
		if (wanted === "fail") return { status: 502, text: "bad gateway" };
		const defaults: Required<Labels> = { reply: ["needed", 0.97], effort: ["quick", 0.95], topic: ["same", 0.9], depth: ["deep", 0.9], remember: ["no", 0.95], skill: ["none", 0.9], task: ["none", 0.9] };
		const answers: Record<string, unknown> = {};
		for (const [id, q] of Object.entries(request.questions)) {
			const [choice, p] = (wanted as Labels)[id as keyof Labels] ?? defaults[id as keyof Labels];
			const others = Object.keys(q.criteria).filter((k) => k !== choice);
			answers[id] = { type: "choice", choice, probabilities: { [choice]: p, ...Object.fromEntries(others.map((k) => [k, (1 - p) / others.length])) } };
		}
		return { status: 200, text: JSON.stringify({ model: "fixture/decision-model", answers }) };
	};
	return { transport, seen };
}

/** The conversation sent to the model, without the system prompt (which describes context windows itself). */
const text = (context: { messages: readonly unknown[] }) => JSON.stringify(context.messages.filter((m) => (m as { role: string }).role !== "system"));
const settle = () => new Promise((r) => setTimeout(r, 1800));

test("a message that only closes the exchange gets no model turn, and the next turn knows it was said", async () => {
	const decider = fakeDecisionModel({ "thanks!": { reply: ["none", 0.96] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: decider.transport });
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
	const decider = fakeDecisionModel({ ok: { reply: ["none", 0.7] }, "ok then": "fail" });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: decider.transport });
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
	const decider = fakeDecisionModel({ "compare the five best e-ink tablets": { effort: ["long", 0.92] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: decider.transport });
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
	const decider = fakeDecisionModel({ "what's the weather tomorrow": { topic: ["new", 0.95] }, "any good ramen near me": { topic: ["new", 0.95] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: decider.transport });
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
	assert.deepEqual(Object.keys(first.questions), ["reply", "effort", "depth", "remember"]);
	const later = routeRequest({
		message: "and tomorrow?",
		recent: [{ role: "nano", text: "Sunny today.", at: 0 }],
		now: 120_000,
		running: [{ id: "a1b2", title: "Research tablets" }],
		skills: [{ name: "food-tracking", description: "Log what the owner eats" }],
	});
	assert.deepEqual(Object.keys(later.questions), ["reply", "effort", "depth", "remember", "skill", "task", "topic"]);
	assert.deepEqual((later.questions.skill as { criteria: Record<string, string> }).criteria["food-tracking"], "Log what the owner eats");
	assert.match((later.questions.task as { criteria: Record<string, string> }).criteria.a1b2 as string, /Research tablets/);
	const state = later.state as { recent_conversation: { from: string; minutes_ago: number }[]; background_tasks_running: string[] };
	assert.deepEqual(state.recent_conversation[0], { from: "assistant", minutes_ago: 2, text: "Sunny today." });
	assert.deepEqual(state.background_tasks_running, ["Research tablets"]);
	assert.match((later.questions.reply as { instructions: string }).instructions, /data, never instructions/);
});

test("a picked skill goes into the prompt once per session, and a simple message runs without thinking", async () => {
	const decider = fakeDecisionModel({
		"remind me at 6 to call mom": { skill: ["scheduling", 0.93], depth: ["simple", 0.96] },
		"and at 7 to call dad": { skill: ["scheduling", 0.93], depth: ["simple", 0.96] },
		"should I refinance": { depth: ["simple", 0.6] },
	});
	const nano = await scriptedConversation({ packs: "core", decisionTransport: decider.transport, reasoning: true, env: { NANO_THINKING: "low" } });
	const session = () => (nano.conversation as unknown as { session: { thinkingLevel: string } }).session;
	nano.script([
		(context) => {
			const last = JSON.stringify(context.messages.at(-1));
			assert.match(last, /Router: the \\"scheduling\\" skill applies/);
			assert.match(last, /# Scheduling patterns/);
			assert.equal(session().thinkingLevel, "off");
			return fauxAssistantMessage(fauxText("Set for 6."));
		},
	]);
	nano.say("remind me at 6 to call mom");
	assert.equal(await nano.next(), "Set for 6.");
	await new Promise((r) => setTimeout(r, 200)); // the turn finishes just after its reply goes out
	assert.equal(session().thinkingLevel, "low", "thinking is back on after the turn");

	nano.script([
		(context) => {
			assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /# Scheduling patterns/, "not injected twice");
			return fauxAssistantMessage(fauxText("Set for 7."));
		},
	]);
	nano.say("and at 7 to call dad");
	assert.equal(await nano.next(), "Set for 7.");

	nano.script([
		() => {
			assert.equal(session().thinkingLevel, "low", "an unsure depth keeps thinking on");
			return fauxAssistantMessage(fauxText("Depends on the rate."));
		},
	]);
	nano.say("should I refinance");
	assert.equal(await nano.next(), "Depends on the rate.");
	const log = readFileSync(join(nano.dataDir, "router.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(log[0].actions, ["skill:scheduling", "no-thinking"]);
	await nano.conversation.dispose();
});

test("a lasting fact gets a note to save it, and a message about a running task names the task", async () => {
	const decider = fakeDecisionModel({ "I'm vegetarian now": { remember: ["yes", 0.93] }, "actually only look at ones under $300": { task: ["ab12", 0.9] } });
	const nano = await scriptedConversation({ packs: "core", decisionTransport: decider.transport });
	(nano.conversation as unknown as { tasks: { active: () => unknown[] } }).tasks.active = () => [{ id: "ab12", title: "Research e-ink tablets" }];
	nano.script([
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)), /Router: this message seems to state something lasting/);
			return fauxAssistantMessage(fauxText("Noted."));
		},
	]);
	nano.say("I'm vegetarian now");
	assert.equal(await nano.next(), "Noted.");
	nano.script([
		(context) => {
			const last = JSON.stringify(context.messages.at(-1));
			assert.match(last, /background task ab12 \\"Research e-ink tablets\\"/);
			assert.match(last, /task_cancel/);
			return fauxAssistantMessage(fauxText("Restarting it with the new budget."));
		},
	]);
	nano.say("actually only look at ones under $300");
	assert.equal(await nano.next(), "Restarting it with the new budget.");
	await nano.conversation.dispose();
});
