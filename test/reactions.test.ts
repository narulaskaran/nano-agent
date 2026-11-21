import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gives the test channel a `react` that logs every tapback put on and taken off, in order. */
function recordReactions(nano: Awaited<ReturnType<typeof scriptedConversation>>): string[] {
	const log: string[] = [];
	nano.channel.react = async (_space, messageId, emoji) => {
		log.push(`+${emoji} ${messageId}`);
		return { remove: async () => void log.push(`-${emoji} ${messageId}`) };
	};
	return log;
}

test("NANO_REACTIONS is off unless set", () => {
	const reactions = (value?: string) => loadConfig({ NANO_CHANNEL: "stdin", NANO_REACTIONS: value }).reactions;
	assert.equal(reactions(), false);
	assert.equal(reactions("0"), false);
	assert.equal(reactions("1"), true);
	assert.equal(reactions(" On "), true);
});

test("by default Nano reacts to nothing", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const log = recordReactions(nano);
	nano.script([() => fauxAssistantMessage(fauxText("Hi."))]);
	nano.say("hello");
	assert.equal(await nano.next(), "Hi.");
	await wait(200);
	assert.deepEqual(log, []);
	await nano.conversation.dispose();
});

test("with reactions on, the owner's message gets 👀 while the turn runs and loses it with the reply", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_REACTIONS: "1" } });
	const log = recordReactions(nano);
	let during: string[] = [];
	nano.script([
		() => {
			during = [...log];
			return fauxAssistantMessage(fauxText("Hi."));
		},
	]);
	nano.say("hello");
	assert.equal(await nano.next(), "Hi.");
	await wait(200);
	const id = log[0]?.split(" ")[1];
	assert.match(id ?? "", /^m-/);
	assert.deepEqual(during, [`+👀 ${id}`], "on the message before the model is called");
	assert.deepEqual(log, [`+👀 ${id}`, `-👀 ${id}`], "gone once the turn is over, and no ‼️");
	await nano.conversation.dispose();
});

test("a turn that failed leaves ‼️ on the message", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_REACTIONS: "1" } });
	const log = recordReactions(nano);
	nano.script([() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid request" })]);
	nano.say("hello");
	assert.match(await nano.next(), /error talking to the model/);
	await wait(200);
	const id = log[0]?.split(" ")[1];
	assert.deepEqual(log, [`+👀 ${id}`, `-👀 ${id}`, `+‼️ ${id}`]);
	await nano.conversation.dispose();
});

test("a channel that cannot react, or whose reaction fails, does not disturb the turn", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_REACTIONS: "1" } });
	nano.channel.react = async () => {
		throw new Error("no tapbacks here");
	};
	nano.script([() => fauxAssistantMessage(fauxText("Still here."))]);
	nano.say("hello");
	assert.equal(await nano.next(), "Still here.");
	await nano.conversation.dispose();
});

test("a scheduled job has no owner message, so it reacts to nothing", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_REACTIONS: "1" } });
	const log = recordReactions(nano);
	nano.script([() => fauxAssistantMessage(fauxText("[silent]"))]);
	await nano.conversation.inject("check the thing");
	await wait(200);
	assert.deepEqual(log, []);
	await nano.conversation.dispose();
});

test("a text sent mid-turn cancels the first turn quietly; the newest message carries the 👀 to the reply", async () => {
	const nano = await scriptedConversation({ packs: "core", env: { NANO_REACTIONS: "1" } });
	const log = recordReactions(nano);
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	nano.script([
		async () => {
			await held;
			return fauxAssistantMessage(fauxText("never sent"));
		},
		() => fauxAssistantMessage(fauxText("Booked for 8.")),
	]);
	nano.say("book for 7");
	await wait(1500);
	nano.say("actually 8");
	await wait(1500);
	release();
	assert.equal(await nano.next(), "Booked for 8.");
	await wait(300);
	const [first, second] = [log[0]?.split(" ")[1], log.find((entry) => entry.startsWith("+") && !entry.endsWith(log[0]?.split(" ")[1] ?? ""))?.split(" ")[1]];
	assert.ok(first && second && first !== second, "two different messages were reacted to");
	assert.deepEqual(log.filter((entry) => entry.includes("‼️")), [], "a cancelled turn is not a failure");
	assert.deepEqual(log.filter((entry) => entry.endsWith(second)), [`+👀 ${second}`, `-👀 ${second}`]);
	assert.deepEqual(log.filter((entry) => entry.endsWith(first)), [`+👀 ${first}`, `-👀 ${first}`]);
	await nano.conversation.dispose();
});
