import assert from "node:assert/strict";
import { test } from "node:test";
import type { InboundFile } from "../src/channel.ts";
import { normalize } from "./helpers/inbound.ts";
import { quiet } from "./helpers/quiet.ts";

/** What the Photon adapter delivers when the owner answers a bubble inline. */
function inlineReply(content: unknown, target: unknown) {
	return { type: "reply", content, target };
}

test("an inline reply to one of Nano's messages reaches the agent with the quoted bubble", async () => {
	const out = await normalize(
		inlineReply(
			{ type: "text", text: "Why did you do this?" },
			{ id: "t1", direction: "outbound", content: { type: "text", text: "Here is your weekly summary." } },
		),
	);
	assert.deepEqual(out.text, [
		'[Replying inline to your earlier message: "Here is your weekly summary."]',
		"Why did you do this?",
	]);
});

test("an inline reply still arrives when the quoted message cannot be loaded", async () => {
	const out = await normalize(
		inlineReply({ type: "text", text: "Did I ask for this" }, { id: "t1", content: { type: "custom", raw: { stub: true } } }),
	);
	assert.deepEqual(out.text, ["Did I ask for this"]);
});

test("a markdown bubble is quoted, flattened to one line and clipped", async () => {
	const out = await normalize(
		inlineReply(
			{ type: "text", text: "ok" },
			{ id: "t1", direction: "inbound", content: { type: "markdown", markdown: `**Plan**\n\n${"x".repeat(900)}` } },
		),
	);
	assert.match(out.text[0], /^\[Replying inline to an earlier message: "\*\*Plan\*\* x{591}…"\]$/);
	assert.equal(out.text[1], "ok");
});

test("an inline reply carrying a voice memo keeps the file", async () => {
	const file: InboundFile = { path: "/tmp/a.caf", name: "a.caf", mimeType: "audio/x-caf", kind: "voice" };
	const out = await normalize(
		inlineReply({ type: "voice", name: "a.caf" }, { id: "t1", direction: "outbound", content: { type: "text", text: "Logged it." } }),
		async () => file,
	);
	assert.deepEqual(out.files, [file]);
	assert.deepEqual(out.text, ['[Replying inline to your earlier message: "Logged it."]']);
});

test("a reply that wraps nothing readable is still dropped", async () => {
	assert.deepEqual(await normalize(inlineReply({ type: "read" }, { id: "t1", content: { type: "text", text: "hi" } })), {
		text: [],
		files: [],
	});
});

test("plain text and grouped messages are unchanged", async () => {
	assert.deepEqual((await normalize({ type: "text", text: "hello" })).text, ["hello"]);
	const group = { type: "group", items: [{ content: { type: "text", text: "a" } }, { type: "richlink", url: "https://example.com" }] };
	assert.deepEqual((await normalize(group)).text, ["a", "https://example.com"]);
});

const nanoSaid = (text: string) => ({ id: "t1", direction: "outbound", content: { type: "text", text } });

test("a ❓ or 👎 tapback on one of Nano's messages reaches the agent with that message", async () => {
	assert.deepEqual((await normalize({ type: "reaction", emoji: "❓", target: nanoSaid("Logged 3 cups.") })).text, [
		'[Reacted ❓ to your earlier message: "Logged 3 cups."]',
	]);
	assert.deepEqual((await normalize({ type: "reaction", emoji: "👎", target: nanoSaid("Class is at 3:15.") })).text, [
		'[Reacted 👎 to your earlier message: "Class is at 3:15."]',
	]);
});

test("acknowledging tapbacks, and tapbacks on the owner's own messages, start no turn", async () => {
	for (const emoji of ["👍", "❤️", "😂", "‼️", "🙏"]) {
		assert.deepEqual(await normalize({ type: "reaction", emoji, target: nanoSaid("Done.") }), { text: [], files: [] }, emoji);
	}
	const ownBubble = { id: "t2", direction: "inbound", content: { type: "text", text: "hm" } };
	assert.deepEqual(await normalize({ type: "reaction", emoji: "❓", target: ownBubble }), { text: [], files: [] });
});

test("a shared contact card arrives as its name, numbers and addresses", async () => {
	const out = await normalize({
		type: "contact",
		name: { first: "Sam", last: "Rivera" },
		org: { name: "Acme", title: "Dentist" },
		phones: [{ value: "+15550100", type: "mobile" }],
		emails: [{ value: "sam@example.com" }],
		addresses: [{ street: "1 Main St", city: "Springfield", type: "work" }],
	});
	assert.deepEqual(out.text, [
		[
			"[Shared a contact card: Sam Rivera]",
			"Work: Dentist, Acme",
			"Phone (mobile): +15550100",
			"Email: sam@example.com",
			"Address (work): 1 Main St, Springfield",
		].join("\n"),
	]);
});

test("an iMessage app card arrives as its caption and link", async () => {
	const out = await normalize({
		type: "app",
		url: async () => "https://example.com/r/123",
		layout: async () => ({ caption: "Dinner for 2", subcaption: "Fri 7:30 PM", summary: "Reservation confirmed" }),
	});
	assert.deepEqual(out.text, ["[Shared an iMessage app card: Dinner for 2 · Fri 7:30 PM]\nReservation confirmed\nhttps://example.com/r/123"]);
});

test("an app card whose details cannot be loaded still arrives", async () => {
	const out = await normalize({
		type: "app",
		url: async () => {
			throw new Error("offline");
		},
		layout: async () => {
			throw new Error("offline");
		},
	});
	assert.deepEqual(out.text, ["[Shared an iMessage app card]"]);
});

test("content Nano cannot read becomes a note instead of silence", async () => {
	const out = await quiet(() => normalize({ type: "custom", raw: { imessage_type: "unsupported-message" } }));
	assert.equal(out.text.length, 1);
	assert.match(out.text[0], /^\[Sent a message Nano cannot read here/);
	const unknown = await quiet(() => normalize({ type: "hologram" }));
	assert.deepEqual(unknown.text, ['[Sent a "hologram" message, which Nano cannot read yet]']);
});

test("an inline reply with a sticker still reaches the agent, quote included", async () => {
	const out = await quiet(() => normalize(inlineReply({ type: "custom", raw: {} }, nanoSaid("Want the 6 PM show?"))));
	assert.equal(out.text[0], '[Replying inline to your earlier message: "Want the 6 PM show?"]');
	assert.match(out.text[1], /^\[Sent a message Nano cannot read here/);
});

test("read receipts and typing indicators stay silent", async () => {
	assert.deepEqual(await normalize({ type: "read" }), { text: [], files: [] });
	assert.deepEqual(await normalize({ type: "typing" }), { text: [], files: [] });
});

test("a reply quoting a contact card names the card", async () => {
	const out = await normalize(
		inlineReply({ type: "text", text: "save this" }, { id: "t1", direction: "inbound", content: { type: "contact", name: { formatted: "Sam Rivera" } } }),
	);
	assert.equal(out.text[0], '[Replying inline to an earlier message: "[contact card: Sam Rivera]"]');
});
