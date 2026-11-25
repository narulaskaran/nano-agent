import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { currentTimezone, loadConfig } from "../src/config.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

// The log line format written by Conversation.record(): "- HH:MM **role**: text".
const LOG_LINE = /^- \d{2}:\d{2} \*\*(owner|nano)\*\*: /;

test("a mid-session note appended by the model sits in the daily log in the existing format, with no rollover", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	const day = new Intl.DateTimeFormat("en-CA", { timeZone: currentTimezone(nano.config) }).format(Date.now());
	const file = join(nano.dataDir, "log", `${day}.md`);
	const note = "- 21:40 **nano**: Open: hotel in Lisbon. Agreed: Alfama, under 200 a night. Undecided: 3 or 4 nights. Next: owner checks dates.";

	nano.script([
		// The owner says goodnight mid-topic: a natural break with a decision still open.
		() => fauxAssistantMessage(fauxToolCall("bash", { command: `printf '%s\\n' '${note}' >> '${file}'` }), { stopReason: "toolUse" }),
		() => fauxAssistantMessage(fauxText("Night. Hotel dates are still open; I'll pick it up tomorrow.")),
	]);
	nano.say("goodnight, I'll think about the hotel nights");
	assert.match(await nano.next(), /Night\./);
	await nano.conversation.dispose();

	const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.startsWith("- "));
	// The runtime's own lines (owner message, Nano reply) and the model's note all parse the same way.
	assert.equal(lines.length, 3);
	for (const line of lines) assert.match(line, LOG_LINE);
	assert.ok(lines.includes(note));
	// Written during the session: the owner line precedes the note, and no second context window started.
	assert.match(lines[0], /\*\*owner\*\*: goodnight/);
	assert.equal(nano.pending(), 0);
});
