import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.ts";
import { getMainModel, resolveModel, withProviderOrder } from "../src/models.ts";
import { createNanoSession } from "../src/session.ts";

const ENV = { NANO_CHANNEL: "stdin", NANO_MODEL: "openrouter/deepseek/deepseek-v4.1-flash", OPENROUTER_API_KEY: "test-key" };

test("OpenRouter providers are tried in the configured order; routing is unset by default", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nano-routing-"));
	try {
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const routing = (model: Model<Api> | undefined) => (model?.compat as { openRouterRouting?: unknown } | undefined)?.openRouterRouting;

		const plain = loadConfig({ ...ENV, NANO_DATA_DIR: dir });
		assert.deepEqual(plain.openRouterProviders, []);
		assert.equal(routing(getMainModel(plain, runtime)), undefined);

		const pinned = loadConfig({ ...ENV, NANO_DATA_DIR: dir, NANO_OPENROUTER_PROVIDERS: " OpenInference, Wafer ," });
		assert.deepEqual(pinned.openRouterProviders, ["OpenInference", "Wafer"]);
		const expected = { order: ["OpenInference", "Wafer"], allow_fallbacks: true };
		assert.deepEqual(routing(getMainModel(pinned, runtime)), expected);
		assert.deepEqual(routing(resolveModel(pinned, runtime, "main", false).model), expected);
		// The catalog model itself is not modified.
		assert.equal(routing(runtime.getModel("openrouter", "deepseek/deepseek-v4.1-flash")), undefined);

		// Only OpenRouter models are touched.
		const other = { provider: "deepseek", id: "x" } as Model<Api>;
		assert.equal(withProviderOrder(pinned, other), other);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session sends the provider order and its session id to OpenRouter", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nano-routing-"));
	const requests: { headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			requests.push({ headers: req.headers, body: JSON.parse(raw) });
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = { id: "g", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
			res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const previousKey = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "test-key";
	try {
		const config = loadConfig({ ...ENV, NANO_DATA_DIR: dir, NANO_OPENROUTER_PROVIDERS: "OpenInference,Wafer", NANO_THINKING: "off" });
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const routed = getMainModel(config, runtime);
		assert.ok(routed);
		const model = { ...routed, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` } as Model<Api>;
		const session = await createNanoSession({ config, modelRuntime: runtime, model, systemPrompt: "You are a test agent.", extensionFactories: [], sessionsDir: join(dir, "sessions") });
		await session.prompt("hello");
		await session.prompt("again");
		assert.equal(requests.length, 2);
		for (const r of requests) {
			assert.deepEqual(r.body.provider, { order: ["OpenInference", "Wafer"], allow_fallbacks: true });
			assert.equal(r.headers["x-session-id"], session.sessionId);
		}
		session.dispose();
	} finally {
		if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
		else process.env.OPENROUTER_API_KEY = previousKey;
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
