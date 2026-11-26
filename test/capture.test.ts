import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type Compose, createCapture, describeItem, kbTools } from "../src/capture.ts";
import type { ComposeTool } from "../src/compose.ts";

function kb() {
	const root = mkdtempSync(join(tmpdir(), "nano-kb-"));
	const dir = join(root, "kb");
	mkdirSync(join(dir, "people"), { recursive: true });
	mkdirSync(join(dir, "_system"), { recursive: true });
	writeFileSync(join(dir, "INDEX.md"), "# Knowledge Index\nRead WORKFLOW.md first.\n");
	writeFileSync(join(dir, "people", "index.md"), "# people/\n- [Owner](owner.md) — the owner\n");
	writeFileSync(join(dir, "people", "owner.md"), "---\nsummary: the owner\n---\n# Owner\n## Current decisions\n- Diet: omnivore (2026-01-02)\n");
	writeFileSync(join(dir, "_system", "secret.md"), "internal\n");
	writeFileSync(join(root, "outside.md"), "outside\n");
	return { root, dir };
}

const tool = (tools: ComposeTool[], name: string) => tools.find((t) => t.name === name)!;
const call = (tools: ComposeTool[], name: string, args: Record<string, unknown>) => tool(tools, name).run(args, new AbortController().signal);
const version = (text: string) => /version ([0-9a-f]+)/.exec(text)?.[1] ?? "";

test("KB tools stay inside the KB, skip hidden and _ folders, and only write notes inside category folders", async () => {
	const { root, dir } = kb();
	symlinkSync(join(root, "outside.md"), join(dir, "people", "link.md"));
	const changes: { path: string }[] = [];
	const tools = kbTools(dir, changes as never);
	assert.match(await call(tools, "kb_read", { path: "../outside.md" }), /outside the knowledge base/);
	assert.match(await call(tools, "kb_read", { path: "/etc/passwd" }), /outside the knowledge base|Only Markdown/);
	assert.match(await call(tools, "kb_read", { path: "people/link.md" }), /outside the knowledge base/);
	assert.match(await call(tools, "kb_read", { path: "_system/secret.md" }), /not available/);
	assert.match(await call(tools, "kb_read", { path: "people/owner.json" }), /Only Markdown/);
	assert.match(await call(tools, "kb_read", { path: "INDEX.md" }), /Read WORKFLOW.md first/);
	assert.doesNotMatch(await call(tools, "kb_list", { dir: "" }), /_system/);
	assert.match(await call(tools, "kb_search", { text: "omnivore" }), /people\/owner\.md: - Diet: omnivore/);
	const index = await call(tools, "kb_read", { path: "INDEX.md" });
	assert.match(await call(tools, "kb_edit", { path: "INDEX.md", version: version(index), old: "Knowledge", new: "Pwned" }), /Top-level files/);
	assert.match(await call(tools, "kb_create", { path: "new.md", content: "x" }), /Top-level files/);
	assert.match(await call(tools, "kb_create", { path: "nowhere/new.md", content: "x" }), /category folder does not exist/);
	assert.equal(changes.length, 0);
});

test("KB edits need the current version, refuse ambiguous text, and write atomically with the file's mode", async () => {
	const { dir } = kb();
	const changes: { path: string; before: string | null; after: string }[] = [];
	const tools = kbTools(dir, changes);
	const read = await call(tools, "kb_read", { path: "people/owner.md" });
	assert.match(await call(tools, "kb_edit", { path: "people/owner.md", version: "stale", old: "omnivore", new: "x" }), /changed since you read it/);
	assert.match(await call(tools, "kb_edit", { path: "people/owner.md", version: version(read), old: "nothing like this", new: "x" }), /not in the note/);
	// Someone else writes between the read and the edit.
	const path = join(dir, "people", "owner.md");
	writeFileSync(path, `${readFileSync(path, "utf8")}- Lives in NYC\n`);
	assert.match(await call(tools, "kb_edit", { path: "people/owner.md", version: version(read), old: "omnivore (2026-01-02)", new: "vegetarian (2026-11-26)" }), /changed since you read it/);
	const fresh = await call(tools, "kb_read", { path: "people/owner.md" });
	assert.match(
		await call(tools, "kb_edit", { path: "people/owner.md", version: version(fresh), old: "- Diet: omnivore (2026-01-02)", new: "- Diet: vegetarian (2026-11-26); omnivore superseded" }),
		/Saved people\/owner\.md/,
	);
	const after = readFileSync(path, "utf8");
	assert.match(after, /vegetarian \(2026-11-26\)/);
	assert.match(after, /Lives in NYC/, "the other write is kept");
	assert.equal(changes.length, 1);
	assert.match(changes[0]?.before ?? "", /omnivore \(2026-01-02\)/);
	assert.deepEqual(readdirSync(join(dir, "people")).filter((n) => n.endsWith(".tmp")), [], "no temp files left");

	assert.match(await call(tools, "kb_create", { path: "people/sam.md", content: "---\nsummary: Sam\n---\n# Sam" }), /Saved/);
	assert.match(await call(tools, "kb_create", { path: "people/sam.md", content: "again" }), /already exists/);
	const sam = await call(tools, "kb_read", { path: "people/sam.md" });
	assert.match(await call(tools, "kb_append", { path: "people/sam.md", version: version(sam), text: "- Birthday: May 3" }), /Saved/);
	assert.match(readFileSync(join(dir, "people", "sam.md"), "utf8"), /# Sam\n- Birthday: May 3\n$/);
});

test("the filer item wraps owner text and email fields as data", () => {
	const owner = describeItem({ source: "owner", text: "I'm vegetarian now", at: 1, recent: [{ role: "nano", text: "What's for dinner?" }] }, "2026-11-26");
	assert.match(owner, /Today: 2026-11-26/);
	assert.match(owner, /Assistant: What's for dinner\?/);
	assert.match(owner, /<<<\nI'm vegetarian now\n>>>/);
	const email = describeItem({ source: "gmail", messageId: "abc", subject: "Booking confirmed" }, "2026-11-26");
	assert.match(email, /Item from gmail \(untrusted/);
	assert.match(email, /"messageId": "abc"/);
});

test("the filer runs one item at a time on the background role, logs what changed with a copy, and reports status", async () => {
	const { root, dir } = kb();
	const dataDir = join(root, "data");
	const calls: { role?: string; tools: string[] }[] = [];
	const compose: Compose = async (_system, user, signal, options) => {
		calls.push({ role: options?.role, tools: (options?.tools ?? []).map((t) => t.name) });
		const tools = options?.tools ?? [];
		if (user.includes("nothing lasting")) return "NOTHING small talk";
		if (user.includes("read the email")) return String(await call(tools, "gmail_read", {}));
		const read = await tools.find((t) => t.name === "kb_read")!.run({ path: "people/owner.md" }, signal);
		await tools.find((t) => t.name === "kb_edit")!.run({ path: "people/owner.md", version: version(read), old: "omnivore (2026-01-02)", new: "vegetarian (2026-11-26)" }, signal);
		return "FILED people/owner.md";
	};
	const capture = createCapture({
		db: new DatabaseSync(":memory:"),
		kbDir: dir,
		dataDir,
		compose,
		sources: { gmail: { tools: (payload) => [{ name: "gmail_read", description: "", parameters: {}, run: async () => `email ${payload.messageId}` }] } },
	});
	assert.equal(capture.status(), undefined);
	capture.enqueue({ source: "owner", text: "I'm vegetarian now", at: 1, recent: [] }, { dedupe: "owner:1" });
	capture.enqueue({ source: "owner", text: "nothing lasting here", at: 2, recent: [] }, { dedupe: "owner:2" });
	capture.enqueue({ source: "gmail", messageId: "m1", note: "read the email" }, { dedupe: "gmail:m1" });
	assert.equal(capture.enqueue({ source: "gmail", messageId: "m1" }, { dedupe: "gmail:m1" }), false);
	assert.match(capture.status() ?? "", /3 waiting/);
	const stop = new AbortController();
	const running = capture.run(stop.signal);
	const end = Date.now() + 5000;
	while (capture.queue.pending() > 0 && Date.now() < end) await sleep(20);
	stop.abort();
	await running;
	assert.match(readFileSync(join(dir, "people", "owner.md"), "utf8"), /vegetarian \(2026-11-26\)/);
	assert.ok(calls.every((c) => c.role === "background"));
	assert.ok(calls[2]?.tools.includes("gmail_read"));
	assert.ok(!calls[0]?.tools.includes("gmail_read"), "a source's tools only for its own items");
	const log = readFileSync(join(dataDir, "capture", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(log.map((l) => l.status), ["filed", "nothing", "nothing"]);
	assert.deepEqual(log[0].files, ["people/owner.md"]);
	const copies = readdirSync(join(dataDir, "capture", "changes"));
	assert.equal(copies.length, 1);
	assert.match(readFileSync(join(dataDir, "capture", "changes", copies[0]!), "utf8"), /omnivore \(2026-01-02\)/, "the pre-edit copy is kept");
	assert.match(capture.status() ?? "", /1 filed \(people\/owner\.md\); 2 judged not worth filing/);
});

test("a filer that keeps failing gives up quietly and says so in the status", async () => {
	const { root, dir } = kb();
	let now = 1_000_000;
	const capture = createCapture({
		db: new DatabaseSync(":memory:"), kbDir: dir, dataDir: join(root, "data"), now: () => now, pollMs: 10,
		compose: async () => {
			throw new Error("model down");
		},
	});
	capture.enqueue({ source: "owner", text: "x", at: 1, recent: [] }, { dedupe: "owner:x" });
	const stop = new AbortController();
	const running = capture.run(stop.signal);
	for (let i = 0; i < 60 && capture.queue.pending() > 0; i++) {
		await sleep(15);
		now += 31 * 60_000; // past every backoff
	}
	stop.abort();
	await running;
	assert.equal(capture.queue.pending(), 0);
	const log = readFileSync(join(root, "data", "capture", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(log.map((l) => l.status), ["failed"]);
	assert.match(log[0].error, /model down/);
	assert.match(capture.status(now - 30 * 60_000) ?? "", /1 failed/);
});
