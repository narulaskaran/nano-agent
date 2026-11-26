#!/usr/bin/env node
/**
 * Patches @spectrum-ts/imessage so a text send can carry Photon's `clientMessageId`.
 *
 * Photon's iMessage client takes `clientMessageId`, a stable idempotency key for one logical send: the server
 * rejects a repeat with a `duplicateMessage` error, which means the first send went through
 * (@photon-ai/advanced-imessage README, "dedupe across client restarts"). The Spectrum adapter never passes it.
 *
 * Nano's owner outbound queue runs each send inside `sendIds.run({ clientMessageId }, ...)`, an AsyncLocalStorage
 * published on `globalThis` under `Symbol.for("nano.sendIds")`. The patched text and markdown sends read the
 * current store and add the key to their options. Any other send is unchanged.
 *
 * Pinned to one adapter version like spectrum-imessage-revisions.mjs. Re-running it is a no-op.
 *
 * Usage: node patches/spectrum-imessage-send-ids.mjs [node_modules dir]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PATCHED_VERSION = "12.16.0";
const MARKER = "// nano patch: client message ids";

const HELPER = `${MARKER}
const nanoSendOptions = () => {
	const id = globalThis[Symbol.for("nano.sendIds")]?.getStore()?.clientMessageId;
	return typeof id === "string" && id ? { clientMessageId: id } : {};
};
const sendContent = async (remote, spaceId, chat, content, replyTo, effect) => {`;

/** Each anchor in the adapter's dist/index.js and the text that replaces it. */
export const ANCHORS = [
	["const sendContent = async (remote, spaceId, chat, content, replyTo, effect) => {", HELPER],
	[
		"const message = await remote.messages.sendText(chat, content.text, withReply(effectOption(effect), replyTo));",
		"const message = await remote.messages.sendText(chat, content.text, withReply({ ...effectOption(effect), ...nanoSendOptions() }, replyTo));",
	],
	[
		"\t\t\t\t...formattingOption(rendered.formatting)\n\t\t\t}, replyTo));",
		"\t\t\t\t...formattingOption(rendered.formatting),\n\t\t\t\t...nanoSendOptions()\n\t\t\t}, replyTo));",
	],
];

/** Applies the patch to the adapter under `nodeModules`. Returns "patched" or "already patched"; throws when it cannot. */
export function patchSpectrumSendIds(nodeModules) {
	const dir = join(nodeModules, "@spectrum-ts", "imessage");
	const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	if (version !== PATCHED_VERSION) {
		throw new Error(
			`@spectrum-ts/imessage is ${version}, but patches/spectrum-imessage-send-ids.mjs targets ${PATCHED_VERSION}. ` +
				"Check whether the new version passes clientMessageId itself; if not, update the patch.",
		);
	}
	const file = join(dir, "dist", "index.js");
	let source = readFileSync(file, "utf8");
	if (source.includes(MARKER)) return "already patched";
	for (const [anchor, replacement] of ANCHORS) {
		if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) throw new Error(`@spectrum-ts/imessage: patch anchor not found exactly once: ${anchor.trim()}`);
		source = source.replace(anchor, replacement);
	}
	writeFileSync(file, source);
	return "patched";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const nodeModules = resolve(process.argv[2] ?? "node_modules");
	console.log(`@spectrum-ts/imessage: ${patchSpectrumSendIds(nodeModules)}`);
}
