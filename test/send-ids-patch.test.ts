import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sendIds } from "../src/outbound.ts";
// @ts-expect-error plain .mjs script without types
import { ANCHORS, PATCHED_VERSION, patchSpectrumSendIds } from "../patches/spectrum-imessage-send-ids.mjs";

/** A throwaway node_modules whose @spectrum-ts/imessage is a copy with this patch taken back out. */
function adapterCopy(): { nodeModules: string; index: string } {
	const real = join(dirname(fileURLToPath(import.meta.resolve("@spectrum-ts/core"))), "..", "..", "..");
	const nodeModules = join(mkdtempSync(join(tmpdir(), "nano-sendids-")), "node_modules");
	mkdirSync(join(nodeModules, "@spectrum-ts"), { recursive: true });
	for (const name of readdirSync(real)) if (name !== "@spectrum-ts") symlinkSync(join(real, name), join(nodeModules, name));
	symlinkSync(join(real, "@spectrum-ts", "core"), join(nodeModules, "@spectrum-ts", "core"));
	cpSync(join(real, "@spectrum-ts", "imessage"), join(nodeModules, "@spectrum-ts", "imessage"), { recursive: true });
	const index = join(nodeModules, "@spectrum-ts", "imessage", "dist", "index.js");
	let source = readFileSync(index, "utf8");
	for (const [anchor, replacement] of ANCHORS as [string, string][]) source = source.replace(replacement, anchor);
	writeFileSync(index, source);
	return { nodeModules, index };
}

test("the send-id patch applies once, refuses other versions, and passes the queued send's clientMessageId", async () => {
	const { nodeModules, index } = adapterCopy();
	assert.equal(patchSpectrumSendIds(nodeModules), "patched");
	assert.equal(patchSpectrumSendIds(nodeModules), "already patched");
	writeFileSync(index, `${readFileSync(index, "utf8")}\nexport { sendContent as __sendContent };\n`);
	const { __sendContent: sendContent } = await import(index);
	const options: Record<string, unknown>[] = [];
	const remote = { messages: { sendText: async (_chat: unknown, _text: string, o: Record<string, unknown>) => (options.push(o ?? {}), { guid: "G1" }) } };
	await sendIds.run({ clientMessageId: "nano-abc-1" }, () => sendContent(remote, "space", "chat", { type: "text", text: "hi" }));
	await sendIds.run({ clientMessageId: "nano-abc-2" }, () => sendContent(remote, "space", "chat", { type: "markdown", markdown: "**hi**" }));
	await sendContent(remote, "space", "chat", { type: "text", text: "live reply" });
	assert.equal(options[0]?.clientMessageId, "nano-abc-1");
	assert.equal(options[1]?.clientMessageId, "nano-abc-2");
	assert.ok(Array.isArray(options[1]?.formatting), "markdown formatting is kept");
	assert.equal(options[2]?.clientMessageId, undefined, "a send outside the queue is unchanged");

	const pkg = join(nodeModules, "@spectrum-ts", "imessage", "package.json");
	writeFileSync(pkg, readFileSync(pkg, "utf8").replace(`"version": "${PATCHED_VERSION}"`, '"version": "99.0.0"'));
	assert.throws(() => patchSpectrumSendIds(nodeModules), /is 99.0.0, but .* targets/);
});
