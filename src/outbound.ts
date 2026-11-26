import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { Channel } from "./channel.ts";
import { createQueue, type Job, type Queue } from "./queue.ts";

/**
 * Owner messages Nano sends outside a live reply (reminders, job output, notices from packs) go through this durable
 * queue instead of straight to the channel. Each send carries a stable Photon `clientMessageId`
 * (patches/spectrum-imessage-send-ids.mjs), so a retry after a timeout or a restart cannot post the message twice: the
 * server answers a repeat with `duplicateMessage`, which counts as delivered. Errors that cannot succeed (an unknown
 * chat, a rejected login, bad input) give up at once; anything else is retried with backoff for RETRY_WINDOW_MS. On give-up
 * the owner gets one short "couldn't deliver" notice, which is itself never followed by another.
 */

export const OUTBOUND_TABLE = "outbound";
export const RETRY_WINDOW_MS = 10 * 60_000;

export interface OutboundPayload {
	spaceId: string;
	text: string;
	/** A give-up notice: never followed by another. */
	notice?: boolean;
}

/** Read by the patched adapter. Published under a global symbol so the patch needs no import. */
export const sendIds = new AsyncLocalStorage<{ clientMessageId: string }>();
(globalThis as Record<symbol, unknown>)[Symbol.for("nano.sendIds")] = sendIds;

/** The same chat written two ways (`any;-;+1555…` and `+1555…`) is one key, so its messages stay in order. */
export function outboundKey(spaceId: string): string {
	const phone = /^(?:any;-;)?(\+\d{6,})$/.exec(spaceId)?.[1];
	return (phone ?? spaceId).toLowerCase();
}

/** Every code and name along an error's cause chain. */
function errorCodes(error: unknown): string[] {
	const codes: string[] = [];
	for (let e = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
		for (const value of [e.code, e.name]) if (typeof value === "string") codes.push(value);
		if (typeof e.message === "string" && /cannot resolve conversation/.test(e.message)) codes.push("cannotResolve");
	}
	return codes;
}

/** The server already has a message with this clientMessageId: the first attempt was delivered. */
export function isDuplicateSend(error: unknown): boolean {
	return errorCodes(error).includes("duplicateMessage");
}

const DEFINITE = new Set([
	"ValidationError", "NotFoundError", "AuthenticationError", "invalidArgument", "chatNotFound", "addressNotFound",
	"unauthorized", "tokenBlocked", "preconditionFailed", "operationNotSupported", "cannotResolve",
]);

/** An error a retry cannot fix. */
export function isDefiniteSendFailure(error: unknown): boolean {
	return errorCodes(error).some((code) => DEFINITE.has(code));
}

export function outboundRetry(job: Job<unknown>, error: unknown, now: number): number | undefined {
	if (isDefiniteSendFailure(error)) return undefined;
	const delay = Math.min(60_000, 2000 * 2 ** (job.attempts - 1));
	return now + delay - job.createdAt > RETRY_WINDOW_MS ? undefined : delay;
}

export interface Outbound {
	/** Queue `text` for `spaceId`. A repeated `dedupe` is ignored. */
	send(spaceId: string, text: string, dedupe?: string): void;
	run(signal: AbortSignal): Promise<void>;
	readonly queue: Queue<OutboundPayload>;
}

export function createOutbound(options: {
	db: DatabaseSync;
	channel: Pick<Channel, "send">;
	/** After a send is confirmed: record it in the conversation. Errors here are logged, never retried. */
	delivered?: (spaceId: string, text: string) => Promise<void> | void;
	timeoutMs?: number;
	now?: () => number;
}): Outbound {
	const queue: Queue<OutboundPayload> = createQueue<OutboundPayload>({
		db: options.db,
		table: OUTBOUND_TABLE,
		concurrency: 4,
		timeoutMs: options.timeoutMs ?? 90_000,
		now: options.now,
		retry: outboundRetry,
		async handler(job) {
			const { spaceId, text } = job.payload;
			// Stable for this job across retries and restarts, and unique across database resets.
			const clientMessageId = `nano-${job.createdAt.toString(36)}-${job.id}`;
			try {
				await sendIds.run({ clientMessageId }, () => options.channel.send(spaceId, text));
			} catch (error) {
				if (!isDuplicateSend(error)) {
					console.error(`nano: owner message ${job.id} not sent (attempt ${job.attempts + 1}):`, (error as Error)?.message ?? error);
					throw error;
				}
			}
			try {
				await options.delivered?.(spaceId, text);
			} catch (error) {
				console.error("nano: could not record a delivered message:", (error as Error)?.message ?? error);
			}
		},
		onGiveUp(job, error) {
			const { spaceId, text, notice } = job.payload;
			console.error(`nano: gave up on owner message ${job.id} after ${job.attempts} attempt(s): ${(error as Error)?.message ?? error}`);
			if (notice) return;
			const clipped = text.replace(/\s+/g, " ").trim().slice(0, 300);
			queue.enqueue({ key: outboundKey(spaceId), payload: { spaceId, text: `I couldn't deliver a message earlier: ${clipped}`, notice: true }, dedupe: `giveup:${job.id}:${job.createdAt}` });
		},
	});
	return {
		queue,
		send(spaceId, text, dedupe) {
			queue.enqueue({ key: outboundKey(spaceId), payload: { spaceId, text }, dedupe });
		},
		run: (signal) => queue.run(signal),
	};
}
