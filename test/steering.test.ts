import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { scriptedConversation } from "./helpers/scripted-session.ts";

const BURST_WAIT_MS = 1500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The owner's text in every user message of a model request. */
const userTexts = (context: { messages: readonly unknown[] }): string[] =>
	context.messages
		.filter((m) => (m as { role?: string }).role === "user")
		.map((m) => JSON.stringify((m as { content: unknown }).content));

async function midTurn(env?: Record<string, string>) {
	const nano = await scriptedConversation({ packs: "core", env });
	const requests: string[][] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	nano.script([
		// The model is still working on the first message when the second one arrives.
		async (context) => {
			requests.push(userTexts(context));
			await gate;
			return fauxAssistantMessage(fauxToolCall("bash", { command: "true" }));
		},
		(context) => {
			requests.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Done."));
		},
		(context) => {
			requests.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Second turn."));
		},
	]);
	nano.say("book the table for 7");
	await wait(BURST_WAIT_MS);
	nano.say("actually make it 8");
	await wait(BURST_WAIT_MS);
	release();
	return { nano, requests };
}

test("by default a message sent mid-turn steers the running turn instead of starting a second one", async () => {
	const { nano, requests } = await midTurn();
	assert.equal(await nano.next(), "Done.");
	await wait(300);
	assert.equal(requests.length, 2, "one turn: two model calls, no extra turn");
	assert.match(requests[1]?.join(" ") ?? "", /actually make it 8/, "the running turn saw the follow-up before its next model call");
	assert.equal(nano.pending(), 1, "the second turn's reply was never needed");
	await nano.conversation.dispose();
});

test("NANO_INBOUND=queue keeps the old behaviour: the follow-up waits and gets a turn of its own", async () => {
	const { nano, requests } = await midTurn({ NANO_INBOUND: "queue" });
	assert.equal(await nano.next(), "Done.");
	assert.equal(await nano.next(), "Second turn.");
	assert.equal(requests.length, 3, "two turns");
	assert.doesNotMatch(requests[1]?.join(" ") ?? "", /actually make it 8/, "the first turn never saw the follow-up");
	assert.match(requests[2]?.join(" ") ?? "", /actually make it 8/);
	await nano.conversation.dispose();
});
