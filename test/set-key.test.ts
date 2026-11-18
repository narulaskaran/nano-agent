import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/set-key", import.meta.url).pathname;

function setKey(envFile: string, key: string, input: string) {
	return spawnSync("bash", [script, key, "--stdin"], { input, encoding: "utf8", env: { ...process.env, NANO_ENV_FILE: envFile } });
}

test("set-key writes a trimmed, quoted value in place and never prints it", () => {
	const envFile = join(mkdtempSync(join(tmpdir(), "nano-set-key-")), ".env");
	writeFileSync(envFile, "# DEEPSEEK_API_KEY is the default\nDEEPSEEK_API_KEY=\nTZ=UTC\n");
	const run = setKey(envFile, "DEEPSEEK_API_KEY", "  sk-a$b\r\n");
	assert.equal(run.status, 0, run.stderr);
	assert.ok(!run.stdout.includes("sk-a") && !run.stderr.includes("sk-a"));
	assert.equal(readFileSync(envFile, "utf8"), "# DEEPSEEK_API_KEY is the default\nDEEPSEEK_API_KEY='sk-a$b'\nTZ=UTC\n");
	assert.equal(statSync(envFile).mode & 0o777, 0o600);

	assert.equal(setKey(envFile, "NEW_KEY", "v2").status, 0);
	assert.match(readFileSync(envFile, "utf8"), /\nNEW_KEY='v2'\n$/);
});

test("set-key refuses empty, multi-word and already-used values", () => {
	const envFile = join(mkdtempSync(join(tmpdir(), "nano-set-key-")), ".env");
	writeFileSync(envFile, "DEEPSEEK_API_KEY='sk-1'\nPHOTON_PROJECT_ID=\n");
	assert.match(setKey(envFile, "PHOTON_PROJECT_ID", "").stderr, /empty/);
	assert.match(setKey(envFile, "PHOTON_PROJECT_ID", "Copied text\n").stderr, /not a key/);
	assert.match(setKey(envFile, "PHOTON_PROJECT_ID", "sk-1").stderr, /already set as DEEPSEEK_API_KEY/);
	assert.equal(readFileSync(envFile, "utf8"), "DEEPSEEK_API_KEY='sk-1'\nPHOTON_PROJECT_ID=\n");
});
