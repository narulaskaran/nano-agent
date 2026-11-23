import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Config, MAX_OUTPUT_TOKENS } from "./config.ts";
import { OPENROUTER_ZDR } from "./decide.ts";
import { refreshProviderSettings } from "./provider-settings.ts";

/**
 * Prefer these OpenRouter upstream providers (`NANO_OPENROUTER_PROVIDERS`), in order. Any other provider
 * still serves the request if they are all unavailable. Left to itself OpenRouter spreads the first
 * requests of a run across providers, and each one starts with a cold prompt cache billed at the full
 * input price.
 */
export function withProviderOrder(config: Config, model: Model<Api>): Model<Api> {
	if (model.provider !== "openrouter" || config.openRouterProviders.length === 0) return model;
	return withRouting(model, { order: config.openRouterProviders, allow_fallbacks: true });
}

function withRouting(model: Model<Api>, routing: object): Model<Api> {
	const compat = (model.compat ?? {}) as { openRouterRouting?: object };
	return { ...model, compat: { ...compat, openRouterRouting: { ...compat.openRouterRouting, ...routing } } } as Model<Api>;
}

/** The model with its reply ceiling lowered to MAX_OUTPUT_TOKENS. */
export function capOutput(model: Model<Api>): Model<Api> {
	return model.maxTokens > MAX_OUTPUT_TOKENS ? { ...model, maxTokens: MAX_OUTPUT_TOKENS } : model;
}

/** Whether the main model is served through OpenRouter, directly or through a vault connection. */
export function mainOnOpenRouter(config: Config): boolean {
	return config.modelProvider === "openrouter" || (config.modelProvider === "nano-vault-main" && config.mainCatalogProvider === "openrouter");
}

/**
 * Why private work cannot run right now, or undefined when it can. The one place the privacy rule lives:
 * private work runs only on the main model through OpenRouter with zero data retention required, so no
 * upstream that keeps or trains on the request can serve it. Any other main model refuses rather than
 * sending private material without that guarantee.
 */
export function privateRefusal(config: Config): string | undefined {
	return mainOnOpenRouter(config)
		? undefined
		: "This work is marked private, and private work runs only through OpenRouter with zero data retention. The main model is not on OpenRouter, so it was not run.";
}

/** The model with OpenRouter's zero-data-retention routing required. Endpoints that keep data are never used. */
export function withZeroRetention(model: Model<Api>): Model<Api> {
	return withRouting(model, OPENROUTER_ZDR);
}

/** The main model, with provider routing and the reply ceiling applied, and zero data retention when private. */
export function getMainModel(config: Config, runtime: ModelRuntime, { private: isPrivate = false } = {}): Model<Api> | undefined {
	const model = runtime.getModel(config.modelProvider, config.modelId);
	if (!model) return undefined;
	const routed = capOutput(withProviderOrder(config, model));
	return isPrivate ? withZeroRetention(routed) : routed;
}

export async function createModelRuntime(config: Config): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: join(config.dataDir, "pi", "auth.json"),
		modelsPath: join(config.dataDir, "pi", "models.json"),
	});
	await refreshProviderSettings(config, runtime);
	return runtime;
}

/** The model a worker runs on. Private work is refused unless zero data retention can be required. */
export function resolveModel(config: Config, runtime: ModelRuntime, isPrivate: boolean): { model: Model<Api>; label: string } {
	if (isPrivate) {
		const refusal = privateRefusal(config);
		if (refusal) throw new Error(refusal);
	}
	const model = getMainModel(config, runtime, { private: isPrivate });
	if (!model) throw new Error(`Unknown model ${config.modelProvider}/${config.modelId}`);
	return { model, label: `${config.modelProvider}/${config.modelId}${isPrivate ? ", zero data retention" : ""}` };
}
