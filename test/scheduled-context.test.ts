import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { labelScriptOutput } from "../src/scheduler.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

test("script output is labelled with the job's name unless it already starts with it", () => {
	assert.equal(labelScriptOutput("Weekly summary", "Weight is steady."), "Weekly summary:\nWeight is steady.");
	assert.equal(labelScriptOutput("Weekly summary", "Weekly summary: weight is steady."), "Weekly summary: weight is steady.");
	assert.equal(labelScriptOutput("  ", "hi"), "hi");
});

const DELIVERED = /Sent to the owner outside this conversation .*Weekly summary: Not enough weigh-ins this week/;

test("a scheduled send is recorded in the session history once, where it happened", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([() => fauxAssistantMessage(fauxText("Class is at 3:15."))]);
	nano.say("when is pilates");
	assert.equal(await nano.next(), "Class is at 3:15.");

	await nano.conversation.deliver("Weekly summary:\nNot enough weigh-ins this week.");
	assert.equal(await nano.next(), "Weekly summary:\nNot enough weigh-ins this week.");

	nano.script([
		(context) => {
			const history = JSON.stringify(context.messages);
			assert.match(history, DELIVERED);
			assert.equal(history.split("Sent to the owner outside").length - 1, 1, "recorded once");
			// It sits before the owner's question, not inside it.
			assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /Sent to the owner outside/);
			return fauxAssistantMessage(fauxText("That was the weekly summary job."));
		},
	]);
	nano.say("why did you send that?");
	assert.equal(await nano.next(), "That was the weekly summary job.");
	await nano.conversation.dispose();
});

test("a send made before the session exists reaches its first turn", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	await nano.conversation.deliver("Weekly summary:\nNot enough weigh-ins this week.");
	assert.equal(await nano.next(), "Weekly summary:\nNot enough weigh-ins this week.");
	nano.script([
		(context) => {
			// A fresh session carries it over with the turns before it; a resumed one gets it recorded.
			assert.match(JSON.stringify(context.messages), /Weekly summary: ?(\\n)?Not enough weigh-ins this week/);
			return fauxAssistantMessage(fauxText("From the weekly job."));
		},
	]);
	nano.say("what was that?");
	assert.equal(await nano.next(), "From the weekly job.");
	await nano.conversation.dispose();
});

test("after a restart, a send made before the session resumes is recorded in it", async () => {
	const first = await scriptedConversation({ packs: "core" });
	first.script([() => fauxAssistantMessage(fauxText("Class is at 3:15."))]);
	first.say("when is pilates");
	assert.equal(await first.next(), "Class is at 3:15.");
	await first.conversation.dispose();

	const nano = await scriptedConversation({ packs: "core", dataDir: first.dataDir });
	await nano.conversation.deliver("Weekly summary:\nNot enough weigh-ins this week.");
	assert.equal(await nano.next(), "Weekly summary:\nNot enough weigh-ins this week.");
	nano.script([
		(context) => {
			const history = JSON.stringify(context.messages);
			assert.match(history, /Class is at 3:15/, "the session was resumed");
			assert.match(history, DELIVERED);
			return fauxAssistantMessage(fauxText("From the weekly job."));
		},
	]);
	nano.say("what was that?");
	assert.equal(await nano.next(), "From the weekly job.");
	await nano.conversation.dispose();
});
