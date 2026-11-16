import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Inbound } from "../src/channel.ts";
// @ts-expect-error plain .mjs script without types
import { PATCHED_VERSION, patchSpectrumIMessage } from "../patches/spectrum-imessage-revisions.mjs";
import { normalize } from "./helpers/inbound.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

/** The adapter's cached copy of a message, as an edit or unsend carries it. */
const was = (id: string, text: string) => ({ id, content: { type: "text", text } });
const editOf = (id: string, oldText: string, text: string) => ({ type: "edit", content: { type: "text", text }, target: was(id, oldText) });

test("an edit becomes a note with the old and new text, and says what it revises", async () => {
	const out = await normalize(editOf("G1", "2 cups of stew", "3 cups of stew"));
	assert.deepEqual(out.text, ['[Edited an earlier message (it said: "2 cups of stew"). It now says:]', "3 cups of stew"]);
	assert.deepEqual(out.revision, { kind: "edit", targetId: "G1", text: "3 cups of stew" });
});

test("an edit of a message the adapter no longer has still arrives, without the old text", async () => {
	const out = await normalize({ type: "edit", content: { type: "text", text: "new" }, target: { id: "G1", content: { type: "custom", raw: { stub: true } } } });
	assert.deepEqual(out.text, ["[Edited an earlier message. It now says:]", "new"]);
});

test("an edit of one part of a multi-part message targets the whole message", async () => {
	assert.equal((await normalize(editOf("p:1/G1", "y", "x"))).revision?.targetId, "G1");
});

test("an unsend becomes a note quoting the withdrawn message", async () => {
	const out = await normalize({ type: "unsend", target: was("G2", "book the 6 PM show") });
	assert.deepEqual(out.text, ['[Unsent an earlier message: "book the 6 PM show"]']);
	assert.deepEqual(out.revision, { kind: "unsend", targetId: "G2" });
});

test("an edit with no readable text, or a revision with no target, is dropped", async () => {
	assert.deepEqual(await normalize({ type: "edit", content: { type: "read" }, target: was("G1", "x") }), { text: [], files: [] });
	assert.deepEqual(await normalize({ type: "unsend", target: {} }), { text: [], files: [] });
});

/** What the channel hands the conversation: a plain text, or a revision built the way the channel builds it. */
const text = (messageId: string, body: string): Inbound => ({ spaceId: "stdin", senderId: "stdin", messageId, text: body, files: [] });
async function revision(content: unknown, messageId: string): Promise<Inbound> {
	const out = await normalize(content);
	return { ...text(messageId, out.text.join("\n")), revision: out.revision };
}

test("an edit inside the burst window replaces the text before Nano sees it", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([
		(context) => {
			const prompt = JSON.stringify(context.messages.at(-1));
			assert.match(prompt, /3 cups/);
			assert.doesNotMatch(prompt, /2 cups|Edited/);
			return fauxAssistantMessage(fauxText("Logged 3 cups."));
		},
	]);
	nano.conversation.receive(text("G1", "2 cups of stew"));
	nano.conversation.receive(await revision(editOf("G1", "2 cups of stew", "3 cups of stew"), "G1:edit:1"));
	assert.equal(await nano.next(), "Logged 3 cups.");
	await nano.conversation.dispose();
});

test("an unsend inside the burst window withdraws the text and starts no turn", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([() => fauxAssistantMessage(fauxText("should not be sent"))]);
	nano.conversation.receive(text("G2", "oops wrong chat"));
	nano.conversation.receive(await revision({ type: "unsend", target: was("G2", "oops wrong chat") }, "G2:unsend:1"));
	// The 1.2 s burst window has passed with nothing to answer.
	await assert.rejects(nano.next(1500), /no reply/);
	await nano.conversation.dispose();
});

test("an edit after Nano answered reaches it as a note with the old and new text", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([() => fauxAssistantMessage(fauxText("Logged 2 cups."))]);
	nano.conversation.receive(text("G1", "2 cups of stew"));
	assert.equal(await nano.next(), "Logged 2 cups.");
	nano.script([
		(context) => {
			const prompt = JSON.stringify(context.messages.at(-1));
			assert.match(prompt, /Edited an earlier message \(it said: \\"2 cups of stew\\"\)/);
			assert.match(prompt, /3 cups of stew/);
			return fauxAssistantMessage(fauxText("Updated to 3 cups."));
		},
	]);
	nano.conversation.receive(await revision(editOf("G1", "2 cups of stew", "3 cups of stew"), "G1:edit:1"));
	assert.equal(await nano.next(), "Updated to 3 cups.");
	await nano.conversation.dispose();
});

/** A throwaway node_modules: every package linked from the real one, except @spectrum-ts/imessage, which is a copy. */
function adapterCopy(): { nodeModules: string; index: string } {
	const real = join(dirname(fileURLToPath(import.meta.resolve("@spectrum-ts/core"))), "..", "..", "..");
	const nodeModules = join(mkdtempSync(join(tmpdir(), "nano-patch-")), "node_modules");
	mkdirSync(join(nodeModules, "@spectrum-ts"), { recursive: true });
	for (const name of readdirSync(real)) if (name !== "@spectrum-ts") symlinkSync(join(real, name), join(nodeModules, name));
	symlinkSync(join(real, "@spectrum-ts", "core"), join(nodeModules, "@spectrum-ts", "core"));
	cpSync(join(real, "@spectrum-ts", "imessage"), join(nodeModules, "@spectrum-ts", "imessage"), { recursive: true });
	return { nodeModules, index: join(nodeModules, "@spectrum-ts", "imessage", "dist", "index.js") };
}

test("the adapter patch applies once, refuses other versions, and maps edits and unsends", async () => {
	const { nodeModules, index } = adapterCopy();
	assert.equal(patchSpectrumIMessage(nodeModules), "patched");
	assert.equal(patchSpectrumIMessage(nodeModules), "already patched");

	// Expose the patched stream mapper and the message cache to this test only.
	writeFileSync(index, `${readFileSync(index, "utf8")}\nexport { toMessageItem as __toMessageItem, getMessageCache as __getMessageCache };\n`);
	const { __toMessageItem: toMessageItem, __getMessageCache: getMessageCache } = await import(index);
	const client = {}; // nothing is fetched: the target comes from the cache or is a stub
	getMessageCache(client).set("G1", { id: "G1", content: { type: "text", text: "2 cups" }, space: {} });
	const context = { chatGuid: "any;-;+15550100", occurredAt: new Date(), isFromMe: false, actor: { address: "+15550100" } };
	const edit = (sequence: number, text: string) =>
		toMessageItem(client, { type: "message.edited", sequence, messageGuid: "G1", content: { text }, ...context }, "+15559999", String(sequence));

	const first = await edit(7, "3 cups");
	assert.equal(first.id, "G1:edit:7");
	const [message] = first.values;
	assert.equal(message.sender.id, "+15550100");
	assert.deepEqual(message.content.content, { type: "text", text: "3 cups" });
	assert.equal(message.content.target.content.text, "2 cups", "the target holds the text before the edit");
	const second = await edit(8, "4 cups");
	assert.equal(second.values[0].content.target.content.text, "3 cups", "a second edit quotes the first");

	const unsent = await toMessageItem(client, { type: "message.unsent", sequence: 9, messageGuid: "G2", ...context, actor: undefined }, "+15559999", "9");
	assert.equal(unsent.values[0].content.type, "unsend");
	assert.equal(unsent.values[0].sender.id, "+15550100", "a DM's sender comes from the chat when the event has no actor");

	const mine = await toMessageItem(client, { type: "message.edited", sequence: 10, messageGuid: "G3", content: { text: "x" }, ...context, isFromMe: true }, "+15559999", "10");
	assert.deepEqual(mine.values, [], "Nano's own edits are not inbound");

	const pkg = join(nodeModules, "@spectrum-ts", "imessage", "package.json");
	writeFileSync(pkg, readFileSync(pkg, "utf8").replace(`"version": "${PATCHED_VERSION}"`, '"version": "99.0.0"'));
	assert.throws(() => patchSpectrumIMessage(nodeModules), new RegExp(`is 99.0.0, but .* targets ${PATCHED_VERSION}`));
});
