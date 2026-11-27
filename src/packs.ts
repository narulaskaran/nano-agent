import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Channel } from "./channel.ts";
import type { CaptureSource } from "./capture.ts";
import type { ComposeOptions } from "./compose.ts";
import type { Config } from "./config.ts";
import type { Decider } from "./decide.ts";
import type { Scheduler } from "./scheduler.ts";

/**
 * A pack is a folder that adds a capability:
 *
 *   <pack>/skills/<skill>/SKILL.md   Agent Skills, advertised to the model
 *   <pack>/extension.ts              optional: default export (ctx) => ExtensionFactory | ExtensionFactory[]
 *   <pack>/service.ts                optional: one background service for the Nano process
 *   <pack>/capture.ts                optional: tools lent to the background KB filer for this pack's items (capture.ts)
 *   <pack>/bin/                      optional: commands put on PATH for the agent's shell
 *   <pack>/install.sh                optional: run as root when the image is built (repo packs only)
 *   <pack>/start-root.sh             optional: run as root at container start, before privileges drop (repo packs only)
 *   <pack>/env.example               optional: settings the pack reads
 *
 * Packs shipped with Nano live in `packs/`. Private ones live in `<data>/packs/` and are
 * never part of the repository. `NANO_PACKS` names the ones to load; a private pack wins
 * over a shipped pack of the same name.
 */
export interface PackContext {
	config: Config;
	channel: Channel;
	scheduler: Scheduler;
	/** The conversation this session belongs to. */
	spaceId: string;
	/** TypeBox, for tool parameter schemas. Passed in so private packs need no node_modules. */
	Type: typeof Type;
	/**
	 * Set when the session is a background worker rather than the conversation with the owner.
	 * `channel` then collects what is sent into the task's result instead of reaching the owner.
	 */
	worker?: { taskId: string; title: string; private: boolean };
}

type PackExtension = (ctx: PackContext) => ExtensionFactory | ExtensionFactory[];

export interface PackServiceContext {
	config: Config;
	decider: Decider;
	signal: AbortSignal;
	/**
	 * Queue a message to the owner for durable delivery (outbound.ts). Resolves once it is queued. A repeated `dedupe`
	 * is ignored, so a pack that crashed before recording its own progress does not notify twice.
	 */
	notifyOwner: (text: string, options?: { dedupe?: string }) => Promise<void>;
	/**
	 * Schedule a one-time reminder to the owner (scheduler.ts): `text` is sent to them word for word at `at`, and they can
	 * list and cancel it like any other job. A `key` that is already scheduled adds nothing and returns that job's time.
	 */
	remindOwner: (reminder: { key: string; name: string; text: string; at: number }) => { at: number };
	/**
	 * One completion on the main model (or the background model, with `options.role`) with the given system prompt: no
	 * owner profile or memory, no conversation, and no tools except the ones the caller lends in `options.tools` (see
	 * compose.ts). For text written to third parties, which must not carry the owner's context.
	 */
	compose: (system: string, user: string, signal: AbortSignal, options?: ComposeOptions) => Promise<string>;
}

/** `PackServiceContext.remindOwner`: a plain one-time message job addressed to the owner, and nothing else. */
export function ownerReminders(scheduler: Pick<Scheduler, "add">, owner: string): PackServiceContext["remindOwner"] {
	return ({ key, name, text, at }) => ({ at: scheduler.add({ key, name, kind: "message", body: text, at, spaceId: owner }).at! });
}

export async function startPackServices(ctx: PackServiceContext): Promise<void> {
	await Promise.all(packDirs(ctx.config).map(async (dir) => {
		const file = join(dir, "service.ts");
		if (!existsSync(file)) return;
		try {
			const service = (await import(pathToFileURL(file).href)).default;
			if (!ctx.signal.aborted) await service(ctx);
		} catch (error) {
			if (!ctx.signal.aborted) console.error(`nano: pack service ${file} stopped:`, (error as Error)?.message ?? error);
		}
	}));
}

/**
 * Tools packs lend the background filer (capture.ts) for items from their own source: `<pack>/capture.ts` default-exports
 * a function returning `{ <source>: CaptureSource }`.
 */
export async function packCaptureSources(config: Config): Promise<Record<string, CaptureSource>> {
	const sources: Record<string, CaptureSource> = {};
	for (const dir of packDirs(config)) {
		const file = join(dir, "capture.ts");
		if (!existsSync(file)) continue;
		try {
			const module = (await import(pathToFileURL(file).href)) as { default?: (ctx: { config: Config }) => Record<string, CaptureSource> };
			if (typeof module.default !== "function") throw new Error("capture.ts has no default export function");
			Object.assign(sources, module.default({ config }));
		} catch (error) {
			console.error(`nano: pack capture tools ${file} failed to load:`, (error as Error)?.message ?? error);
		}
	}
	return sources;
}

/** Missing packs already reported. One line per pack per process, not per message. */
const missingPackLogged = new Set<string>();

export function packDirs(config: Config): string[] {
	const dirs: string[] = [];
	for (const name of config.packs) {
		const found = [join(config.dataDir, "packs", name), join(config.appDir, "packs", name)].find((d) => existsSync(d));
		if (found) dirs.push(found);
		else if (!missingPackLogged.has(name)) {
			missingPackLogged.add(name);
			console.error(`nano: pack "${name}" not found in ${config.dataDir}/packs or ${config.appDir}/packs`);
		}
	}
	return dirs;
}

/** Skill folders of the enabled packs, plus loose skills the agent or owner added at runtime. */
export function skillPaths(config: Config): string[] {
	const paths = packDirs(config)
		.map((dir) => join(dir, "skills"))
		.filter((dir) => existsSync(dir));
	const own = join(config.dataDir, "skills");
	if (existsSync(own)) paths.push(own);
	return paths;
}

/** Put Nano's own commands, pack commands and `<data>/bin` on PATH once at startup. */
export function extendPath(config: Config): void {
	const bins = [join(config.appDir, "bin"), ...packDirs(config).map((dir) => join(dir, "bin")), join(config.dataDir, "bin")].filter((dir) =>
		existsSync(dir),
	);
	if (bins.length > 0) process.env.PATH = [...bins, process.env.PATH ?? ""].join(delimiter);
}

export async function packExtensions(ctx: PackContext): Promise<ExtensionFactory[]> {
	const factories: ExtensionFactory[] = [];
	for (const dir of packDirs(ctx.config)) {
		const file = join(dir, "extension.ts");
		if (!existsSync(file)) continue;
		try {
			const module = (await import(pathToFileURL(file).href)) as { default?: PackExtension };
			if (typeof module.default !== "function") throw new Error("extension.ts has no default export function");
			factories.push(...[module.default(ctx)].flat());
		} catch (error) {
			console.error(`nano: pack extension ${file} failed to load:`, (error as Error)?.message ?? error);
		}
	}
	return factories;
}
