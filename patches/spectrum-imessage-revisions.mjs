#!/usr/bin/env node
/**
 * Patches @spectrum-ts/imessage so inbound edits and unsends reach Nano.
 *
 * Photon's iMessage server emits `message.edited` and `message.unsent` events
 * (https://photon.codes/docs/advanced-kits/imessage/messages), but the Spectrum
 * adapter's inbound stream maps only received messages, reactions and read
 * receipts, and consumes everything else with a debug log. Photon's webhook
 * docs say the same: "edits ... aren't delivered in any form yet"
 * (https://photon.codes/docs/webhooks/delivery).
 *
 * This adds the two events as inbound messages whose content is
 * `{ type: "edit", content: <text>, target }` or `{ type: "unsend", target }`,
 * the shapes Spectrum core already uses for outbound edits and unsends. The
 * target is the adapter's cached copy of the message, so it holds the old text;
 * an edit then updates that copy, so a second edit quotes the first.
 *
 * The patch is pinned to one adapter version: on any other version it fails,
 * so an upgrade cannot silently drop it. Check whether the new version maps the
 * events itself; if not, move the anchors. Re-running it is a no-op.
 *
 * Unverified against a live line as of 2026-11-16: Photon documents the events,
 * but none had been seen in this line's event history yet.
 *
 * Usage: node patches/spectrum-imessage-revisions.mjs [node_modules dir]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PATCHED_VERSION = "12.16.0";
const MARKER = "// nano patch: inbound edits and unsends";

const HELPER = `${MARKER}
const toRevisionMessages = async (client, event, phone, id) => {
	const chatGuid = String(event.chatGuid ?? "");
	const type = chatTypeFromGuid(chatGuid);
	const address = event.actor?.address ?? (type === "dm" ? /^any;-;(.+)$/.exec(chatGuid)?.[1] : undefined);
	if (!address) return [];
	const space = { id: chatGuid, type, phone };
	// Not fetched: the server would return the edited version, and an unsent message is gone.
	const cache = getMessageCache(client);
	const cached = cache.get(event.messageGuid);
	const target = cached ?? { id: event.messageGuid, content: asCustom({ imessage_type: "revision-target", stub: true }), space };
	const base = { sender: toSenderRef({ ...event.actor, address }), space, timestamp: event.occurredAt, id };
	if (event.type === "message.unsent") return [{ ...base, content: { type: "unsend", target } }];
	const text = event.content?.text;
	if (!text) return [];
	if (cached) cache.set(event.messageGuid, { ...cached, content: asText(text) });
	return [{ ...base, content: { type: "edit", content: asText(text), target } }];
};
const toMessageItem = async (client, event, phone, cursor, onInbound) => {`;

const DISPATCH = `	${MARKER}
	if (event.type === "message.edited" || event.type === "message.unsent") {
		const id = \`\${event.messageGuid}:\${event.type === "message.edited" ? "edit" : "unsend"}:\${event.sequence}\`;
		return {
			cursor,
			id,
			values: isEventFromCurrentAccount(event, phone) ? [] : await toRevisionMessages(client, event, phone, id)
		};
	}
	streamLog.debug("message event consumed without mapping", {`;

/** Each anchor in the adapter's dist/index.js and the text that replaces it. */
export const ANCHORS = [
	["const toMessageItem = async (client, event, phone, cursor, onInbound) => {", HELPER],
	['\tstreamLog.debug("message event consumed without mapping", {', DISPATCH],
];

/** Applies the patch to the adapter under `nodeModules`. Returns "patched" or "already patched"; throws when it cannot. */
export function patchSpectrumIMessage(nodeModules) {
	const dir = join(nodeModules, "@spectrum-ts", "imessage");
	const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	if (version !== PATCHED_VERSION) {
		throw new Error(
			`@spectrum-ts/imessage is ${version}, but patches/spectrum-imessage-revisions.mjs targets ${PATCHED_VERSION}. ` +
				"Check whether the new version delivers message.edited / message.unsent itself; if not, update the patch.",
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

if (import.meta.url === `file://${process.argv[1]}`) {
	const nodeModules = resolve(process.argv[2] ?? "node_modules");
	console.log(`@spectrum-ts/imessage: ${patchSpectrumIMessage(nodeModules)}`);
}
