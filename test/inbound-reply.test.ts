import assert from "node:assert/strict";
import { test } from "node:test";
import { type InboundFile, normalizeInbound } from "../src/channel.ts";

const noFiles = async () => undefined;

async function normalize(content: unknown, saveBinary: (content: any) => Promise<InboundFile | undefined> = noFiles) {
	const out = { text: [] as string[], files: [] as InboundFile[] };
	await normalizeInbound(content, out, saveBinary);
	return out;
}

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

test("a reply that wraps nothing readable is still dropped, as are reactions", async () => {
	assert.deepEqual(await normalize(inlineReply({ type: "reaction", emoji: "👍" }, { id: "t1", content: { type: "text", text: "hi" } })), {
		text: [],
		files: [],
	});
	assert.deepEqual(await normalize({ type: "reaction", emoji: "👍" }), { text: [], files: [] });
});

test("plain text and grouped messages are unchanged", async () => {
	assert.deepEqual((await normalize({ type: "text", text: "hello" })).text, ["hello"]);
	const group = { type: "group", items: [{ content: { type: "text", text: "a" } }, { type: "richlink", url: "https://example.com" }] };
	assert.deepEqual((await normalize(group)).text, ["a", "https://example.com"]);
});
