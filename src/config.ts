import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ceiling on one reply, in tokens. Without it the request asks for the model's whole output allowance
 * (almost a million tokens on some models), and OpenRouter reserves the worst-case cost of that against
 * the API key's remaining spend limit, answering 402 once the limit is within reach of that reserve.
 */
export const MAX_OUTPUT_TOKENS = 65_536;
export const DEFAULT_LOCAL_CONTEXT = 32_768;

const INBOUND_MODES = ["interrupt", "steer", "queue"] as const;

export interface Config {
	channel: "photon" | "stdin";
	photonProjectId: string;
	photonProjectSecret: string;
	/** Senders allowed to talk to Nano (E.164 phone numbers or handles). */
	allowedUsers: string[];
	/** Where proactive messages go. Defaults to the first allowed user. */
	owner: string;
	modelProvider: string;
	modelId: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high";
	/** OpenRouter upstream providers to try in order. Empty leaves routing to OpenRouter. */
	openRouterProviders: string[];
	/** Hours of silence after which the next message starts a fresh context window. */
	idleHours: number;
	/**
	 * What an owner message does when a turn is already running: "interrupt" cancels a reply still
	 * being written and answers both, otherwise steers; "steer" only joins at the next model call;
	 * "queue" waits for a turn of its own.
	 */
	inbound: (typeof INBOUND_MODES)[number];
	/** Route each owner message with a decision first (router.ts). Off when no decision model is configured. */
	router: boolean;
	/** File lasting facts in the background (capture.ts). Off falls back to main-turn hints / Gmail agent handoff. */
	capture: boolean;
	/** The router may start a fresh context window for a new topic only after this many quiet minutes. */
	topicIdleMinutes: number;
	dataDir: string;
	kbDir: string;
	profileDir: string;
	appDir: string;
	packs: string[];
	braveApiKey?: string;
	/** Optional second model on an OpenAI-compatible endpoint the owner runs (llama.cpp, Ollama, ...). */
	local?: LocalModel;
	/** Optional owner-configured background model. */
	background?: { provider: string; modelId: string };
	/** Non-secret revision used to refresh an existing conversation model. */
	providerRevision?: string;
	/** Background tasks that may run at once; more wait in a queue. */
	maxTasks: number;
	/** Trusted local event spools. Events are acknowledged after delivery. */
	eventOutboxDirs?: string[];
	/** A background task still running after this long is stopped and reported as failed. */
	taskTimeoutMs: number;
}

export interface LocalModel {
	/** Route this connection through the vault rather than direct HTTP. */
	vault?: boolean;
	modelId: string;
	/** OpenAI-compatible base URL ending in /v1. */
	baseUrl: string;
	apiKey?: string;
	contextWindow: number;
}

/** Local model routed through the vault daemon's `local` role. */
export function vaultLocalModel(route: { model: string; contextWindow?: number }): LocalModel {
	return {
		modelId: route.model,
		baseUrl: "http://nano-vault/local",
		contextWindow: route.contextWindow || DEFAULT_LOCAL_CONTEXT,
		vault: true,
	};
}

/** The local model role from the environment, or undefined when it is not configured. */
export function loadLocalModel(env: NodeJS.ProcessEnv = process.env): LocalModel | undefined {
	const modelId = env.NANO_LOCAL_MODEL?.trim();
	const baseUrl = env.NANO_LOCAL_BASE_URL?.trim().replace(/\/+$/, "");
	if (!modelId || !baseUrl) return undefined;
	return { modelId, baseUrl, apiKey: env.NANO_LOCAL_API_KEY || undefined, contextWindow: Number(env.NANO_LOCAL_CONTEXT || DEFAULT_LOCAL_CONTEXT) };
}

function flagEnabled(value: string | undefined): boolean {
	return !/^(off|0|false|no)$/i.test(value?.trim() ?? "");
}

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const dataDir = resolve(env.NANO_DATA_DIR ?? join(appDir, "data"));
	const channel = env.NANO_CHANNEL === "stdin" ? "stdin" : "photon";
	const allowedUsers = list(env.NANO_ALLOWED_USERS);
	const [modelProvider, ...rest] = (env.NANO_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash").split("/");
	const thinking = (env.NANO_THINKING ?? "low") as Config["thinking"];

	const config: Config = {
		channel,
		photonProjectId: env.PHOTON_PROJECT_ID ?? "",
		photonProjectSecret: env.PHOTON_PROJECT_SECRET ?? "",
		allowedUsers,
		owner: env.NANO_OWNER ?? allowedUsers[0] ?? "",
		modelProvider: modelProvider ?? "openrouter",
		modelId: rest.join("/"),
		thinking,
		openRouterProviders: list(env.NANO_OPENROUTER_PROVIDERS),
		idleHours: Number(env.NANO_IDLE_HOURS ?? 4),
		inbound: (env.NANO_INBOUND?.trim().toLowerCase() || "interrupt") as Config["inbound"],
		router: flagEnabled(env.NANO_ROUTER),
		capture: flagEnabled(env.NANO_CAPTURE),
		topicIdleMinutes: Math.max(0, Number(env.NANO_TOPIC_IDLE_MINUTES ?? 20)),
		dataDir,
		kbDir: resolve(env.NANO_KB_DIR ?? join(dataDir, "kb")),
		profileDir: resolve(env.NANO_PROFILE_DIR ?? join(dataDir, "profile")),
		appDir,
		packs: list(env.NANO_PACKS ?? "core"),
		braveApiKey: env.BRAVE_SEARCH_API_KEY || undefined,
		local: loadLocalModel(env),
		eventOutboxDirs: list(env.NANO_EVENT_OUTBOX_DIRS).map((path) => resolve(path)),
		maxTasks: Math.max(1, Number(env.NANO_MAX_TASKS || 3)),
		taskTimeoutMs: Math.max(1, Number(env.NANO_TASK_TIMEOUT_MINUTES || 30)) * 60_000,
	};

	const problems: string[] = [];
	if (!config.modelId) problems.push("NANO_MODEL must look like provider/model-id");
	if (Boolean(env.NANO_LOCAL_MODEL?.trim()) !== Boolean(env.NANO_LOCAL_BASE_URL?.trim())) {
		problems.push("NANO_LOCAL_MODEL and NANO_LOCAL_BASE_URL must be set together");
	}
	if (!INBOUND_MODES.includes(config.inbound)) problems.push(`NANO_INBOUND must be one of: ${INBOUND_MODES.join(", ")}`);
	if (config.local && !(config.local.contextWindow > 0)) problems.push("NANO_LOCAL_CONTEXT must be a number of tokens");
	if (channel === "photon") {
		if (!config.photonProjectId) problems.push("PHOTON_PROJECT_ID is not set");
		if (!config.photonProjectSecret) problems.push("PHOTON_PROJECT_SECRET is not set");
		if (allowedUsers.length === 0) problems.push("NANO_ALLOWED_USERS is empty (your phone number, E.164)");
	}
	if (problems.length > 0) {
		throw new Error(`Nano is not configured:\n- ${problems.join("\n- ")}\nSee .env.example.`);
	}

	for (const dir of ["pi", "sessions", "workspace", "inbox", "log"]) {
		mkdirSync(join(dataDir, dir), { recursive: true });
	}
	mkdirSync(config.kbDir, { recursive: true });
	mkdirSync(config.profileDir, { recursive: true });
	return config;
}

export function readIfExists(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

let syncedTimezone: string | undefined;

function validZone(tz: unknown): tz is string {
	if (typeof tz !== "string" || !tz) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Optional: follow an external source of truth for the owner's timezone (for example a service
 * that switches zones when they travel). `NANO_TZ_URL` must return `{"timezone": "<IANA zone>"}`.
 */
export function startTimezoneSync(url: string | undefined, everyMs = 5 * 60_000): void {
	if (!url) return;
	const refresh = async () => {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
			const tz = ((await response.json()) as { timezone?: unknown }).timezone;
			if (validZone(tz)) syncedTimezone = tz;
		} catch {
			// keep the last known zone
		}
	};
	void refresh();
	setInterval(() => void refresh(), everyMs).unref();
}

interface TimezoneCache {
	mtimeMs: number | null;
	envTz: string;
	zone: string;
}

/** Validated zone for one data dir, keyed by `settings.json`'s mtime. Unused while a timezone URL sync is active. */
const timezoneCache = new Map<string, TimezoneCache>();

const localStampFormatters = new Map<string, Intl.DateTimeFormat>();

function localStampFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = localStampFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			weekday: "short",
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		});
		localStampFormatters.set(timeZone, formatter);
	}
	return formatter;
}

/** Timezone the owner is in: the synced source if any, then `settings.json` from onboarding, then TZ. */
export function currentTimezone(config: Config): string {
	if (syncedTimezone) return syncedTimezone;
	const path = join(config.dataDir, "settings.json");
	const envTz = process.env.TZ || "UTC";
	let mtimeMs: number | null = null;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		mtimeMs = null;
	}
	const cached = timezoneCache.get(config.dataDir);
	if (cached && cached.mtimeMs === mtimeMs && cached.envTz === envTz) return cached.zone;
	let zone = envTz;
	if (mtimeMs !== null) {
		try {
			const tz = (JSON.parse(readFileSync(path, "utf8")) as { timezone?: unknown }).timezone;
			if (validZone(tz)) zone = tz;
		} catch {
			// fall through to the environment
		}
	}
	timezoneCache.set(config.dataDir, { mtimeMs, envTz, zone });
	return zone;
}

export function localStamp(config: Config, at: Date = new Date()): string {
	return localStampFormatter(currentTimezone(config)).format(at);
}

/** YYYY-MM-DD in the owner's current timezone. */
export function localDate(config: Config, at: Date | number = Date.now()): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: currentTimezone(config) }).format(at);
}
