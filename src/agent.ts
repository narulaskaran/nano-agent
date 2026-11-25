import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { baseMessageId, type Channel, clip, type Inbound, type Revision } from "./channel.ts";
import { type Config, currentTimezone, localStamp } from "./config.ts";
import { createDecider, type Decider } from "./decide.ts";
import { readJsonFile, writeJsonFile } from "./json-store.ts";
import { getMainModel } from "./models.ts";
import { refreshProviderSettings } from "./provider-settings.ts";
import { packExtensions } from "./packs.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { LONG_HINT, logRoute, type RecentTurn, REMEMBER_HINT, route, skillBlock, taskHint } from "./router.ts";
import type { Scheduler } from "./scheduler.ts";
import { assistantText, createNanoSession } from "./session.ts";
import { listSkills } from "./skills.ts";
import { taskTools } from "./task-tools.ts";
import { isSilent, type TaskManager } from "./tasks.ts";
import { nanoTools } from "./tools.ts";

interface SpaceState {
	sessionFile?: string;
	lastActivity: number;
	recent: RecentTurn[];
}

const BURST_MS = 1200;
const TYPING_REFRESH_MS = 25_000;
const RECENT_KEEP = 12;
const CARRY_CHARS = 3000;

/** Small JSON store for what must survive a restart: which Pi session each conversation is on. */
export class StateStore {
	private readonly path: string;
	private data: { spaces: Record<string, SpaceState> };

	constructor(dataDir: string) {
		this.path = join(dataDir, "state.json");
		this.data = readJsonFile<{ spaces: Record<string, SpaceState> } | null>(this.path, null) ?? { spaces: {} };
		this.data.spaces ??= {};
	}

	space(id: string): SpaceState {
		this.data.spaces[id] ??= { lastActivity: 0, recent: [] };
		return this.data.spaces[id];
	}

	save(): void {
		writeJsonFile(this.path, this.data);
	}
}

/** Text of the turns just before an idle gap, so a fresh context window still knows what was being discussed. */
export function carryOver(recent: RecentTurn[], maxChars = CARRY_CHARS): string {
	const lines: string[] = [];
	let used = 0;
	for (const turn of [...recent].reverse()) {
		const line = `${turn.role === "owner" ? "Owner" : "You"}: ${turn.text.replace(/\s+/g, " ").slice(0, 600)}`;
		if (used + line.length > maxChars) break;
		lines.unshift(line);
		used += line.length;
	}
	return lines.join("\n");
}

export function isIdle(lastActivity: number, idleHours: number, now = Date.now()): boolean {
	return lastActivity > 0 && now - lastActivity > idleHours * 3_600_000;
}

/**
 * Turns run one at a time, in arrival order. Consecutive items from the same source are
 * merged into one turn; owner text and system events are never mixed in one prompt.
 */
export class TurnQueue<T extends { from: string }> {
	private readonly items: { item: T; done: () => void }[] = [];
	private readonly run: (batch: T[]) => Promise<void>;
	private running = false;
	/** Items taken into the running turn by takeNext; they finish with it. */
	private joined: (() => void)[] = [];

	constructor(run: (batch: T[]) => Promise<void>) {
		this.run = run;
	}

	get busy(): boolean {
		return this.running;
	}

	/** Resolves when the turn that handled `item` has finished. */
	push(item: T): Promise<void> {
		return new Promise((done) => {
			this.items.push({ item, done });
			void this.drain();
		});
	}

	/**
	 * Like push, but this source runs next: every item already queued from it moves ahead of
	 * other sources, in its own order, followed by `item`, so they all merge into one turn.
	 */
	pushNext(item: T): Promise<void> {
		return new Promise((done) => {
			const own = this.items.filter((entry) => entry.item.from === item.from);
			const others = this.items.filter((entry) => entry.item.from !== item.from);
			this.items.splice(0, this.items.length, ...own, { item, done }, ...others);
			void this.drain();
		});
	}

	/** Hand the running turn any items from `from` that are next in line; they finish with it. */
	takeNext(from: T["from"]): T[] {
		const taken: T[] = [];
		while (this.items[0]?.item.from === from) {
			const next = this.items.shift() as { item: T; done: () => void };
			taken.push(next.item);
			this.joined.push(next.done);
		}
		return taken;
	}

	private async drain(): Promise<void> {
		if (this.running || this.items.length === 0) return;
		const batch = [this.items.shift() as { item: T; done: () => void }];
		while (this.items[0] && this.items[0].item.from === batch[0]?.item.from) batch.push(this.items.shift() as { item: T; done: () => void });
		this.running = true;
		try {
			await this.run(batch.map((b) => b.item));
		} catch (error) {
			console.error("nano: turn failed:", error);
		} finally {
			this.running = false;
			for (const b of batch) b.done();
			for (const done of this.joined.splice(0)) done();
			void this.drain();
		}
	}
}

type Work =
	| {
			from: "owner";
			spoken: string;
			images: { type: "image"; data: string; mimeType: string }[];
			/** Router notes for the turn. */
			hints?: string[];
			/** A skill the router picked, put into the prompt unless this session already has it. */
			skill?: { name: string; path: string };
			/** The router judged this needs no extended thinking. */
			simple?: boolean;
	  }
	| { from: "system"; text: string; note: string };

/** What the turn in progress is doing, so a new owner message knows whether it can still change it. */
interface RunState {
	/** Who the turn is for; only an owner's turn is interrupted by the owner. */
	from: Work["from"];
	/**
	 * - setup: the session is being prepared; the prompt has not been written yet.
	 * - starting: the prompt is handed over, the model run has not begun (input hooks, compaction).
	 * - model: a model call is writing output nobody has seen.
	 * - tools: the model has asked for tools; they run before its next call.
	 * - done: the reply has gone out.
	 */
	phase: "setup" | "starting" | "model" | "tools" | "done";
	/** A newer owner message is waiting: cancel at the next point where nothing done is lost. */
	interrupted: boolean;
	/** The cancel has been sent. */
	aborted: boolean;
}

/** How many notes made before the session exists are kept for it. */
const NOTE_KEEP = 5;

export interface ConversationOptions {
	/** Router decisions, used only when the router is on. Tests inject a fake. */
	decider?: Decider;
}

export class Conversation {
	private session?: AgentSession;
	private providerRevision?: string;
	private unsubscribe?: () => void;
	private pending: Inbound[] = [];
	private timer?: NodeJS.Timeout;
	private readonly queue = new TurnQueue<Work>((batch) => this.turn(batch));
	private readonly state: SpaceState;
	private readonly spaceId: string;
	private readonly config: Config;
	private readonly channel: Channel;
	private readonly store: StateStore;
	private readonly modelRuntime: ModelRuntime;
	private readonly scheduler: Scheduler;
	private readonly tasks: TaskManager;
	/**
	 * When an owner message arrives after the idle gap, the moment it arrived. Recording the message
	 * moves lastActivity to now, so the gap has to be noticed before that, not in ensureSession.
	 */
	private rolloverAt?: number;
	/** The turn in progress, if any. */
	private run?: RunState;
	/**
	 * Notes to put in the session once it exists: a send made outside the conversation, or an owner
	 * message that got no reply. `make` runs at record time, so a timestamp in the text is current.
	 */
	private notes: { customType: string; make: () => string }[] = [];
	/** Owner messages are routed one at a time, in arrival order. */
	private routing: Promise<void> = Promise.resolve();
	private readonly decider?: Decider;
	/** Skills already put into this session's prompts by the router. */
	private injectedSkills = new Set<string>();

	constructor(
		spaceId: string,
		config: Config,
		channel: Channel,
		store: StateStore,
		modelRuntime: ModelRuntime,
		scheduler: Scheduler,
		tasks: TaskManager,
		options: ConversationOptions = {},
	) {
		this.spaceId = spaceId;
		this.decider = config.router ? (options.decider ?? createDecider({ dataDir: config.dataDir, refusePrivate: true })) : undefined;
		this.config = config;
		this.channel = channel;
		this.store = store;
		this.modelRuntime = modelRuntime;
		this.scheduler = scheduler;
		this.tasks = tasks;
		this.state = store.space(spaceId);
	}

	/** Texts often arrive in bursts; wait a beat and handle them as one message. */
	receive(message: Inbound): void {
		// An edit or unsend of a text still waiting here changes that text; Nano never sees the old version.
		if (message.revision && this.revisePending(message.revision)) return;
		this.pending.push(message);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flushOwner(), BURST_MS);
	}

	/**
	 * Run a prompt that did not come from the owner (scheduled jobs, reminders, background task
	 * results). It waits for any turn in progress and gets a turn of its own.
	 */
	inject(prompt: string, note = "Scheduled task for you to carry out"): Promise<void> {
		return this.queue.push({ from: "system", text: prompt, note });
	}

	/**
	 * Send text to the owner that the agent did not write this turn (plain reminders, script output).
	 * Unlike a reply, a failed send throws, so the scheduler can retry or report it.
	 */
	async deliver(text: string): Promise<void> {
		if (isSilent(text)) return;
		await this.channel.send(this.spaceId, text);
		this.record("nano", text); // only once it was sent, so a retry is not logged twice
		await this.keepNote(
			"nano-delivered",
			() => `[Sent to the owner outside this conversation (a scheduled job, reminder or notice), not written by you here: "${clip(text)}"]`,
		);
	}

	/**
	 * Puts a note the agent did not write into its session history. Pi holds it until a turn in progress ends.
	 * Not a reply, so it starts no turn.
	 */
	private async recordNote(session: AgentSession, customType: string, content: string): Promise<void> {
		await session
			.sendCustomMessage({ customType, content, display: false }, { triggerTurn: false })
			.catch((error) => console.error(`nano: could not record a ${customType} message:`, (error as Error)?.message ?? error));
	}

	/** Record `make()` now, or keep it until the session exists. */
	private async keepNote(customType: string, make: () => string): Promise<void> {
		if (this.session) await this.recordNote(this.session, customType, make());
		else this.notes = [...this.notes, { customType, make }].slice(-NOTE_KEEP);
	}

	async dispose(): Promise<void> {
		clearTimeout(this.timer);
		this.unsubscribe?.();
		if (this.session?.isStreaming) await this.session.abort().catch(() => {});
		// AgentSession.dispose() does not emit session_shutdown; extensions (MCP servers) clean up on it.
		await this.session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
		this.session?.dispose();
		this.session = undefined;
	}

	/** Applies an edit or unsend to its message if that is still in the burst window. False when it is not. */
	private revisePending(revision: Revision): boolean {
		const matches = (m: Inbound) => baseMessageId(m.messageId) === revision.targetId;
		if (revision.kind === "unsend") {
			const before = this.pending.length;
			this.pending = this.pending.filter((m) => !matches(m));
			if (this.pending.length === 0) clearTimeout(this.timer);
			return this.pending.length < before;
		}
		// An edit changes the text part; a part carrying a file keeps it.
		const index = this.pending.findIndex((m) => matches(m) && m.files.length === 0);
		if (index < 0) return false;
		this.pending[index] = { ...this.pending[index], text: revision.text };
		return true;
	}

	private flushOwner(): void {
		const batch = this.pending.splice(0);
		if (batch.length === 0) return;
		const body = batch.map((m) => m.text).filter(Boolean).join("\n");
		const files = batch.flatMap((m) => m.files);
		const images = files
			.filter((f) => f.kind === "image")
			.map((f) => ({ type: "image" as const, data: readFileSync(f.path).toString("base64"), mimeType: f.mimeType }));
		const fileNotes = files.map((f) => `[${f.kind} received: ${f.path}]`).join("\n");
		const spoken = [body, fileNotes].filter(Boolean).join("\n");
		const before = { recent: [...this.state.recent], lastActivity: this.state.lastActivity };
		if (isIdle(this.state.lastActivity, this.config.idleHours)) this.rolloverAt ??= Date.now();
		this.record("owner", spoken);

		const work: Work = { from: "owner", spoken, images };
		// Chained even when the router is off or skipped, so a message never overtakes one still being routed.
		this.routing = this.routing.then(() => this.routeOwner(work, before, files.length > 0)).catch((error) => {
			console.error("nano: routing failed:", error);
			this.dispatch(work);
		});
	}

	/**
	 * Decide what an owner message needs before its turn (router.ts), then dispatch it. Only a message that would
	 * start a turn of its own is routed: one that joins or waits behind a running turn keeps today's handling.
	 */
	private async routeOwner(work: Work & { from: "owner" }, before: { recent: RecentTurn[]; lastActivity: number }, hasFiles: boolean): Promise<void> {
		if (!this.decider || this.run || this.queue.busy) return this.dispatch(work);
		const now = Date.now();
		const running = this.tasks.active().map((t) => ({ id: t.id, title: t.title }));
		const skills = listSkills(this.config);
		const decision = await route({ message: work.spoken, recent: before.recent, now, running, skills }, { decider: this.decider });
		const actions: string[] = [];
		// Something may have started while the decision was being made; then the message joins it as usual.
		const free = !this.run && !this.queue.busy;
		if (free && decision.noReply && !hasFiles) {
			actions.push("no-reply");
		} else {
			const quietMinutes = before.lastActivity > 0 ? (now - before.lastActivity) / 60_000 : 0;
			if (free && decision.newTopic && this.rolloverAt === undefined && quietMinutes >= this.config.topicIdleMinutes && (this.session || this.state.sessionFile)) {
				this.rolloverAt = now;
				actions.push("new-context");
			}
			const hints: string[] = [];
			if (decision.long) {
				hints.push(LONG_HINT);
				actions.push("delegate-hint");
			}
			const task = decision.task ? running.find((t) => t.id === decision.task) : undefined;
			if (task) {
				hints.push(taskHint(task));
				actions.push(`task:${task.id}`);
			}
			if (decision.remember) {
				hints.push(REMEMBER_HINT);
				actions.push("remember-hint");
			}
			if (hints.length) work.hints = hints;
			const skill = decision.skill ? skills.find((s) => s.name === decision.skill) : undefined;
			if (skill) {
				work.skill = { name: skill.name, path: skill.path };
				actions.push(`skill:${skill.name}`);
			}
			if (decision.simple && !hasFiles) {
				work.simple = true;
				actions.push("no-thinking");
			}
		}
		logRoute(join(this.config.dataDir, "router.jsonl"), { answers: decision.answers, ms: decision.ms, actions, error: decision.error, busy: free ? undefined : true });
		const summary = Object.entries(decision.answers).map(([id, a]) => `${id}=${a.label} ${a.p.toFixed(2)}`).join(" ");
		console.error(`nano: routed (${decision.ms} ms) ${summary || decision.error}${actions.length ? ` -> ${actions.join(", ")}` : ""}`);
		if (actions.includes("no-reply")) return this.noteUnanswered(work.spoken);
		this.dispatch(work);
	}

	/** An owner message the router decided needs no reply: the session still learns it was said. */
	private async noteUnanswered(spoken: string): Promise<void> {
		await this.keepNote(
			"nano-unanswered",
			() => `[${localStamp(this.config)}] [The owner said: "${clip(spoken)}". It only closed the exchange, so no reply was sent.]`,
		);
	}

	private dispatch(work: Work & { from: "owner" }): void {
		const { spoken, images } = work;
		const run = this.run;
		const streaming = run !== undefined && this.session?.isStreaming === true;
		if (this.config.inbound === "interrupt" && run?.from === "owner") {
			// During the owner's own turn every new text goes through the queue (never Pi's steering
			// queue), so one turn answers them all, in order.
			void this.queue.pushNext(work);
			// Still setting up: the turn takes it into its prompt.
			if (run.phase === "setup" || run.interrupted) return;
			run.interrupted = true;
			// A reply still being written, or a wait to retry a failed call, is cancelled now. Otherwise
			// the cancel waits for the next model call (the run starting, tools finishing) and never
			// comes if the run ends.
			if (run.phase === "model" || this.session?.isRetrying) this.abortRun();
			return;
		}
		if (this.config.inbound === "interrupt") {
			// A scheduled job or task result is never cancelled, and the text is not steered into it
			// (it could be answered "[silent]", or land after the run ends): it gets the next turn.
			void this.queue.pushNext(work);
			return;
		}
		if (streaming && this.config.inbound === "steer" && run.phase !== "done") {
			void this.session?.steer(this.stamp(spoken), images).catch((error) => this.fail(error));
			return;
		}
		void this.queue.push(work);
	}

	private abortRun(): void {
		if (this.run) this.run.aborted = true;
		void this.session?.abort().catch((error) => console.error("nano: abort failed:", error));
	}

	private async turn(batch: Work[]): Promise<void> {
		const run: RunState = { from: batch[0]?.from ?? "system", phase: "setup", interrupted: false, aborted: false };
		this.run = run;
		const typing = setInterval(() => void this.channel.typing(this.spaceId, true), TYPING_REFRESH_MS);
		void this.channel.typing(this.spaceId, true);
		try {
			const { session, carry } = await this.ensureSession();
			// Noted before the session existed. A new context window already carries them over in `carry`.
			const pending = this.notes.splice(0);
			if (!carry) for (const note of pending) await this.recordNote(session, note.customType, note.make());
			const intro = carry
				? `[New context window after a gap. The last messages before it, for continuity only:\n${carry}]\n\n`
				: "";
			// Owner messages that arrived while the session was being set up join this prompt.
			if (run.from === "owner" && this.config.inbound === "interrupt") batch = [...batch, ...this.queue.takeNext("owner")];
			run.phase = "starting";
			const images = batch.flatMap((w) => (w.from === "owner" ? w.images : []));
			const body = batch.map((w) => (w.from === "owner" ? this.stamp(w.spoken) + this.routerNotes(w) : this.stamp(w.text, w.note))).join("\n\n");
			// Thinking is turned off only when every message in the turn was judged simple, and back on right after.
			const owners = batch.filter((w) => w.from === "owner");
			const thinking = session.thinkingLevel;
			const quick = owners.length === batch.length && owners.every((w) => w.simple) && thinking !== "off";
			if (quick) session.setThinkingLevel("off"); // this session only, never the saved default
			try {
				await session.prompt(intro + body, images.length > 0 ? { images } : undefined);
			} finally {
				if (quick) session.setThinkingLevel(thinking);
			}
		} catch (error) {
			await this.fail(error);
		} finally {
			this.run = undefined;
			clearInterval(typing);
			void this.channel.typing(this.spaceId, false);
			this.state.sessionFile = this.session?.sessionFile ?? this.state.sessionFile;
			this.store.save();
		}
	}

	/** The router's notes and picked skill for one owner message. A skill goes in once per session. */
	private routerNotes(work: Work & { from: "owner" }): string {
		const notes = [...(work.hints ?? [])];
		if (work.skill && !this.injectedSkills.has(work.skill.name)) {
			try {
				notes.push(skillBlock(work.skill.name, readFileSync(work.skill.path, "utf8")));
				this.injectedSkills.add(work.skill.name);
			} catch (error) {
				console.error(`nano: skill ${work.skill.name} not read:`, (error as Error)?.message ?? error);
			}
		}
		return notes.map((n) => `\n[${n}]`).join("");
	}

	private stamp(body: string, note?: string): string {
		const when = `[${localStamp(this.config)}]`;
		return note ? `${when} [Not from the owner. ${note}]\n${body}` : `${when}\n${body}`;
	}

	private async ensureSession(): Promise<{ session: AgentSession; carry: string }> {
		await refreshProviderSettings(this.config, this.modelRuntime);
		const selected = getMainModel(this.config, this.modelRuntime);
		if (this.session && selected && (this.session.model?.id !== selected.id || this.session.model?.provider !== selected.provider || this.providerRevision !== this.config.providerRevision)) await this.session.setModel(selected);
		this.providerRevision = this.config.providerRevision;
		const cutoff = this.rolloverAt ?? (isIdle(this.state.lastActivity, this.config.idleHours) ? Date.now() : undefined);
		this.rolloverAt = undefined;
		const idle = cutoff !== undefined;
		if (this.session && !idle) return { session: this.session, carry: "" };
		if (this.session) await this.dispose();

		const resume = !idle && this.state.sessionFile && existsSync(this.state.sessionFile) ? this.state.sessionFile : undefined;
		if (!selected) throw new Error(`Unknown model ${this.config.modelProvider}/${this.config.modelId}`);
		const session = await createNanoSession({
			config: this.config,
			modelRuntime: this.modelRuntime,
			model: selected,
			systemPrompt: buildSystemPrompt(this.config),
			extensionFactories: [
				nanoTools(this.config, this.channel, this.scheduler, this.spaceId, { modelRuntime: this.modelRuntime }),
				taskTools(this.config, this.tasks, this.spaceId),
				...(await packExtensions({
					config: this.config,
					channel: this.channel,
					scheduler: this.scheduler,
					spaceId: this.spaceId,
					Type,
				})),
			],
			sessionsDir: join(this.config.dataDir, "sessions"),
			resume,
		});

		this.unsubscribe = session.subscribe((event) => {
			const run = this.run;
			if (run && (event.type === "agent_start" || event.type === "turn_start")) {
				run.phase = "model";
				// A cancel that waited for the run to start or for tools to finish happens here.
				if (run.interrupted && !run.aborted) this.abortRun();
			}
			// Once a tool call is being written it is left to run; a cancel waits for the next model call.
			if (run && event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") run.phase = "tools";
			// A system turn sends its final answer once, when the run ends, the way a worker takes the last assistant text.
			if (run && event.type === "agent_end") {
				run.phase = "done";
				if (run.from === "system" && !event.willRetry) this.saySystemAnswer(event.messages);
			}
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			// A cancelled reply is never sent, not even the part already written.
			if (event.message.stopReason === "aborted") return;
			const toolCalls = event.message.content.filter((c) => c.type === "toolCall");
			const hasToolCall = toolCalls.length > 0;
			if (run) run.phase = hasToolCall ? "tools" : "done";
			// Owner turns stream each assistant message. A system turn waits for agent_end.
			if (run?.from === "system") return;
			// `delegate` returns immediately and the model replies right after; sending text here causes a duplicate ack.
			if (hasToolCall && toolCalls.every((c) => c.name === "delegate")) return;
			const { text, error } = assistantText(event.message);
			this.sayAssistant(text, error);
		});
		this.session = session;
		this.injectedSkills = new Set();
		// Only what came before the gap: the message that ended it is the prompt itself.
		const carry = resume ? "" : carryOver(this.state.recent.filter((turn) => cutoff === undefined || turn.at < cutoff));
		console.error(`nano: ${resume ? "resumed" : "started"} session for ${this.spaceId.slice(-4)} (${session.sessionFile ?? "memory"})`);
		return { session, carry };
	}

	/**
	 * The last assistant text of this run, sent once. Same choice a worker makes with
	 * `getLastAssistantText` after its prompt: earlier narration stays in the session.
	 */
	private saySystemAnswer(messages: readonly unknown[]): void {
		if (this.run?.aborted) return;
		let last: unknown;
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as { role?: string }).role === "assistant") {
				last = messages[i];
				break;
			}
		}
		if (!last || (last as { stopReason?: string }).stopReason === "aborted") return;
		const { text, error } = assistantText(last);
		this.sayAssistant(text, error);
	}

	private sayAssistant(text: string, error?: string): void {
		if (text) void this.say(text);
		else if (error) void this.say(`I hit an error talking to the model: ${error.slice(0, 200)}`);
	}

	private async say(text: string): Promise<void> {
		// A scheduled task with nothing worth reporting answers [silent].
		if (isSilent(text)) return;
		this.record("nano", text);
		try {
			await this.channel.send(this.spaceId, text);
		} catch (error) {
			console.error("nano: send failed:", (error as Error)?.message ?? error);
		}
	}

	private async fail(error: unknown): Promise<void> {
		const reason = (error as Error)?.message ?? String(error);
		console.error("nano: turn failed:", error);
		await this.say(`Something went wrong on my side: ${reason.slice(0, 200)}`);
	}

	private record(role: RecentTurn["role"], text: string): void {
		const at = Date.now();
		this.state.lastActivity = at;
		this.state.recent.push({ role, text: text.slice(0, 2000), at });
		if (this.state.recent.length > RECENT_KEEP) this.state.recent.splice(0, this.state.recent.length - RECENT_KEEP);
		this.store.save();
		const tz = currentTimezone(this.config);
		const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
		const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);
		appendFileSync(join(this.config.dataDir, "log", `${day}.md`), `- ${time} **${role}**: ${text.replace(/\n/g, "\n  ")}\n`);
	}
}
