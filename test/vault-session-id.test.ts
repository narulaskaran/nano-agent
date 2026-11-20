import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { withBodySessionId } from "../src/provider-settings.ts";

test("the vault path puts the session id in the request body, which is all the daemon forwards", async () => {
	const runtime = await ModelRuntime.create({ authPath: "/tmp/nano-vault-session-auth.json", modelsPath: null, refreshOnCreate: false });
	const model = runtime.getModel("openrouter", "deepseek/deepseek-v4.1-flash") as Model<Api>;
	const bodies: Record<string, unknown>[] = [];
	const fetchStub = (async (_url: unknown, init?: { body?: unknown }) => {
		bodies.push(JSON.parse(String(init?.body)));
		return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;
	const run = async (enabled: boolean, extra: object = {}) => {
		const options = withBodySessionId({ sessionId: "sess-123", ...extra }, enabled);
		const stream = streamSimple(model as Model<"openai-completions">, { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never, { ...options, apiKey: "vault-proxy", fetch: fetchStub });
		for await (const _ of stream) void _;
	};

	await run(true);
	assert.equal(bodies.at(-1)?.session_id, "sess-123");

	// An existing payload hook still runs first, and its replacement is kept.
	await run(true, { onPayload: (p: object) => ({ ...p, marker: 1 }) });
	assert.equal(bodies.at(-1)?.marker, 1);
	assert.equal(bodies.at(-1)?.session_id, "sess-123");

	// Not an OpenRouter connection: the body is untouched.
	await run(false);
	assert.equal("session_id" in (bodies.at(-1) ?? {}), false);

	// Over-long ids are cut to OpenRouter's 256-character limit.
	const long = withBodySessionId<{ sessionId?: string; onPayload?: (p: unknown, m: never) => unknown }>({ sessionId: "x".repeat(300) }, true);
	const sent = (await long?.onPayload?.({ a: 1 }, undefined as never)) as { session_id: string };
	assert.equal(sent.session_id.length, 256);
});
