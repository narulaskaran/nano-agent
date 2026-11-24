import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendJsonLine } from "./json-store.ts";
import { providerFetch, providerSettingsAvailable } from "./provider-client.ts";
import { isTransient } from "./transient.ts";

/**
 * Typed decisions from the decision model: any endpoint that speaks the System One API (`{model, state,
 * questions}` in, answers out), for example Jev on OpenRouter or a self-hosted Clef server.
 * One forward pass returns probabilities for declared answers instead of generated text, so code can
 * branch on them. Requests to OpenRouter always require zero data retention. The endpoint may be a
 * cloud service, so private material belongs with the local model (see local.ts).
 */

/** The decision model used with an OpenRouter key when no decision endpoint is set. */
export const DECIDE_MODEL = "typesafe/jev-1.14";
const OPENROUTER_DECISIONS = "https://openrouter.ai/api/v1/systemone";
/** OpenRouter's routing for decisions: zero data retention, no training on the request. */
const OPENROUTER_ZDR = { zdr: true, data_collection: "deny" };
/** Cap for the decision, router and gate logs. A log over this moves to `<path>.1`. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** `<data>/decisions.jsonl`. The only place that path is built. */
export function decisionLogPath(dataDir: string): string {
	return join(dataDir, "decisions.jsonl");
}

/**
 * Why `decide` failed, as data. Callers branch on `reason` and do not read the message.
 * - unconfigured: nothing to call (no vault route, decision URL or OpenRouter key)
 * - transient:    the call did not get an answer (network, timeout, 429, 5xx) and is worth retrying
 * - invalid:      the call returned something that is not a usable answer
 * - private:      the input was refused before any request, because this decider does not send private material
 */
export type DecisionErrorReason = "unconfigured" | "transient" | "invalid" | "private";

export class DecisionError extends Error {
	readonly reason: DecisionErrorReason;
	constructor(reason: DecisionErrorReason, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DecisionError";
		this.reason = reason;
	}
}

export type Question =
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| { type: "score"; instructions: string; criteria: string[] };

export interface DecisionRequest {
	/** What the questions are about: text, or a JSON object or array with named parts. */
	state: string | Record<string, unknown> | unknown[];
	questions: Record<string, Question>;
}

export type Answer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; confidence?: number | null; probabilities?: Record<string, number> }
	| { type: "score"; score: number; confidence?: number | null; legend?: Record<string, string>; probabilities?: Record<string, number> };

export interface DecisionResponse {
	model: string;
	answers: Record<string, Answer>;
	usage?: { input_tokens: number; output_tokens: number };
}

export type Transport = (body: string, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

/**
 * The vault's decision route when the vault runs (the key stays there). Otherwise NANO_DECIDE_URL with
 * NANO_DECIDE_MODEL and an optional NANO_DECIDE_API_KEY, or, with neither set, OpenRouter with
 * OPENROUTER_API_KEY and DECIDE_MODEL. Undefined when none of these is available.
 */
export function decisionTransport(env: NodeJS.ProcessEnv = process.env): Transport | undefined {
	if (providerSettingsAvailable()) {
		return async (body, signal) => {
			const response = await providerFetch("/providers/run/decide", body, signal);
			return { status: response.status, text: await response.text() };
		};
	}
	const custom = env.NANO_DECIDE_URL?.trim();
	const url = custom || (env.OPENROUTER_API_KEY?.trim() ? OPENROUTER_DECISIONS : undefined);
	const model = env.NANO_DECIDE_MODEL?.trim() || (custom ? undefined : DECIDE_MODEL);
	if (!url || !model) return undefined;
	const openRouter = isOpenRouter(url);
	const key = env.NANO_DECIDE_API_KEY?.trim() || (openRouter ? env.OPENROUTER_API_KEY?.trim() : undefined);
	return async (body, signal) => {
		const { state, questions } = JSON.parse(body) as DecisionRequest;
		const response = await fetch(url, {
			method: "POST",
			signal: signal ?? AbortSignal.timeout(60_000),
			headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
			// Other endpoints may reject fields they do not know, so only OpenRouter gets its routing field.
			body: JSON.stringify({ model, state, questions, ...(openRouter ? { provider: OPENROUTER_ZDR } : {}) }),
		});
		return { status: response.status, text: await response.text() };
	};
}

function isOpenRouter(url: string): boolean {
	try {
		return new URL(url).hostname === "openrouter.ai";
	} catch {
		return false;
	}
}

export function validateRequest(request: DecisionRequest): void {
	const { state, questions } = request;
	if (state === undefined || state === null || (typeof state === "string" && !state.trim())) throw new Error("a decision needs state to decide about");
	const entries = Object.entries(questions ?? {});
	if (entries.length === 0) throw new Error("a decision needs at least one question");
	for (const [id, q] of entries) {
		if (!q?.instructions?.trim()) throw new Error(`question ${id} needs instructions`);
		if (q.type === "choice" && Object.keys(q.criteria ?? {}).length < 2) throw new Error(`choice question ${id} needs at least two options`);
		if (q.type === "score" && (q.criteria ?? []).length < 2) throw new Error(`score question ${id} needs at least two levels`);
		if (!["noul", "choice", "score"].includes(q.type)) throw new Error(`question ${id} has unknown type ${String((q as { type?: unknown }).type)}`);
	}
}

/** One question from command-line style options: options make a choice, levels a score, neither a yes/no. */
export function buildQuestion(instruction: string, values: { yes?: string; no?: string; option?: string[]; level?: string[] }): Question {
	if (values.option?.length && values.level?.length) throw new Error("use --option or --level, not both");
	if (values.option?.length) {
		const criteria: Record<string, string> = {};
		for (const raw of values.option) {
			const at = raw.indexOf("=");
			const id = (at < 0 ? raw : raw.slice(0, at)).trim();
			if (!id) throw new Error(`bad --option ${raw}`);
			criteria[id] = (at < 0 ? id : raw.slice(at + 1)).trim() || id;
		}
		return { type: "choice", instructions: instruction, criteria };
	}
	if (values.level?.length) return { type: "score", instructions: instruction, criteria: values.level };
	const criteria = { ...(values.yes ? { true: values.yes } : {}), ...(values.no ? { false: values.no } : {}) };
	return { type: "noul", instructions: instruction, ...(Object.keys(criteria).length ? { criteria } : {}) };
}

export interface DecideOptions {
	transport?: Transport;
	/** JSONL audit log. Holds answers, probabilities and a hash of the state, never the state or question text. */
	logPath?: string;
	/** Who asked, for the log (a script name, a job id). */
	source?: string;
	signal?: AbortSignal;
	now?: () => number;
}

export async function decide(request: DecisionRequest, options: DecideOptions = {}): Promise<DecisionResponse> {
	validateRequest(request);
	// A transport key that is present and undefined means "there is no model", not "look one up".
	const transport = Object.hasOwn(options, "transport") ? options.transport : decisionTransport();
	if (!transport)
		throw new DecisionError(
			"unconfigured",
			"no decision model is configured: it needs a vault decision connection, NANO_DECIDE_URL with NANO_DECIDE_MODEL, or OPENROUTER_API_KEY",
		);
	const now = options.now ?? Date.now;
	const started = now();
	let out: { status: number; text: string };
	try {
		out = await transport(JSON.stringify({ state: request.state, questions: request.questions }), options.signal);
	} catch (error) {
		if (error instanceof DecisionError) throw error;
		throw new DecisionError(isTransientFailure(error) ? "transient" : "invalid", describeFailure(error), { cause: error });
	}
	if (out.status !== 200) {
		const message = `decision failed: HTTP ${out.status} ${out.text.slice(0, 300)}`;
		throw new DecisionError(out.status === 408 || out.status === 429 || out.status >= 500 ? "transient" : "invalid", message);
	}
	let parsed: DecisionResponse;
	try {
		parsed = JSON.parse(out.text) as DecisionResponse;
	} catch {
		throw new DecisionError("invalid", "decision failed: the response was not JSON");
	}
	for (const [id, q] of Object.entries(request.questions)) {
		const answer = parsed.answers?.[id];
		if (!answer || answer.type !== q.type) throw new DecisionError("invalid", `decision failed: no ${q.type} answer for ${id}`);
		if (answer.type === "choice" && !Object.hasOwn((q as { criteria: Record<string, string> }).criteria, answer.choice)) {
			throw new DecisionError("invalid", `decision failed: ${id} answered "${answer.choice}", which is not one of its options`);
		}
	}
	if (options.logPath) {
		appendJsonLine(
			options.logPath,
			{
				at: new Date(started).toISOString(),
				ms: now() - started,
				source: options.source,
				model: parsed.model,
				state: stateFingerprint(request.state),
				answers: parsed.answers,
				usage: parsed.usage,
			},
			"decision",
			LOG_MAX_BYTES,
		);
	}
	return parsed;
}

export interface DecisionCall {
	source?: string;
	signal?: AbortSignal;
	now?: () => number;
	/** This input is private and must not leave the machine when the decider refuses private input. */
	private?: boolean;
}

/**
 * One configured way to ask for a decision: the transport, the decisions log, and whether private input is refused.
 * Built once from config and shared by the router, the gate and failure triage.
 */
export interface Decider {
	/** Throws DecisionError reason "private" when this input must not be sent. */
	allow(input?: { private?: boolean }): void;
	decide(request: DecisionRequest, call?: DecisionCall): Promise<DecisionResponse>;
}

export function createDecider(options: { dataDir: string; transport?: Transport; refusePrivate?: boolean }): Decider {
	const explicitTransport = Object.hasOwn(options, "transport");
	const logPath = decisionLogPath(options.dataDir);
	const refusePrivate = options.refusePrivate ?? true;
	const allow = (input?: { private?: boolean }): void => {
		if (refusePrivate && input?.private) throw new DecisionError("private", "private input is not sent to the decision model");
	};
	return {
		allow,
		async decide(request, call = {}) {
			allow(call);
			const transport = explicitTransport ? options.transport : decisionTransport();
			return decide(request, { transport, logPath, source: call.source, signal: call.signal, now: call.now });
		},
	};
}

export interface Top {
	/** The chosen option id; "yes"/"no" for a yes/no question; the level number for a score. */
	label: string;
	/** Probability of that label. */
	p: number;
}

/** The most likely answer and its probability. */
export function top(answer: Answer): Top {
	if (answer.type === "noul") return answer.noul >= 0.5 ? { label: "yes", p: answer.noul } : { label: "no", p: 1 - answer.noul };
	if (answer.type === "choice") return { label: answer.choice, p: answer.probabilities?.[answer.choice] ?? answer.confidence ?? 0 };
	const probabilities = Object.entries(answer.probabilities ?? {});
	if (probabilities.length === 0) return { label: String(Math.round(answer.score)), p: answer.confidence ?? 0 };
	const [label, p] = probabilities.reduce((best, entry) => (entry[1] > best[1] ? entry : best));
	return { label, p };
}

/**
 * The answer's label when it is sure enough, otherwise undefined.
 * A number is one bar for every label. A record is the bar for each label, and a label with no entry is not confident.
 */
export function confident(answer: Answer | undefined, min: number | Record<string, number>): string | undefined {
	if (!answer) return undefined;
	const best = top(answer);
	const bar = typeof min === "number" ? min : min[best.label];
	if (bar === undefined || best.p < bar) return undefined;
	return best.label;
}

/** Text of a thrown failure, including a cause code, for the error message and the log. */
function describeFailure(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = (error as Error & { cause?: { code?: unknown; message?: unknown } }).cause;
	return [error.message, cause?.code, cause?.message].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
}

/** A thrown transport error that is a timeout or a network failure, rather than a bad answer. */
function isTransientFailure(error: unknown): boolean {
	const seen = new Set<unknown>();
	const visit = (value: unknown): boolean => {
		if (value === null || value === undefined || seen.has(value)) return false;
		if (typeof value !== "object") return typeof value === "string" && isTransient(value);
		seen.add(value);
		const record = value as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
		if (record.name === "TimeoutError" || record.name === "AbortError") return true;
		if (typeof record.code === "string" && isTransient(record.code)) return true;
		if (typeof record.message === "string" && isTransient(record.message)) return true;
		return visit(record.cause);
	};
	return visit(error);
}

export function stateFingerprint(state: DecisionRequest["state"]): { sha256: string; chars: number } {
	const text = typeof state === "string" ? state : JSON.stringify(state);
	return { sha256: createHash("sha256").update(text).digest("hex").slice(0, 16), chars: text.length };
}

