import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { providerFetch, providerSettingsAvailable } from "./provider-client.ts";

/**
 * Typed decisions from a System One model (TypeSafe's Jev) through OpenRouter's `/systemone` API.
 * One forward pass returns probabilities for declared answers instead of generated text, so code can
 * branch on them. Every request requires zero data retention. This is still a cloud call: private
 * material belongs with the local model (see local.ts).
 */

export const DECIDE_MODEL = "typesafe/jev-1.14";
const OPENROUTER_SYSTEM_ONE = "https://openrouter.ai/api/v1/systemone";
const LOG_MAX_BYTES = 5 * 1024 * 1024;

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
 * The vault's decision route when the vault runs (the key stays there), otherwise OpenRouter directly
 * with OPENROUTER_API_KEY. Undefined when neither is available.
 */
export function decisionTransport(env: NodeJS.ProcessEnv = process.env): Transport | undefined {
	if (providerSettingsAvailable()) {
		return async (body, signal) => {
			const response = await providerFetch("/providers/run/decide", body, signal);
			return { status: response.status, text: await response.text() };
		};
	}
	const key = env.OPENROUTER_API_KEY?.trim();
	if (!key) return undefined;
	const model = env.NANO_DECIDE_MODEL?.trim() || DECIDE_MODEL;
	return async (body, signal) => {
		const { state, questions } = JSON.parse(body) as DecisionRequest;
		const response = await fetch(OPENROUTER_SYSTEM_ONE, {
			method: "POST",
			signal: signal ?? AbortSignal.timeout(60_000),
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ model, state, questions, provider: { zdr: true, data_collection: "deny" } }),
		});
		return { status: response.status, text: await response.text() };
	};
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
	const transport = options.transport ?? decisionTransport();
	if (!transport) throw new Error("no decision model is configured: it needs the vault's OpenRouter connection or OPENROUTER_API_KEY");
	const now = options.now ?? Date.now;
	const started = now();
	const out = await transport(JSON.stringify({ state: request.state, questions: request.questions }), options.signal);
	if (out.status !== 200) throw new Error(`decision failed: HTTP ${out.status} ${out.text.slice(0, 300)}`);
	let parsed: DecisionResponse;
	try {
		parsed = JSON.parse(out.text) as DecisionResponse;
	} catch {
		throw new Error("decision failed: the response was not JSON");
	}
	for (const [id, q] of Object.entries(request.questions)) {
		const answer = parsed.answers?.[id];
		if (!answer || answer.type !== q.type) throw new Error(`decision failed: no ${q.type} answer for ${id}`);
		if (answer.type === "choice" && !Object.hasOwn((q as { criteria: Record<string, string> }).criteria, answer.choice)) {
			throw new Error(`decision failed: ${id} answered "${answer.choice}", which is not one of its options`);
		}
	}
	if (options.logPath) {
		logDecision(options.logPath, {
			at: new Date(started).toISOString(),
			ms: now() - started,
			source: options.source,
			model: parsed.model,
			state: stateFingerprint(request.state),
			answers: parsed.answers,
			usage: parsed.usage,
		});
	}
	return parsed;
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

export function stateFingerprint(state: DecisionRequest["state"]): { sha256: string; chars: number } {
	const text = typeof state === "string" ? state : JSON.stringify(state);
	return { sha256: createHash("sha256").update(text).digest("hex").slice(0, 16), chars: text.length };
}

function logDecision(path: string, entry: object): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		try {
			if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
		} catch {}
		appendFileSync(path, `${JSON.stringify(entry)}\n`);
	} catch (error) {
		console.error("nano: decision log not written:", (error as Error)?.message ?? error);
	}
}
