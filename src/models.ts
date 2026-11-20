import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { refreshProviderSettings } from "./provider-settings.ts";
import { type Config, MAX_OUTPUT_TOKENS } from "./config.ts";

/** Pi provider id under which `NANO_LOCAL_*` is registered. */
export const LOCAL_PROVIDER = "nano-local";

export type ModelRole = "main" | "local";

/**
 * Prefer these OpenRouter upstream providers (`NANO_OPENROUTER_PROVIDERS`), in order. Any other provider
 * still serves the request if they are all unavailable. Left to itself OpenRouter spreads the first
 * requests of a run across providers, and each one starts with a cold prompt cache billed at the full
 * input price.
 */
export function withProviderOrder(config: Config, model: Model<Api>): Model<Api> {
	if (model.provider !== "openrouter" || config.openRouterProviders.length === 0) return model;
	const compat = (model.compat ?? {}) as { openRouterRouting?: object };
	return {
		...model,
		compat: { ...compat, openRouterRouting: { ...compat.openRouterRouting, order: config.openRouterProviders, allow_fallbacks: true } },
	} as Model<Api>;
}

/** The model with its reply ceiling lowered to MAX_OUTPUT_TOKENS. */
export function capOutput(model: Model<Api>): Model<Api> {
	return model.maxTokens > MAX_OUTPUT_TOKENS ? { ...model, maxTokens: MAX_OUTPUT_TOKENS } : model;
}

/** The main model, with provider routing and the reply ceiling applied. */
export function getMainModel(config: Config, runtime: ModelRuntime): Model<Api> | undefined {
	const model = runtime.getModel(config.modelProvider, config.modelId);
	return model && capOutput(withProviderOrder(config, model));
}

export async function createModelRuntime(config: Config): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: join(config.dataDir, "pi", "auth.json"),
		modelsPath: join(config.dataDir, "pi", "models.json"),
	});
	if (config.local) {
		const { modelId, baseUrl, contextWindow } = config.local;
		runtime.registerProvider(LOCAL_PROVIDER, {
			name: "Local",
			baseUrl,
			api: "openai-completions",
			// Resolved from the environment at request time; local servers without auth ignore the dummy value.
			apiKey: config.local.apiKey ? "$NANO_LOCAL_API_KEY" : "local",
			models: [
				{
					id: modelId,
					name: `Local ${modelId}`,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: Math.min(8192, Math.floor(contextWindow / 4)),
				},
			],
		});
	}
	await refreshProviderSettings(config, runtime);
	return runtime;
}

/**
 * Which model a piece of work runs on. The one place the privacy rule lives:
 * - "local" work falls back to the main model when no local model is configured, and says so;
 * - private work never falls back. It runs locally or not at all, so private data cannot reach the cloud by accident.
 */
export function chooseModel(
	role: ModelRole,
	isPrivate: boolean,
	localConfigured: boolean,
): { use: ModelRole; note?: string } | { refuse: string } {
	if (role === "local" || isPrivate) {
		if (localConfigured) return { use: "local" };
		if (isPrivate) return { refuse: "This work is marked private and no local model is configured (NANO_LOCAL_MODEL), so it was not run rather than sent to the cloud model." };
		return { use: "main", note: "No local model is configured, so this ran on the main model." };
	}
	return { use: "main" };
}

export function resolveModel(
	config: Config,
	runtime: ModelRuntime,
	role: ModelRole,
	isPrivate: boolean,
): { model: Model<Api>; label: string; note?: string } {
	const choice = chooseModel(role, isPrivate, Boolean(config.local));
	if ("refuse" in choice) throw new Error(choice.refuse);
	const [provider, id] =
		choice.use === "local" && config.local ? [config.local.vault ? "nano-vault-local" : LOCAL_PROVIDER, config.local.modelId] : [config.modelProvider, config.modelId];
	const found = runtime.getModel(provider, id);
	if (!found) throw new Error(`Unknown model ${provider}/${id}`);
	const model = capOutput(withProviderOrder(config, found));
	return { model, label: choice.use === "local" ? `local ${id}` : `${provider}/${id}`, note: choice.note };
}
