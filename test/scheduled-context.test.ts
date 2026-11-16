import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { labelScriptOutput, Scheduler } from "../src/scheduler.ts";
import { scriptedConversation } from "./helpers/scripted-session.ts";

test("script output goes out with the job's name on top", () => {
	assert.equal(labelScriptOutput("Weekly summary", "Weight is steady."), "Weekly summary:\nWeight is steady.");
	assert.equal(labelScriptOutput("Weekly summary", "Weekly summary: weight is steady."), "Weekly summary: weight is steady.");
	assert.equal(labelScriptOutput("  ", "hi"), "hi");
});

test("a scheduled script's output is sent labelled", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-scheduler-"));
	mkdirSync(join(dataDir, "workspace"));
	const sent: string[] = [];
	const scheduler = new Scheduler({ dataDir, owner: "owner" } as Config, {
		send: async (_space, text) => void sent.push(text),
		task: async () => {},
		background: async () => {},
	});
	scheduler.add({ name: "Weekly summary", kind: "script", then: "send", body: "echo Weight is steady.", cron: "* * * * *", spaceId: "owner" });
	await scheduler.tick(new Date(Date.UTC(2026, 10, 15, 19, 0, 5)));
	const running = (scheduler as unknown as { running: Set<string> }).running;
	for (let i = 0; i < 500 && running.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(sent, ["Weekly summary:\nWeight is steady."]);
});

test("the next turn is told what scheduled jobs sent the owner, once", async () => {
	const nano = await scriptedConversation({ packs: "core" });
	nano.script([() => fauxAssistantMessage(fauxText("Class is at 3:15."))]);
	nano.say("when is pilates");
	assert.equal(await nano.next(), "Class is at 3:15.");

	await nano.conversation.deliver("Weekly summary:\nNot enough weigh-ins this week.");
	assert.equal(await nano.next(), "Weekly summary:\nNot enough weigh-ins this week.");

	nano.script([
		(context) => {
			const prompt = JSON.stringify(context.messages.at(-1));
			assert.match(prompt, /your scheduled jobs sent the owner/);
			assert.match(prompt, /Weekly summary: Not enough weigh-ins this week/);
			return fauxAssistantMessage(fauxText("That was the weekly summary job."));
		},
	]);
	nano.say("why did you send that?");
	assert.equal(await nano.next(), "That was the weekly summary job.");

	nano.script([
		(context) => {
			assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /your scheduled jobs sent the owner/);
			return fauxAssistantMessage(fauxText("Ok."));
		},
	]);
	nano.say("ok");
	assert.equal(await nano.next(), "Ok.");
	await nano.conversation.dispose();
});
