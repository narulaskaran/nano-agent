import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Config, currentTimezone } from "./config.ts";
import type { Transport } from "./decide.ts";
import { type Gate, type GateSent, type GateVerdict, logGate, rememberSent, runGate, validateGate } from "./gate.ts";
import { readJsonFile, writeJsonFile } from "./json-store.ts";
import { isSilent } from "./tasks.ts";
import { triageFailure } from "./triage.ts";

/**
 * What a job does when it fires:
 * - message: send `body` to the owner as is. No model call.
 * - task:    hand `body` to the agent as a prompt. It replies to the owner, or with [silent].
 * - script:  run `body` as a shell command. Empty output means nothing happens. Otherwise the
 *            output is sent as is (`then: "send"`) or handed to the agent (`then: "task"`).
 *            With a `gate`, a decision model first judges whether the output is worth telling the
 *            owner (see gate.ts); a confident "quiet" stops it there.
 */
export interface Job {
	id: string;
	name: string;
	kind: "message" | "task" | "script";
	body: string;
	then?: "send" | "task";
	/** One-shot: epoch milliseconds. */
	at?: number;
	/** Recurring: five-field cron expression in the owner's timezone. */
	cron?: string;
	/** Recurring jobs stop after this moment (epoch milliseconds). */
	until?: number;
	spaceId: string;
	createdAt: number;
	lastFired?: number;
	/** Agent work (task, or script then task) runs in a background worker instead of the main conversation. */
	background?: boolean;
	model?: "main" | "local";
	private?: boolean;
	/** How the job's recent runs went. Kept in schedule.json so the failure policy survives restarts. */
	health?: JobHealth;
	/** Script jobs only: a decision on the output before anything is sent or any agent runs. */
	gate?: Gate;
	/** What a gated job last told the owner, so the gate can drop repeats. */
	gateSent?: GateSent[];
}

export interface SchedulerOptions {
	/** How gate decisions are made; defaults to decide.ts's transport. For tests. */
	decisionTransport?: Transport;
}

/**
 * One failure streak of a job. Policy (see Scheduler.failed): transient errors wait for the next
 * run; a real or lasting failure gets one repair attempt by a background worker; if the job still
 * fails after that, the owner is told once. A success ends the streak.
 */
export interface JobHealth {
	/** Consecutive failed runs. Zero means healthy. */
	failures: number;
	/** When the current failure streak started. */
	since?: number;
	lastSuccess?: number;
	lastFailure?: number;
	lastError?: string;
	/** A repair worker was started for this streak. */
	repairAt?: number;
	/** The owner was told about this streak. */
	escalated?: boolean;
}

export interface BackgroundWork {
	title: string;
	instructions: string;
	model?: "main" | "local";
	private?: boolean;
	/** The job this run belongs to; its outcome comes back through Scheduler.taskEnded. */
	jobId?: string;
	/** A repair attempt for this job id. A successful repair stays silent; anything else reaches the owner. */
	repairOf?: string;
}

export interface JobSink {
	send(spaceId: string, text: string): Promise<void>;
	task(spaceId: string, prompt: string): Promise<void>;
	/** Start a background worker; its answer comes back through the task hand-back. */
	background(spaceId: string, work: BackgroundWork): Promise<void>;
}

const TICK_MS = 20_000;
const SCRIPT_TIMEOUT_MS = 120_000;
/** A reminder whose send keeps failing is retried this long, then reported once and dropped. */
export const RETRY_MS = 10 * 60_000;
/** A transient failure stops counting as transient after this many runs in a row, or this long. */
export const TRANSIENT_RUNS = 3;
export const TRANSIENT_MS = 60 * 60_000;
/** After starting a repair, further failures stay quiet this long so the repair can finish. */
export const REPAIR_GRACE_MS = 30 * 60_000;

/** Errors that usually clear on their own: timeouts, network trouble, overloaded or rate-limited services. */
export function isTransient(error: string): boolean {
	return /timed out|timeout|ETIMEDOUT|could not resolve|connection (refused|reset)|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|\b(408|429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|temporarily|unavailable/i.test(error);
}

// Every part is evaluated (no short-circuit) so a malformed field throws even when an earlier part matches.
function fieldMatches(field: string, value: number, min: number, max: number): boolean {
	return field.split(",").map((part) => {
		const [range, stepText] = part.split("/");
		const step = stepText ? Number(stepText) : 1;
		if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
		let lo = min;
		let hi = max;
		if (range !== "*") {
			const [a, b] = (range ?? "").split("-");
			lo = Number(a);
			hi = b === undefined ? (stepText ? max : lo) : Number(b);
			if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
				throw new Error(`bad cron field: ${part}`);
			}
		}
		return value >= lo && value <= hi && (value - lo) % step === 0;
	}).some(Boolean);
}

/** Wall-clock parts of `at` in `timeZone`. */
export function zonedParts(at: Date, timeZone: string) {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			weekday: "short",
		})
			.formatToParts(at)
			.map((p) => [p.type, p.value]),
	);
	return {
		minute: Number(parts.minute),
		hour: Number(parts.hour),
		day: Number(parts.day),
		month: Number(parts.month),
		weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday as string),
	};
}

/** Standard five-field cron: minute hour day-of-month month day-of-week (0 or 7 = Sunday). */
export function cronMatches(expression: string, at: Date, timeZone: string): boolean {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("cron needs five fields: minute hour day month weekday");
	const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
	const now = zonedParts(at, timeZone);
	const dayOk = fieldMatches(day, now.day, 1, 31);
	const weekdayOk = fieldMatches(weekday, now.weekday, 0, 7) || (now.weekday === 0 && fieldMatches(weekday, 7, 0, 7));
	// As in cron: when both day fields are restricted, either one matching is enough.
	const dateOk = day !== "*" && weekday !== "*" ? dayOk || weekdayOk : dayOk && weekdayOk;
	// Evaluate all five fields before combining, so a bad hour or month is rejected even when the minute does not match now.
	const minuteOk = fieldMatches(minute, now.minute, 0, 59);
	const hourOk = fieldMatches(hour, now.hour, 0, 23);
	const monthOk = fieldMatches(month, now.month, 1, 12);
	return minuteOk && hourOk && monthOk && dateOk;
}

/** Parse "2026-11-12T09:00" (owner's wall clock) or any ISO string with an offset into epoch ms. */
export function parseLocalTime(input: string, timeZone: string): number {
	const text = input.trim();
	if (/[zZ]$|[+-]\d\d:?\d\d$/.test(text)) {
		const ms = Date.parse(text);
		if (Number.isNaN(ms)) throw new Error(`cannot read time: ${input}`);
		return ms;
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (!m) throw new Error(`time must look like 2026-11-12T09:00 (got ${input})`);
	const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
	// Find the UTC instant whose wall clock in the zone equals the request: guess, measure the offset, correct twice.
	const wanted = Date.UTC(y, mo - 1, d, h, mi, s);
	let guess = wanted;
	for (let i = 0; i < 2; i++) {
		const p = Object.fromEntries(
			new Intl.DateTimeFormat("en-US", {
				timeZone,
				hourCycle: "h23",
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				second: "numeric",
			})
				.formatToParts(new Date(guess))
				.map((part) => [part.type, Number(part.value)]),
		) as Record<string, number>;
		const shown = Date.UTC(p.year as number, (p.month as number) - 1, p.day, p.hour, p.minute, p.second);
		guess += wanted - shown;
	}
	return guess;
}

export class Scheduler {
	private readonly path: string;
	private jobs: Job[] = [];
	private timer?: NodeJS.Timeout;
	private running = new Set<string>();
	private outboxRunning = new Set<string>();
	/** In memory only: when a one-shot reminder's send first failed. */
	private failedSince = new Map<string, number>();
	/** In memory only: jobs whose cron expression is unusable, logged once. */
	private badCron = new Set<string>();
	private readonly config: Config;
	private readonly sink: JobSink;
	private readonly options: SchedulerOptions;

	constructor(config: Config, sink: JobSink, options: SchedulerOptions = {}) {
		this.config = config;
		this.sink = sink;
		this.options = options;
		this.path = join(config.dataDir, "schedule.json");
		const stored = readJsonFile<{ jobs?: Job[] } | null>(this.path, null);
		if (Array.isArray(stored?.jobs)) this.jobs = stored.jobs;
	}

	start(): void {
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		void this.tick();
	}

	stop(): void {
		clearInterval(this.timer);
	}

	list(): Job[] {
		return [...this.jobs];
	}

	add(input: Omit<Job, "id" | "createdAt">): Job {
		if (!input.at && !input.cron) throw new Error("a job needs a time (at) or a schedule (cron)");
		if (input.cron) cronMatches(input.cron, new Date(), currentTimezone(this.config)); // validates
		if (input.gate) {
			if (input.kind !== "script") throw new Error('a gate judges script output, so it needs kind "script"');
			// The decision model may be a cloud service; private material must not reach it.
			if (input.private) throw new Error("a private job cannot have a gate: the decision model may be a cloud service");
			validateGate(input.gate);
		}
		const job: Job = { ...input, id: randomBytes(3).toString("hex"), createdAt: Date.now() };
		this.jobs.push(job);
		this.save();
		return job;
	}

	cancel(id: string): Job | undefined {
		const index = this.jobs.findIndex((j) => j.id === id);
		if (index < 0) return undefined;
		const [job] = this.jobs.splice(index, 1);
		this.save();
		this.failedSince.delete(id);
		this.badCron.delete(id);
		return job;
	}

	/**
	 * Other programs on the machine hand Nano something to deliver by dropping a file in
	 * `<data>/outbox`: `*.txt` is sent to the owner as is; `*.json` is
	 * `{"text": "...", "kind": "message" | "task", "to": "<chat id, default owner>"}`.
	 */
	private async drainOutbox(): Promise<void> {
		await this.drainOutboxDir(join(this.config.dataDir, "outbox"), false);
		for (const dir of new Set(this.config.eventOutboxDirs ?? [])) {
			if (dir !== join(this.config.dataDir, "outbox")) await this.drainOutboxDir(dir, true);
		}
	}

	private async drainOutboxDir(dir: string, durable: boolean): Promise<void> {
		mkdirSync(dir, { recursive: true });
		for (const name of readdirSync(dir).sort()) {
			if (!/\.(txt|json)$/.test(name)) continue; // writers use a temp name, then rename
			const path = join(dir, name);
			if (this.outboxRunning.has(path)) continue;
			if (durable && existsSync(path.replace(/\.(json|txt)$/, ".done"))) { rmSync(path); continue; }
			let item: { text?: string; kind?: string; to?: string };
			try {
				const raw = readFileSync(path, "utf8");
				item = name.endsWith(".json") ? JSON.parse(raw) : { text: raw };
				if (!durable) rmSync(path); // Existing plain outbox keeps its one-shot behavior.
			} catch (error) {
				console.error(`nano: bad outbox file ${name}:`, (error as Error)?.message ?? error);
				try {
					renameSync(path, `${path}.bad`);
				} catch {}
				continue;
			}
			const text = item.text?.trim();
			const to = item.to || this.config.owner;
			if (!text || !to) continue;
			this.outboxRunning.add(path);
			console.error(`nano: outbox ${item.kind === "task" ? "task" : "message"} from ${name}`);
			try {
				if (item.kind === "task") await this.sink.task(to, text);
				else await this.sink.send(to, text);
				if (durable) renameSync(path, path.replace(/\.(json|txt)$/, ".done"));
			} catch (error) {
				console.error(`nano: outbox delivery failed for ${name}:`, (error as Error)?.message ?? error);
			} finally {
				this.outboxRunning.delete(path);
			}
		}
	}

	async tick(now = new Date()): Promise<void> {
		await this.drainOutbox().catch((error) => console.error("nano: outbox error:", error));
		const tz = currentTimezone(this.config);
		const minute = Math.floor(now.getTime() / 60_000);
		for (const job of [...this.jobs]) {
			if (this.running.has(job.id)) continue;
			let due = false;
			if (job.at !== undefined) {
				due = now.getTime() >= job.at;
			} else if (job.cron) {
				if (job.until !== undefined && now.getTime() > job.until) {
					this.cancel(job.id);
					continue;
				}
				const firedThisMinute = job.lastFired !== undefined && Math.floor(job.lastFired / 60_000) === minute;
				try {
					due = !firedThisMinute && cronMatches(job.cron, now, tz);
				} catch (error) {
					due = false;
					if (!this.badCron.has(job.id)) {
						this.badCron.add(job.id);
						console.error(`nano: job ${job.id} (${job.name}) has an unusable schedule "${job.cron}" and will never fire: ${(error as Error)?.message ?? error}`);
					}
				}
			}
			if (!due) continue;

			// A one-shot reminder stays scheduled until it is actually sent (see deliverReminder), so it can be retried.
			// Every other job is persisted before running, so a crash mid-run cannot fire it twice.
			if (!isReminder(job)) {
				job.lastFired = now.getTime();
				if (job.at !== undefined) this.jobs = this.jobs.filter((j) => j.id !== job.id);
				this.save();
			}
			this.running.add(job.id);
			void this.fire(job, now.getTime()).finally(() => this.running.delete(job.id));
		}
	}

	/**
	 * Send a one-shot reminder, then remove it. A failed send leaves it scheduled and the next tick tries
	 * again. After RETRY_MS of failures it is dropped, and one last attempt tells the owner what was missed.
	 * Delivery is at least once: a crash between the send and the removal sends it again on restart.
	 */
	private async deliverReminder(job: Job, now: number): Promise<void> {
		try {
			await this.sink.send(job.spaceId, job.body);
		} catch (error) {
			const since = this.failedSince.get(job.id) ?? now;
			this.failedSince.set(job.id, since);
			console.error(`nano: reminder ${job.id} (${job.name}) not sent, will retry:`, (error as Error)?.message ?? error);
			if (now - since < RETRY_MS) return;
			this.failedSince.delete(job.id);
			this.removeJob(job.id);
			console.error(`nano: giving up on reminder ${job.id} (${job.name}): ${job.body}`);
			await this.sink.send(job.spaceId, `I could not deliver a reminder on time ("${job.name}"): ${job.body}`).catch(() => {});
			return;
		}
		this.failedSince.delete(job.id);
		this.removeJob(job.id);
	}

	private removeJob(id: string): void {
		this.jobs = this.jobs.filter((j) => j.id !== id);
		this.save();
	}

	/** A background run of a job ended (TaskManager calls this). Feeds the same failure policy as scripts. */
	taskEnded(task: { jobId?: string; spaceId: string; title: string; status: string; error?: string; result?: string }, now = Date.now()): void {
		if (!task.jobId) return;
		const job = this.jobs.find((j) => j.id === task.jobId);
		if (task.status === "done") {
			if (job) this.succeeded(job, now);
			if (job?.gate) {
				// What the agent made of output the gate let through: the other half of the gate's record.
				const told = !isSilent(task.result) && Boolean(task.result?.trim());
				logGate(this.gateLogPath(), { job: job.id, agent: told ? "notify" : "quiet" });
				if (told) {
					job.gateSent = rememberSent(job.gateSent, task.result as string, now);
					this.save();
				}
			}
			return;
		}
		if (task.status !== "failed") return;
		const error = task.error ?? "unknown error";
		if (job) void this.failed(job, error, now);
		// A one-shot job is gone by now and never runs again, so there is nothing to wait for or repair.
		else void this.sink.send(task.spaceId, `The scheduled task "${task.title}" failed: ${error.slice(0, 200)}`).catch(() => {});
	}

	private succeeded(job: Job, now: number): void {
		const wasEscalated = job.health?.escalated;
		job.health = { failures: 0, lastSuccess: now };
		this.save();
		if (wasEscalated) void this.sink.send(job.spaceId, `"${job.name}" is working again.`).catch(() => {});
	}

	/** Record a failed run. A new streak starts with a clean slate: no repair tried, owner not told. */
	private noteFailure(job: Job, error: string, now: number): JobHealth {
		const prev = job.health?.failures ? job.health : undefined;
		const health: JobHealth = {
			...prev,
			failures: (prev?.failures ?? 0) + 1,
			since: prev?.since ?? now,
			lastSuccess: job.health?.lastSuccess,
			lastFailure: now,
			lastError: error.replace(/\s+/g, " ").trim().slice(0, 300),
		};
		job.health = health;
		this.save();
		console.error(`nano: job ${job.id} (${job.name}) failed (${health.failures} in a row): ${health.lastError}`);
		return health;
	}

	/**
	 * The failure policy. Transient errors wait for the next run, up to TRANSIENT_RUNS runs or
	 * TRANSIENT_MS. Anything else gets one repair attempt. If the job still fails once the repair
	 * has had REPAIR_GRACE_MS, the owner is told once, and the job stays quiet until it works again.
	 */
	private async failed(job: Job, error: string, now: number): Promise<void> {
		const health = this.noteFailure(job, error, now);
		if (health.escalated) return;
		// A decision sorts the failure; when it is unsure or unavailable (or the job is private), the regex does.
		const triage = job.private
			? undefined
			: await triageFailure({ name: job.name, kind: job.kind, error, source: `triage:${job.id}`, logPath: join(this.config.dataDir, "decisions.jsonl"), transport: this.options.decisionTransport });
		if (triage) console.error(`nano: job ${job.id} (${job.name}) failure looks ${triage.kind} (${triage.p.toFixed(2)})`);
		if (triage?.kind === "owner") {
			// A repair cannot fix a login, an account or money, so the owner hears now instead of after a wasted repair.
			try {
				await this.sink.send(job.spaceId, `"${job.name}" is failing and needs you: ${(health.lastError ?? "").slice(0, 200)}. I will stay quiet about it until it works again.`);
				health.escalated = true;
				this.save();
			} catch {
				// Not delivered: the next failure tries again.
			}
			return;
		}
		const transient = triage ? triage.kind === "transient" : isTransient(error);
		const lasting = !transient || health.failures >= TRANSIENT_RUNS || now - (health.since ?? now) >= TRANSIENT_MS;
		if (!lasting) return;
		if (health.repairAt === undefined) {
			health.repairAt = now;
			this.save();
			try {
				await this.sink.background(job.spaceId, { title: `Repair "${job.name}"`, instructions: repairPrompt(job, this.config.dataDir), model: job.model, private: job.private, repairOf: job.id });
				console.error(`nano: started a repair for job ${job.id} (${job.name})`);
				return;
			} catch (startError) {
				console.error(`nano: could not start a repair for job ${job.id}:`, (startError as Error)?.message ?? startError);
				// Fall through and tell the owner now.
			}
		} else if (now - health.repairAt < REPAIR_GRACE_MS) {
			return;
		}
		const tried = health.repairAt !== undefined && now - health.repairAt >= REPAIR_GRACE_MS ? " and I could not fix it" : "";
		try {
			await this.sink.send(job.spaceId, `"${job.name}" keeps failing${tried}: ${(health.lastError ?? "").slice(0, 200)}. I will stay quiet about it until it works again.`);
			health.escalated = true;
			this.save();
		} catch {
			// Not delivered: the next failure tries again.
		}
	}

	private async fire(job: Job, now: number): Promise<void> {
		console.error(`nano: firing ${job.kind} job ${job.id} (${job.name})${job.background ? " in the background" : ""}`);
		const agent = (prompt: string) =>
			job.background
				? this.sink.background(job.spaceId, { title: job.name, instructions: prompt, model: job.model, private: job.private, jobId: job.id })
				: this.sink.task(job.spaceId, prompt);
		try {
			if (job.kind === "message") {
				if (isReminder(job)) return await this.deliverReminder(job, now);
				await this.sink.send(job.spaceId, job.body);
				this.succeeded(job, now);
			} else if (job.kind === "task") {
				await agent(`Scheduled task "${job.name}":\n${job.body}\nIf there is nothing worth telling the owner, reply exactly [silent].`);
				// A background run reports its outcome later, through taskEnded. A main-conversation turn reports its own errors.
				if (!job.background) this.succeeded(job, now);
			} else {
				let output: string;
				try {
					output = await runScript(job.body, join(this.config.dataDir, "workspace"));
				} catch (error) {
					await this.failed(job, (error as Error)?.message ?? String(error), now);
					return;
				}
				this.succeeded(job, now);
				if (!output) return;
				if (job.gate) {
					const verdict = await this.gate(job, output, now);
					if (!verdict.notify && !job.gate.shadow) return;
				}
				if (job.then === "task") {
					await agent(`Scheduled check "${job.name}" produced this output. Decide what, if anything, the owner needs to hear; if nothing, reply exactly [silent]:\n${output}`);
					// A background run's answer is remembered when it ends (taskEnded); a main-conversation turn's is not visible here.
					if (job.gate && !job.background) this.remember(job, output, now);
				} else {
					await this.sink.send(job.spaceId, labelScriptOutput(job.name, output));
					if (job.gate) this.remember(job, output, now);
				}
			}
		} catch (error) {
			// Delivery itself failed (the channel or the worker queue). Recorded, but a repair worker cannot fix that.
			const reason = (error as Error)?.message ?? String(error);
			console.error(`nano: job ${job.id} (${job.name}) could not be delivered:`, reason);
			this.noteFailure(job, `delivery failed: ${reason}`, now);
		}
	}

	/** Ask the gate about this output and log the verdict. Never throws: a failed gate lets the output through. */
	private async gate(job: Job, output: string, now: number): Promise<GateVerdict> {
		const gate = job.gate as Gate;
		const verdict: GateVerdict = job.private
			? { notify: true, p: 0, answer: "error", error: "private job: not sent to the gate" }
			: await runGate({
					name: job.name,
					output,
					gate,
					sent: job.gateSent,
					now,
					timeZone: currentTimezone(this.config),
					source: `gate:${job.id}`,
					logPath: join(this.config.dataDir, "decisions.jsonl"),
					transport: this.options.decisionTransport,
				});
		const action = verdict.notify ? "go" : gate.shadow ? "go (shadow)" : "quiet";
		logGate(this.gateLogPath(), { job: job.id, gate: verdict.answer, p: Number(verdict.p.toFixed(3)), min: gate.min, shadow: gate.shadow || undefined, action, error: verdict.error, chars: output.length });
		console.error(`nano: gate on job ${job.id} (${job.name}): ${verdict.answer}${verdict.p ? ` ${verdict.p.toFixed(2)}` : ""} -> ${action}${verdict.error ? ` (${verdict.error})` : ""}`);
		return verdict;
	}

	private remember(job: Job, text: string, now: number): void {
		job.gateSent = rememberSent(job.gateSent, text, now);
		this.save();
	}

	private gateLogPath(): string {
		return join(this.config.dataDir, "gate.jsonl");
	}

	private save(): void {
		writeJsonFile(this.path, { jobs: this.jobs });
	}
}

/**
 * Script output goes out with the job's name on top. It is not written for the moment it lands, so without a label it
 * reads as a reply to whatever the owner was just talking about. Output that already starts with the name is left alone.
 */
export function labelScriptOutput(name: string, output: string): string {
	const label = name.trim();
	if (!label || output.trimStart().toLowerCase().startsWith(label.toLowerCase())) return output;
	return `${label}:\n${output}`;
}

/** A one-shot plain message: the one kind of job that is kept until it has been delivered. */
function isReminder(job: Job): boolean {
	return job.kind === "message" && job.at !== undefined;
}

/** Brief for the one repair attempt a failing job gets. A fix stays silent; a failure to fix reaches the owner. */
function repairPrompt(job: Job, dataDir: string): string {
	const health = job.health;
	const schedule = job.cron ? `cron "${job.cron}"` : "one-time";
	return [
		`Scheduled job "${job.name}" (id ${job.id}, kind ${job.kind}, ${schedule}) is failing: ${health?.failures ?? 1} run(s) in a row.`,
		`Latest error: ${health?.lastError ?? "unknown"}`,
		job.kind === "script"
			? `Its command runs with bash in ${join(dataDir, "workspace")}:\n${job.body}`
			: `Its instructions:\n${job.body}`,
		"",
		"Try once to fix the cause. Read the script and the files it uses, find what broke, fix it, then run the command by hand to confirm it works.",
		`You may fix the script, its state file or its inputs in the workspace. If the job's command itself is wrong, cancel job ${job.id} and add a corrected one with the same name, schedule and settings.`,
		"You may not change credentials or anything in the vault, buy anything, grant new permissions, or change any other job.",
		"If a state file in a writable folder is owned by root, you cannot chown it; rename it aside as <name>.root-backup-<date> (never delete it), then rerun the job so it recreates the file.",
		"If the fix needs the owner (a login, a credential, money, an account, or a change to what the job is for), do not work around it.",
		`If you fixed it, answer exactly "FIXED: <what was wrong and what you changed>". That line is kept in the log and not sent to the owner.`,
		"If you could not fix it, answer in one or two lines for the owner: what is wrong, what you tried, and what they need to do.",
	].join("\n");
}

function runScript(command: string, cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("bash", ["-c", command], { cwd, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error?.killed) reject(new Error(`timed out after ${SCRIPT_TIMEOUT_MS / 1000}s${stderr ? `: ${stderr.slice(0, 300)}` : ""}`));
			else if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`));
			else resolve(stdout.trim().slice(0, 8000));
		});
	});
}
