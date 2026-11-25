import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Config, DEFAULT_LOCAL_CONTEXT, MAX_OUTPUT_TOKENS, vaultLocalModel } from "./config.ts";
import { providerFetch, providerSettingsAvailable, roleFetch } from "./provider-client.ts";

interface Route {
	provider: string;
	model: string;
	contextWindow: number;
}
export interface ProviderSettings {
	providers: { id: string; local: boolean; capabilities: string[]; catalogProvider?: string }[];
	roles: Partial<Record<"main" | "background" | "local", Route>>;
}
/**
 * The vault daemon forwards only the request body, so the `x-session-id` header Pi sends is lost before
 * it reaches OpenRouter. The same id in the body (`session_id`) keeps a run's requests on the provider
 * that holds its prompt cache.
 */
export function withBodySessionId<T extends { sessionId?: string; onPayload?: (payload: unknown, model: never) => unknown }>(options: T | undefined, enabled: boolean): T | undefined {
	if (!enabled || !options?.sessionId) return options;
	const { sessionId, onPayload } = options;
	return {
		...options,
		onPayload: async (payload: unknown, model: never) => {
			const next = (await onPayload?.(payload, model)) ?? payload;
			return next && typeof next === "object" && !Array.isArray(next) ? { ...next, session_id: sessionId.slice(0, 256) } : next;
		},
	};
}

const states = new WeakMap<Config, { signature: string; main: [string, string]; local: Config["local"] }>();

/** Read metadata each turn. Endpoint and key selection remain inside the daemon. */
export async function refreshProviderSettings(config: Config, runtime: ModelRuntime): Promise<void> {
	if (!config.packs.includes("vault") || !providerSettingsAvailable()) return;
	const response = await providerFetch("/providers/config");
	if (!response.ok) throw new Error("Could not load provider settings");
	const settings = (await response.json()) as ProviderSettings;
	applyProviderSettings(config, runtime, settings);
}

/** Apply a non-secret snapshot without changing a running request. */
export function applyProviderSettings(config: Config, runtime: ModelRuntime, settings: ProviderSettings): void {
	let state = states.get(config);
	if (!state) {
		state = { signature: "", main: [config.modelProvider, config.modelId], local: config.local };
		states.set(config, state);
	}
	const signature = JSON.stringify(settings);
	if (signature === state.signature) return;
	const roles = { ...settings.roles, background: settings.roles.background ?? settings.roles.main };
	for (const role of ["main", "background", "local"] as const) {
		const route = roles[role];
		if (!route) continue;
		const connection = settings.providers.find((p) => p.id === route.provider);
		if (!connection?.capabilities.includes("chat") || (role === "local" && !connection.local))
			throw new Error("Invalid provider role settings");
		const provider = `nano-vault-${role}`;
		const contextWindow = route.contextWindow || DEFAULT_LOCAL_CONTEXT;
		const source = connection.catalogProvider ? runtime.getModel(connection.catalogProvider, route.model) : undefined;
		runtime.registerProvider(provider, {
			name: `Owner configured ${role}`,
			baseUrl: `http://nano-vault/${role}`,
			api: "openai-completions",
			apiKey: "vault-proxy",
			streamSimple: (model, context, options) =>
				streamSimple(model as Model<"openai-completions">, context, {
					...withBodySessionId(options, connection.catalogProvider === "openrouter"),
					apiKey: "vault-proxy",
					fetch: roleFetch(role),
				}),
			models: [
				{
					id: route.model,
					name: route.model,
					reasoning: source?.reasoning ?? false,
					thinkingLevelMap: source?.thinkingLevelMap,
					input: source?.input ?? ["text", "image"],
					contextWindow,
					maxTokens: Math.min(source?.maxTokens ?? 8192, contextWindow, MAX_OUTPUT_TOKENS),
					cost: source?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: source?.compat ?? { supportsDeveloperRole: false },
				},
			],
		});
	}
	[config.modelProvider, config.modelId] = settings.roles.main ? ["nano-vault-main", settings.roles.main.model] : state.main;
	config.background = roles.background ? { provider: "nano-vault-background", modelId: roles.background.model } : undefined;
	config.local = settings.roles.local ? vaultLocalModel(settings.roles.local) : state.local;
	config.providerRevision = signature;
	state.signature = signature;
}
