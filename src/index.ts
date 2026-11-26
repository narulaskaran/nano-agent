import { join } from "node:path";
import { Conversation, StateStore } from "./agent.ts";
import { type Compose, createCapture } from "./capture.ts";
import { composeWith } from "./compose.ts";
import { createDecider, decisionTransport } from "./decide.ts";
import { type Channel, createPhotonChannel, createStdinChannel } from "./channel.ts";
import { currentTimezone, loadConfig, startTimezoneSync } from "./config.ts";
import { completeText, createModelRuntime, getBackgroundModel, getMainModel, localProviderId } from "./models.ts";
import { createOutbound } from "./outbound.ts";
import { refreshProviderSettings } from "./provider-settings.ts";
import { extendPath, packCaptureSources, skillPaths, startPackServices } from "./packs.ts";
import { profileExists } from "./prompt.ts";
import { providerFetch } from "./provider-client.ts";
import { openQueueDb } from "./queue.ts";
import { Scheduler } from "./scheduler.ts";
import { TaskManager } from "./tasks.ts";
import { createWorkerRunner } from "./worker.ts";

const HAND_BACK_NOTE = "Result of a background task, for you to relay";

async function main(): Promise<void> {
	const config = loadConfig();
	extendPath(config);
	const modelRuntime = await createModelRuntime(config);
	const model = modelRuntime.getModel(config.modelProvider, config.modelId);
	if (!model) {
		const known = modelRuntime.getModels(config.modelProvider).map((m) => m.id);
		throw new Error(
			`Unknown model ${config.modelProvider}/${config.modelId}.` +
				(known.length > 0 ? ` Models for ${config.modelProvider}: ${known.join(", ")}` : " Unknown provider."),
		);
	}

	console.error(
		`nano: model ${config.modelProvider}/${config.modelId}, local ${config.local ? `${config.local.modelId} at ${config.local.baseUrl}` : "none"}, ` +
			`timezone ${currentTimezone(config)}, packs [${config.packs.join(", ")}], skill dirs ${skillPaths(config).length}, ` +
			`profile ${profileExists(config) ? "found" : "missing (first-run onboarding)"}, kb ${config.kbDir}`,
	);

	// `--check` verifies configuration and model access, then exits. Used by setup and by coding agents.
	if (process.argv.includes("--check")) {
		const available = await modelRuntime.getAllAvailable(config.modelProvider);
		if (!available.some((m) => m.id === config.modelId)) {
			throw new Error(`No credentials for ${config.modelProvider}. Set its API key in .env (see .env.example).`);
		}
		if (config.local) {
			if (!modelRuntime.getModel(localProviderId(config.local), config.local.modelId)) throw new Error("The local model could not be registered.");
			const response = await (config.local.vault ? providerFetch("/providers/config") : fetch(`${config.local.baseUrl}/models`, { signal: AbortSignal.timeout(5000) })).catch((error: Error) => error);
			if (response instanceof Error || !response.ok) {
				throw new Error(`Local model endpoint ${config.local.baseUrl} is not reachable (${response instanceof Error ? response.message : `HTTP ${response.status}`}).`);
			}
		}
		console.error("nano: check ok");
		return;
	}

	const channel: Channel = config.channel === "stdin" ? createStdinChannel() : await createPhotonChannel(config);
	// One decider for the router, the gate and failure triage: transport, log and the private-input rule.
	const decider = createDecider({ dataDir: config.dataDir, transport: decisionTransport() });
	const store = new StateStore(config.dataDir);
	const conversations = new Map<string, Conversation>();
	// Durable queues (queue.ts): owner messages sent outside a reply, and background knowledge-base filing.
	const db = openQueueDb(config.dataDir);
	const outbound = createOutbound({ db, channel, delivered: (spaceId, text) => conversation(spaceId).delivered(text) });
	const compose: Compose = async (system, user, signal, options) => {
		await refreshProviderSettings(config, modelRuntime);
		const main = getMainModel(config, modelRuntime);
		const composer = (options?.role === "background" ? getBackgroundModel(config, modelRuntime) : undefined) ?? main;
		if (!composer) throw new Error("The main model is unavailable");
		if (options?.tools?.length) return composeWith((context, abort) => modelRuntime.completeSimple(composer, context, { signal: abort }), system, user, signal, options);
		const reply = await completeText(modelRuntime, composer, system, [user], { signal });
		if (reply.error) throw new Error(reply.error);
		return reply.text;
	};
	const capture = createCapture({ db, kbDir: config.kbDir, dataDir: config.dataDir, compose, sources: await packCaptureSources(config) });
	const scheduler: Scheduler = new Scheduler(config, {
		send: (spaceId, text, dedupe) => conversation(spaceId).deliver(text, dedupe),
		task: (spaceId, prompt) => conversation(spaceId).inject(prompt),
		background: async (spaceId, work) => {
			tasks.start({
				title: work.title,
				instructions: work.instructions,
				role: work.model ?? "main",
				private: Boolean(work.private),
				spaceId,
				source: "schedule",
				jobId: work.jobId,
				repairOf: work.repairOf,
			});
		},
	}, { decider });
	const tasks: TaskManager = new TaskManager({
		path: join(config.dataDir, "tasks.json"),
		maxConcurrent: config.maxTasks,
		timeoutMs: config.taskTimeoutMs,
		runner: createWorkerRunner({ config, modelRuntime, scheduler }),
		handBack: (spaceId, prompt) => conversation(spaceId).inject(prompt, HAND_BACK_NOTE),
		onJobRunEnded: (task) => scheduler.taskEnded(task),
	});
	function conversation(spaceId: string): Conversation {
		let c = conversations.get(spaceId);
		if (!c) {
			c = new Conversation(spaceId, config, channel, store, modelRuntime, scheduler, tasks, { decider, outbound: outbound.send, capture });
			conversations.set(spaceId, c);
		}
		return c;
	}

	let stopping = false;
	const packServices = new AbortController();
	const queues = new AbortController();
	const queueRuns: Promise<void>[] = [];
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.error(`nano: ${signal}, shutting down`);
		packServices.abort();
		scheduler.stop();
		tasks.stop();
		// Sends in flight get a few seconds to finish before the channel closes; the rest wait in the queue for the restart.
		queues.abort();
		await Promise.allSettled(queueRuns);
		await Promise.allSettled([...conversations.values()].map((c) => c.dispose()));
		await channel.stop().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	startTimezoneSync(process.env.NANO_TZ_URL);
	queueRuns.push(
		outbound.run(queues.signal).catch((error) => console.error("nano: outbound queue stopped:", error)),
		capture.run(queues.signal).catch((error) => console.error("nano: capture queue stopped:", error)),
	);
	scheduler.start();
	void tasks.reportLost();
	void startPackServices({
		config,
		decider,
		signal: packServices.signal,
		notifyOwner: (text, options) => conversation(config.owner).deliver(text, options?.dedupe),
		compose,
	});
	console.error(`nano: listening on ${config.channel}, ${scheduler.list().length} scheduled job(s), up to ${config.maxTasks} background task(s)`);
	await channel.start((message) => conversation(message.spaceId).receive(message));
	await shutdown("channel closed");
}

main().catch((error) => {
	console.error(`nano: fatal: ${(error as Error)?.message ?? error}`);
	process.exit(1);
});
