import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig, MAX_OUTPUT_TOKENS } from "../src/config.ts";
import { applyProviderSettings, type ProviderSettings } from "../src/provider-settings.ts";
import { getMainModel, resolveModel } from "../src/models.ts";

test("owner settings replace main, local and background independently and restore environment defaults", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nano-role-settings-"));
	try {
		const config = loadConfig({
			NANO_CHANNEL: "stdin",
			NANO_DATA_DIR: dir,
			NANO_MODEL: "deepseek/deepseek-flash",
			NANO_LOCAL_MODEL: "original-local",
			NANO_LOCAL_BASE_URL: "http://127.0.0.1:8090/v1",
		});
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const settings: ProviderSettings = {
			providers: [
				{ id: "hosted", capabilities: ["chat"], local: false },
				{ id: "local", capabilities: ["chat"], local: true },
			],
			roles: {
				main: { provider: "hosted", model: "main-fixture", contextWindow: 65536 },
				local: { provider: "local", model: "local-fixture", contextWindow: 32768 },
				background: { provider: "hosted", model: "task-fixture", contextWindow: 16384 },
			},
		};
		applyProviderSettings(config, runtime, settings);
		assert.equal(config.modelProvider, "nano-vault-main");
		assert.equal(config.modelId, "main-fixture");
		assert.equal(config.background?.modelId, "task-fixture");
		assert.equal(config.local?.vault, true);
		assert.equal(resolveModel(config, runtime, "local", true).model.id, "local-fixture");
		const original = runtime.getModel(config.modelProvider, config.modelId);
		applyProviderSettings(config, runtime, settings);
		assert.deepEqual(runtime.getModel(config.modelProvider, config.modelId), original);
		settings.roles.main!.model = "changed-fixture";
		applyProviderSettings(config, runtime, settings);
		assert.equal(config.modelId, "changed-fixture");
		applyProviderSettings(config, runtime, { providers: [], roles: {} });
		assert.equal(config.modelProvider, "deepseek");
		assert.equal(config.modelId, "deepseek-flash");
		assert.equal(config.local?.modelId, "original-local");
		assert.equal(config.background, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replies are capped so OpenRouter does not reserve a whole output allowance against a key limit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nano-cap-"));
	try {
		const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dir, NANO_MODEL: "openrouter/deepseek/deepseek-v4.1-flash" });
		const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const catalog = runtime.getModel("openrouter", "deepseek/deepseek-v4.1-flash");
		assert.ok(catalog && catalog.maxTokens > MAX_OUTPUT_TOKENS);
		// Direct OpenRouter model.
		assert.equal(getMainModel(config, runtime)?.maxTokens, MAX_OUTPUT_TOKENS);
		assert.equal(resolveModel(config, runtime, "main", false).model.maxTokens, MAX_OUTPUT_TOKENS);
		// Model assigned in the vault portal, taking its limits from the catalog.
		applyProviderSettings(config, runtime, {
			providers: [{ id: "or", capabilities: ["chat"], local: false, catalogProvider: "openrouter" }],
			roles: { main: { provider: "or", model: "deepseek/deepseek-v4.1-flash", contextWindow: 1048576 } },
		});
		assert.equal(runtime.getModel("nano-vault-main", "deepseek/deepseek-v4.1-flash")?.maxTokens, MAX_OUTPUT_TOKENS);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
