import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * A small durable job queue in SQLite. Jobs survive a restart, are retried with backoff, and run one at a time per key,
 * in the order they were added. A finished job stays as a tombstone for a while, its payload cleared, so a producer that
 * crashed before recording its own progress cannot enqueue the same `dedupe` key again.
 *
 * One process runs a queue's handlers; other processes may only enqueue (`enqueueJob`). Handlers never hold a
 * transaction across an await: node:sqlite has one connection, and statements from another job would join it.
 */

export interface Job<P = unknown> {
	id: number;
	key: string;
	dedupe: string | null;
	payload: P;
	attempts: number;
	/** When the job was first added. */
	createdAt: number;
	dueAt: number;
}

export interface EnqueueOptions<P> {
	/** Jobs with the same key run one at a time, oldest first. */
	key: string;
	payload: P;
	/** A second enqueue with the same value is ignored, also after the first has finished (until it is pruned). */
	dedupe?: string;
	dueAt?: number;
}

export interface QueueOptions<P> {
	db: DatabaseSync;
	table: string;
	/** Resolves when the job is done. A throw goes to `retry`. */
	handler: (job: Job<P>, signal: AbortSignal) => Promise<void>;
	/** Milliseconds until the next attempt, or undefined to give up. Default: 2s doubling to 60s, five attempts. */
	retry?: (job: Job<P>, error: unknown, now: number) => number | undefined;
	/** Called once when a job is given up. */
	onGiveUp?: (job: Job<P>, error: unknown) => void;
	/** Jobs running at once, across keys. Default 4. */
	concurrency?: number;
	/** A run longer than this is aborted and counts as a failure. Default 2 minutes. */
	timeoutMs?: number;
	/** How often to look for jobs another process added. Default 2s. */
	pollMs?: number;
	/** How long finished jobs are kept for dedupe. Default 7 days. */
	keepMs?: number;
	now?: () => number;
}

export interface Queue<P> {
	enqueue(options: EnqueueOptions<P>): boolean;
	/** Move a waiting job, found by its dedupe key, to `dueAt` (default now). */
	reschedule(dedupe: string, dueAt?: number): boolean;
	/** Runs jobs until `signal` aborts, then waits up to `drainMs` for the ones in flight. */
	run(signal: AbortSignal, drainMs?: number): Promise<void>;
	/** Jobs not yet finished. */
	pending(): number;
}

const TABLE = /^[a-z_][a-z0-9_]*$/;
const DAY = 86_400_000;

/** The shared core database, `<data>/nano.sqlite`. Every process opens it through here so it is always WAL, private and patient. */
export function openQueueDb(dataDir: string, file = "nano.sqlite"): DatabaseSync {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, file);
	const db = new DatabaseSync(path, { timeout: 5000 });
	db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
	try {
		chmodSync(path, 0o600);
	} catch {}
	return db;
}

export function ensureQueueTable(db: DatabaseSync, table: string): void {
	if (!TABLE.test(table)) throw new Error(`bad queue table name: ${table}`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS ${table} (
			id INTEGER PRIMARY KEY, key TEXT NOT NULL, dedupe TEXT, payload TEXT,
			state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, done_at INTEGER, error TEXT
		);
		CREATE UNIQUE INDEX IF NOT EXISTS ${table}_dedupe ON ${table} (dedupe);
		CREATE INDEX IF NOT EXISTS ${table}_pending ON ${table} (state, key, id);
	`);
}

/** Add a job. Usable from any process. False when the dedupe key was already used. */
export function enqueueJob<P>(db: DatabaseSync, table: string, options: EnqueueOptions<P>, now = Date.now()): boolean {
	ensureQueueTable(db, table);
	const result = db
		.prepare(`INSERT INTO ${table} (key, dedupe, payload, created_at, due_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dedupe) DO NOTHING`)
		.run(options.key, options.dedupe || null, JSON.stringify(options.payload ?? null), now, options.dueAt ?? now);
	return result.changes > 0;
}

export function defaultRetry(job: Job<unknown>): number | undefined {
	return job.attempts >= 5 ? undefined : Math.min(60_000, 2000 * 2 ** (job.attempts - 1));
}

interface Row {
	id: number;
	key: string;
	dedupe: string | null;
	payload: string | null;
	attempts: number;
	created_at: number;
	due_at: number;
}

export function createQueue<P>(options: QueueOptions<P>): Queue<P> {
	const { db, table } = options;
	const now = options.now ?? Date.now;
	const concurrency = options.concurrency ?? 4;
	const timeoutMs = options.timeoutMs ?? 120_000;
	const pollMs = options.pollMs ?? 2000;
	const keepMs = options.keepMs ?? 7 * DAY;
	const retry = options.retry ?? defaultRetry;
	ensureQueueTable(db, table);

	// The head of each key: the oldest unfinished job. A later job waits for it even when it is due sooner.
	const insert = db.prepare(`INSERT INTO ${table} (key, dedupe, payload, created_at, due_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dedupe) DO NOTHING`);
	const heads = db.prepare(`SELECT id, key, dedupe, payload, attempts, created_at, due_at FROM ${table} AS j
		WHERE state = 'pending' AND id = (SELECT MIN(id) FROM ${table} WHERE key = j.key AND state = 'pending')
		ORDER BY due_at, id`);
	const finish = db.prepare(`UPDATE ${table} SET state = ?, payload = NULL, done_at = ?, error = ? WHERE id = ?`);
	const again = db.prepare(`UPDATE ${table} SET attempts = ?, due_at = ?, error = ? WHERE id = ? AND state = 'pending'`);
	const prune = db.prepare(`DELETE FROM ${table} WHERE state != 'pending' AND done_at < ?`);
	const count = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE state = 'pending'`);
	const move = db.prepare(`UPDATE ${table} SET due_at = ? WHERE dedupe = ? AND state = 'pending'`);

	const busy = new Map<string, Promise<void>>();
	let wakeUp: (() => void) | undefined;
	const wake = () => wakeUp?.();

	const toJob = (row: Row): Job<P> => ({
		id: row.id,
		key: row.key,
		dedupe: row.dedupe,
		payload: JSON.parse(row.payload ?? "null") as P,
		attempts: row.attempts,
		createdAt: row.created_at,
		dueAt: row.due_at,
	});

	async function runOne(job: Job<P>, signal: AbortSignal): Promise<void> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const jobSignal = AbortSignal.any([signal, timeout]);
		let handlerError: unknown;
		let failed = false;
		try {
			await abortable(options.handler(job, jobSignal), jobSignal);
		} catch (error) {
			// Shutting down: the job stays as it was and runs again after the restart.
			if (signal.aborted && !timeout.aborted) return;
			failed = true;
			handlerError = error;
		}
		if (!failed) {
			try {
				finish.run("done", now(), null, job.id);
			} catch (dbError) {
				console.error(`nano: queue ${table} could not mark job ${job.id} done:`, errorText(dbError));
			}
			return;
		}
		const attempts = job.attempts + 1;
		const message = errorText(handlerError);
		const delay = retry({ ...job, attempts }, handlerError, now());
		try {
			if (delay === undefined) {
				finish.run("failed", now(), message, job.id);
				try {
					options.onGiveUp?.({ ...job, attempts }, handlerError);
				} catch (giveUpError) {
					console.error(`nano: queue ${table} give-up handler failed:`, errorText(giveUpError));
				}
			} else {
				again.run(attempts, now() + delay, message, job.id);
			}
		} catch (dbError) {
			console.error(`nano: queue ${table} could not update job ${job.id}:`, errorText(dbError));
		}
	}

	return {
		enqueue(enqueueOptions) {
			const at = now();
			const added = insert.run(enqueueOptions.key, enqueueOptions.dedupe || null, JSON.stringify(enqueueOptions.payload ?? null), at, enqueueOptions.dueAt ?? at).changes > 0;
			if (added) wake();
			return added;
		},
		reschedule(dedupe, dueAt) {
			const moved = move.run(dueAt ?? now(), dedupe).changes > 0;
			if (moved) wake();
			return moved;
		},
		pending() {
			return Number((count.get() as { n: number }).n);
		},
		async run(signal, drainMs = 5000) {
			// Jobs in flight at shutdown get `drainMs` to finish before they are aborted too.
			const hard = new AbortController();
			signal.addEventListener("abort", () => setTimeout(() => hard.abort(new Error("shutting down")), drainMs).unref(), { once: true });
			let lastPrune = 0;
			while (!signal.aborted) {
				const at = now();
				let next = at + pollMs;
				try {
					if (at - lastPrune > 3_600_000) {
						prune.run(at - keepMs);
						lastPrune = at;
					}
					for (const row of heads.all() as unknown as Row[]) {
						if (busy.has(row.key)) continue;
						if (row.due_at > at) {
							next = Math.min(next, row.due_at);
							continue;
						}
						if (busy.size >= concurrency) break;
						let job: Job<P>;
						try {
							job = toJob(row);
						} catch (parseError) {
							const msg = `corrupt payload: ${errorText(parseError)}`;
							console.error(`nano: queue ${table} job ${row.id} ${msg}`);
							finish.run("failed", at, msg, row.id);
							continue;
						}
						busy.set(
							job.key,
							runOne(job, hard.signal)
								.catch((error) => console.error(`nano: queue ${table} worker error:`, errorText(error)))
								.finally(() => {
									busy.delete(job.key);
									wake();
								}),
						);
					}
				} catch (error) {
					console.error(`nano: queue ${table} poll failed:`, errorText(error));
				}
				if (signal.aborted) break;
				const wait = Math.max(10, next - now());
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, wait);
					const onAbort = () => done();
					signal.addEventListener("abort", onAbort, { once: true });
					wakeUp = done;
					function done() {
						clearTimeout(timer);
						signal.removeEventListener("abort", onAbort);
						wakeUp = undefined;
						resolve();
					}
				});
			}
			if (busy.size > 0) {
				const drain = new AbortController();
				try {
					await Promise.race([
						Promise.allSettled(busy.values()),
						sleep(drainMs + 100, undefined, { signal: drain.signal, ref: false }).catch(() => {}),
					]);
				} finally {
					drain.abort();
				}
			}
		},
	};
}

/** Rejects when `signal` aborts, even if `work` never settles. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function errorText(error: unknown): string {
	return ((error as Error)?.message ?? String(error)).slice(0, 500);
}
