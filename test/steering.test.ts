import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { scriptedConversation, toolResults } from "./helpers/scripted-session.ts";

/** Longer than the 1.2 s burst window, so each say() is its own message. */
const APART_MS = 1500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Text of the user messages a model request was given, oldest first. */
const userTexts = (context: { messages: readonly unknown[] }): string =>
	context.messages
		.filter((m) => (m as { role?: string }).role === "user")
		.map((m) => JSON.stringify((m as { content: unknown }).content))
		.join("\n");

/** A model call that does not answer until the test releases it, like a reply still being written. */
function heldCall() {
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	return { held, release };
}

async function noMoreReplies(nano: { next: (ms?: number) => Promise<string> }) {
	await assert.rejects(nano.next(1500), /no reply/);
}

test("by default a text sent while the reply is being written cancels it, and one reply answers both", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const { held, release } = heldCall();
	const seen: string[] = [];
	nano.script([
		async (context) => {
			seen.push(userTexts(context));
			await held;
			return fauxAssistantMessage(fauxText("Booked for 7."));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Booked for 8, and the window seat."));
		},
	]);
	nano.say("book the table for 7");
	await wait(APART_MS);
	nano.say("actually 8, and ask for the window");
	await wait(APART_MS);
	release();
	assert.equal(await nano.next(), "Booked for 8, and the window seat.");
	await noMoreReplies(nano);
	assert.equal(seen.length, 2);
	assert.match(seen[1] ?? "", /book the table for 7[\s\S]*actually 8/, "the restart sees both texts, in order");
	assert.equal(nano.pending(), 0);
	await nano.conversation.dispose();
});

test("several texts while the reply is being written all land in the one restarted reply", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const { held, release } = heldCall();
	const seen: string[] = [];
	nano.script([
		async () => {
			await held;
			return fauxAssistantMessage(fauxText("never sent"));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("All three."));
		},
	]);
	nano.say("one");
	await wait(APART_MS);
	nano.say("two");
	await wait(APART_MS);
	nano.say("three");
	await wait(APART_MS);
	release();
	assert.equal(await nano.next(), "All three.");
	await noMoreReplies(nano);
	assert.equal(seen.length, 1);
	assert.match(seen[0] ?? "", /one[\s\S]*two[\s\S]*three/);
	await nano.conversation.dispose();
});

test("a text sent while a tool runs does not stop the tool; the next model call sees both", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const seen: { users: string; tools: string[] }[] = [];
	nano.script([
		() => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 3; echo tool-finished" })),
		(context) => {
			seen.push({ users: userTexts(context), tools: toolResults(context) });
			return fauxAssistantMessage(fauxText("Done, at 8."));
		},
	]);
	nano.say("book the table for 7");
	await wait(APART_MS);
	nano.say("actually make it 8");
	assert.equal(await nano.next(), "Done, at 8.");
	await noMoreReplies(nano);
	assert.equal(seen.length, 1);
	assert.match(seen[0]?.tools.join(" ") ?? "", /tool-finished/, "the tool ran to the end");
	assert.match(seen[0]?.users ?? "", /actually make it 8/);
	await nano.conversation.dispose();
});

test("a scheduled job is never cancelled by an owner text; the text is answered after it", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const { held, release } = heldCall();
	const seen: string[] = [];
	nano.script([
		async () => {
			await held;
			return fauxAssistantMessage(fauxText("Reminder: water the plants."));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Hi."));
		},
	]);
	const job = nano.conversation.inject("remind the owner to water the plants");
	await wait(300);
	nano.say("hey");
	await wait(APART_MS);
	release();
	assert.equal(await nano.next(), "Reminder: water the plants.");
	assert.equal(await nano.next(), "Hi.");
	await job;
	assert.match(seen[0] ?? "", /hey/);
	await nano.conversation.dispose();
});

test("NANO_INBOUND=steer: the text waits for the reply being written, then gets its own reply", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_INBOUND: "steer" } });
	const { held, release } = heldCall();
	const seen: string[] = [];
	nano.script([
		async () => {
			await held;
			return fauxAssistantMessage(fauxText("Booked for 7."));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Changed to 8."));
		},
	]);
	nano.say("book the table for 7");
	await wait(APART_MS);
	nano.say("actually make it 8");
	await wait(APART_MS);
	release();
	assert.equal(await nano.next(), "Booked for 7.");
	assert.equal(await nano.next(), "Changed to 8.");
	assert.match(seen[0] ?? "", /actually make it 8/);
	await nano.conversation.dispose();
});

test("NANO_INBOUND=queue: a text sent mid-turn waits and gets a turn of its own", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_INBOUND: "queue" } });
	const { held, release } = heldCall();
	const seen: string[] = [];
	nano.script([
		async (context) => {
			seen.push(userTexts(context));
			await held;
			return fauxAssistantMessage(fauxToolCall("bash", { command: "true" }));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Done."));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Second turn."));
		},
	]);
	nano.say("book the table for 7");
	await wait(APART_MS);
	nano.say("actually make it 8");
	await wait(APART_MS);
	release();
	assert.equal(await nano.next(), "Done.");
	assert.equal(await nano.next(), "Second turn.");
	assert.doesNotMatch(seen[1] ?? "", /actually make it 8/, "the first turn never saw the follow-up");
	assert.match(seen[2] ?? "", /actually make it 8/);
	await nano.conversation.dispose();
});

test("NANO_INBOUND rejects unknown values", () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-test-"));
	try {
		assert.throws(() => loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_INBOUND: "steering" }), /NANO_INBOUND must be/);
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
});

test("a reply cancelled while it streams is never sent, not even the part already written", async () => {
	const nano = await scriptedConversation({ packs: "core", tokensPerSecond: 20 });
	const long = `Booked for 7. ${"Here is everything about the restaurant. ".repeat(40)}`;
	nano.script([() => fauxAssistantMessage(fauxText(long)), () => fauxAssistantMessage(fauxText("8 it is."))]);
	nano.say("book the table for 7");
	await wait(APART_MS);
	nano.say("actually make it 8");
	assert.equal(await nano.next(), "8 it is.");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});

test("a text that arrives while the turn is still setting up its session joins the same prompt", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const seen: string[] = [];
	nano.script([
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Both noted."));
		},
	]);
	// Skip the burst window so the second text lands while the first turn is creating its session.
	const inner = nano.conversation as unknown as { pending: unknown[]; flushOwner: () => void };
	for (const text of ["good morning", "also, what's on today?"]) {
		inner.pending.push({ spaceId: "stdin", senderId: "stdin", messageId: text, text, files: [] });
		inner.flushOwner();
	}
	assert.equal(await nano.next(), "Both noted.");
	await noMoreReplies(nano);
	assert.equal(seen.length, 1);
	assert.match(seen[0] ?? "", /good morning[\s\S]*what's on today/);
	await nano.conversation.dispose();
});

test("NANO_INBOUND=queue: a text that arrives while the session is being set up still gets its own turn", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_INBOUND: "queue" } });
	nano.script([() => fauxAssistantMessage(fauxText("First.")), () => fauxAssistantMessage(fauxText("Second."))]);
	const inner = nano.conversation as unknown as { pending: unknown[]; flushOwner: () => void };
	for (const text of ["one", "two"]) {
		inner.pending.push({ spaceId: "stdin", senderId: "stdin", messageId: text, text, files: [] });
		inner.flushOwner();
	}
	assert.equal(await nano.next(), "First.");
	assert.equal(await nano.next(), "Second.");
	await nano.conversation.dispose();
});

test("a text sent while the model is still writing a tool call lets that tool run, then one reply covers both", async () => {
	// Slow streaming, so the second text lands while the tool call itself is being written.
	const nano = await scriptedConversation({ packs: "core", tokensPerSecond: 15 });
	const seen: { users: string; tools: string[] }[] = [];
	const padding = "x".repeat(200);
	nano.script([
		() => fauxAssistantMessage(fauxToolCall("bash", { command: `echo tool-ran # ${padding}` })),
		(context) => {
			seen.push({ users: userTexts(context), tools: toolResults(context) });
			return fauxAssistantMessage(fauxText("Done, at 8."));
		},
	]);
	nano.say("book the table for 7");
	await wait(APART_MS);
	nano.say("actually make it 8");
	assert.equal(await nano.next(), "Done, at 8.");
	await noMoreReplies(nano);
	assert.equal(seen.length, 1);
	assert.match(seen[0]?.tools.join(" ") ?? "", /tool-ran/, "the tool call was not cancelled");
	assert.match(seen[0]?.users ?? "", /table for 7[\s\S]*make it 8/);
	await nano.conversation.dispose();
});

test("a text sent while Pi waits to retry a failed model call cancels the retry; one reply answers both", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const seen: string[] = [];
	nano.script([
		() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 overloaded, please retry" }),
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("Booked for 8."));
		},
	]);
	nano.say("book for 7");
	assert.match(await nano.next(), /overloaded/, "the failed call is reported as before");
	// Straight in, without the burst window, so it surely lands while Pi waits to retry.
	const inner = nano.conversation as unknown as { pending: unknown[]; flushOwner: () => void };
	inner.pending.push({ spaceId: "stdin", senderId: "stdin", messageId: "m2", text: "actually 8", files: [] });
	inner.flushOwner();
	assert.equal(await nano.next(), "Booked for 8.");
	await noMoreReplies(nano);
	assert.equal(seen.length, 1, "the stale retry never reached the model");
	assert.match(seen[0] ?? "", /book for 7[\s\S]*actually 8/);
	await nano.conversation.dispose();
});

test("a text sent during a scheduled job is not steered into it; it gets its own turn right after", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const seen: string[] = [];
	nano.script([
		() => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 3" })),
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("[silent]"));
		},
		(context) => {
			seen.push(userTexts(context));
			return fauxAssistantMessage(fauxText("You're welcome."));
		},
	]);
	const job = nano.conversation.inject("check the delivery status; reply [silent] if nothing changed");
	await wait(300);
	nano.say("thanks for earlier");
	assert.equal(await nano.next(), "You're welcome.", "the owner's text is answered even though the job was [silent]");
	await job;
	assert.doesNotMatch(seen[0] ?? "", /thanks for earlier/, "the job never saw the owner's text");
	assert.match(seen[1] ?? "", /thanks for earlier/);
	await nano.conversation.dispose();
});

test("a silent system turn does not send progress text that accompanies a tool call", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		() => fauxAssistantMessage([fauxText("Checking the schedule first."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("[silent]")),
	]);
	await nano.conversation.inject("silent scheduled task");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});

test("a system turn skips tool-call progress text and still delivers its final reply", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		() => fauxAssistantMessage([fauxText("Checking the schedule first."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("Restored the job.")),
	]);
	await nano.conversation.inject("reporting scheduled task");
	assert.equal(await nano.next(), "Restored the job.");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});

test("a system turn with tool calls and intermediate text sends only the final answer", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		() => fauxAssistantMessage([fauxText("Checking the schedule first."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Comparing what came back."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("Nothing on the calendar.")),
	]);
	await nano.conversation.inject("what is on the calendar");
	assert.equal(await nano.next(), "Nothing on the calendar.");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});

test("a system turn whose final answer is [silent] sends nothing", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		() => fauxAssistantMessage([fauxText("Checking the schedule first."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Still looking."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("[silent]")),
	]);
	await nano.conversation.inject("silent scheduled task with several steps");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});

test("an owner turn still delivers progress text sent alongside a tool call", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		() => fauxAssistantMessage([fauxText("Checking that now."), fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("All set.")),
	]);
	nano.say("check my schedule");
	assert.equal(await nano.next(), "Checking that now.");
	assert.equal(await nano.next(), "All set.");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});

test("an owner turn does not send text attached to a delegate tool call", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		() =>
			fauxAssistantMessage(
				[fauxText("On it, looking into that now."), fauxToolCall("delegate", { title: "Research flights", instructions: "Compare flights to Lisbon." })],
				{ stopReason: "toolUse" },
			),
		() => fauxAssistantMessage(fauxText("On it — I'll check flights and report back.")),
	]);
	nano.say("compare flights to Lisbon");
	assert.equal(await nano.next(), "On it — I'll check flights and report back.");
	await noMoreReplies(nano);
	await nano.conversation.dispose();
});
