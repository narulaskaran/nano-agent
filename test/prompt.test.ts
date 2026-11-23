import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { buildSystemPrompt } from "../src/prompt.ts";

test("SOUL.md is optional and is reread for conversation prompts only", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-prompt-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_PACKS: "core" });
	const soulFile = join(dataDir, "SOUL.md");
	const preference = "Use dry humor in casual chats.";
	writeFileSync(join(dataDir, "LOCAL.md"), "Google access is read-only.");
	const defaultPrompt = buildSystemPrompt(config);
	assert.ok(!defaultPrompt.includes("## Owner's voice preferences"));

	writeFileSync(soulFile, "  \n");
	assert.equal(buildSystemPrompt(config), defaultPrompt);

	writeFileSync(soulFile, preference + "\n");
	const conversation = buildSystemPrompt(config);
	assert.ok(conversation.includes("## Owner's voice preferences\n" + preference));
	assert.ok(conversation.includes("Google access is read-only."));
	assert.ok(!buildSystemPrompt(config, { private: false }).includes(preference));
	assert.ok(!buildSystemPrompt(config, { private: true }).includes(preference));
});
