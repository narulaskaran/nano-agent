import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { packDirs } from "../src/packs.ts";
import { listSkills } from "../src/skills.ts";

function writeSkill(dataDir: string, name: string, description: string): string {
	const dir = join(dataDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n`);
	return path;
}

test("skill list updates when a skill directory or SKILL.md mtime changes", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-skills-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_PACKS: "" });

	assert.deepEqual(listSkills(config), []);

	const hello = writeSkill(dataDir, "hello", "Says hello");
	// utimes only restores whole milliseconds, so pin the mtime before the cached read.
	const frozen = new Date(Math.floor(Date.now() / 1000) * 1000);
	utimesSync(hello, frozen, frozen);
	assert.deepEqual(
		listSkills(config).map((skill) => [skill.name, skill.description]),
		[["hello", "Says hello"]],
	);

	// Same mtime must keep the cached description; a newer mtime must show the edit.
	writeFileSync(hello, "---\nname: hello\ndescription: Says hello again\n---\n");
	utimesSync(hello, frozen, frozen);
	assert.equal(listSkills(config)[0]?.description, "Says hello");
	utimesSync(hello, new Date(frozen.getTime() + 1000), new Date(frozen.getTime() + 1000));
	assert.equal(listSkills(config)[0]?.description, "Says hello again");

	writeSkill(dataDir, "later", "Added later");
	assert.deepEqual(listSkills(config).map((skill) => skill.name), ["hello", "later"]);
	rmSync(join(dataDir, "skills", "later"), { recursive: true, force: true });
	assert.deepEqual(listSkills(config).map((skill) => skill.name), ["hello"]);
});

test("pack skills stay listed and a runtime skill does not replace them", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-skills-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_PACKS: "core" });
	assert.ok(listSkills(config).some((skill) => skill.name === "scheduling"));
	writeSkill(dataDir, "scheduling", "Should not replace the pack skill");
	const listed = listSkills(config);
	assert.equal(listed.filter((skill) => skill.name === "scheduling").length, 1);
	assert.equal(listed.find((skill) => skill.name === "scheduling")?.description.startsWith("Patterns for reminders"), true);
});

test("a missing pack is logged once per process", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-packs-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_PACKS: "not-a-pack" });
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		packDirs(config);
		packDirs(config);
		listSkills(config);
		listSkills(config);
	} finally {
		console.error = original;
	}
	assert.equal(lines.filter((line) => line.includes('pack "not-a-pack" not found')).length, 1);
});
