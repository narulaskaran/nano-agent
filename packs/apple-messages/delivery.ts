import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import type { PackServiceContext } from "../../src/packs.ts";
import { loadHistory, sendReply } from "./client.ts";
import { draftReply, type ReplyJob, UNAVAILABLE, violationDescription } from "./reply.ts";
import { chatNotes, chatState, REPLY_MAX_AGE } from "./state.ts";

async function processReply(db: DatabaseSync, job: ReplyJob, ctx: PackServiceContext, denied: (chat: string) => boolean): Promise<void> {
	const { id, chat } = job;
	const remove = () => db.prepare("DELETE FROM side_replies WHERE id = ?").run(id);
	const active = () => {
		const state = chatState(db, chat);
		return !ctx.signal.aborted && !denied(chat) && state?.enabled === 1 && !state.paused &&
			Date.now() - job.sent_at <= REPLY_MAX_AGE &&
			!!db.prepare("SELECT 1 FROM side_replies WHERE id = ?").get(id);
	};
	async function finish(notice: string | null): Promise<void> {
		// Clear the outgoing body so a private notification retry never sends another group reply.
		if (!notice) {
			remove();
			return;
		}
		db.prepare("UPDATE side_replies SET outgoing = NULL, body = '', notice = ? WHERE id = ?").run(notice, id);
		try {
			await ctx.notifyOwner(notice);
			remove();
		} catch {
			if (ctx.signal.aborted) return;
			if (job.attempts >= 2) {
				console.warn(`nano: Apple Messages owner alert failed for message ${id}`);
				remove();
			} else {
				db.prepare("UPDATE side_replies SET attempts = attempts + 1, due_at = ? WHERE id = ?").run(Date.now() + 2000, id);
			}
		}
	}
	async function reconcile(): Promise<void> {
		const found = job.outgoing && await loadHistory(chat, 40, AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]))
			.then((history) => history.some((message) => message.id > id && message.is_from_me && message.text?.trim() === job.outgoing &&
				Date.parse(message.created_at ?? "") >= job.attempt_at! - 2000))
			.catch(() => false);
		if (ctx.signal.aborted) return;
		if (found) {
			console.info(`nano: Apple Messages reply confirmed in history for message ${id}`);
			await finish(job.notice);
			return;
		}
		console.warn(`nano: Apple Messages reply delivery uncertain for message ${id}`);
		await finish([job.notice, `I couldn’t confirm side-chat reply delivery for Messages message ${id}.`].filter(Boolean).join("\n"));
	}

	if (job.attempt_at !== null) {
		if (job.outgoing) await reconcile();
		else await finish(job.notice);
		return;
	}
	if (!active()) {
		if (!ctx.signal.aborted) remove();
		return;
	}

	let outcome;
	try {
		outcome = await draftReply(job, chatNotes(db, chat, 15), ctx, AbortSignal.any([ctx.signal, AbortSignal.timeout(90_000)]), active);
	} catch {
		if (ctx.signal.aborted) return;
		if (job.attempts < 2) {
			db.prepare("UPDATE side_replies SET attempts = attempts + 1, due_at = ? WHERE id = ?").run(Date.now() + 2000, id);
			return;
		}
		outcome = { text: UNAVAILABLE, kind: "unavailable" } as const;
	}
	if (!outcome || !active()) {
		if (!ctx.signal.aborted) remove();
		return;
	}
	const reason = "reason" in outcome ? outcome.reason : undefined;
	const notice = outcome.kind === "decline"
		? `I declined a side-chat reply for Messages message ${id}. Reason: ${violationDescription(reason ?? "policy")}` : null;
	const outgoing = `🤖 ${outcome.text}`;
	const attempt_at = Date.now();
	const claimed = db.prepare(`UPDATE side_replies SET outgoing = ?, attempt_at = ?, notice = ?, attempts = 0, body = ''
		WHERE id = ? AND attempt_at IS NULL
		AND EXISTS (SELECT 1 FROM side_chats WHERE chat = side_replies.chat AND enabled = 1 AND paused = 0)`)
		.run(outgoing, attempt_at, notice, id).changes;
	if (!claimed) return;
	job = { ...job, outgoing, attempt_at, notice, attempts: 0 };
	try {
		await sendReply(chat, outgoing, AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]));
	} catch {
		if (ctx.signal.aborted) return;
		// Leave time for Messages to index a possibly successful send, then check the source chat.
		db.prepare("UPDATE side_replies SET due_at = ? WHERE id = ?").run(Date.now() + 2000, id);
		return;
	}
	console.info(`nano: Apple Messages reply sent for message ${id} (${outcome.kind}${reason ? `: ${reason}` : ""})`);
	await finish(notice);
}

export async function runReplies(db: DatabaseSync, ctx: PackServiceContext, denied: (chat: string) => boolean): Promise<void> {
	const next = db.prepare(`SELECT * FROM side_replies AS job WHERE due_at <= ?
		AND id = (SELECT MIN(id) FROM side_replies WHERE chat = job.chat) ORDER BY id`);
	const running = new Map<string, Promise<void>>();
	try {
		while (!ctx.signal.aborted) {
			for (const job of next.all(Date.now()) as ReplyJob[]) {
				if (running.size >= 4) break;
				const key = job.chat.toLowerCase();
				if (running.has(key)) continue;
				running.set(key, processReply(db, job, ctx, denied).catch(() => {
					db.prepare("UPDATE side_replies SET due_at = ? WHERE id = ?").run(Date.now() + 5000, job.id);
					console.error(`nano: Apple Messages reply worker failed for message ${job.id}`);
				}).finally(() => running.delete(key)));
			}
			await sleep(250, undefined, { signal: ctx.signal }).catch(() => {});
		}
	} finally {
		await Promise.allSettled(running.values());
	}
}
