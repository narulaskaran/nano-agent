import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Channel } from "./channel.ts";
import { type Config, currentTimezone } from "./config.ts";
import { ask, askLocal, type ChatFn } from "./local.ts";
import { chooseModel, completeText, getMainModel } from "./models.ts";
import { DEFAULT_PDF_DPI, DEFAULT_PDF_PAGES, MAX_PDF_DPI, MAX_PDF_PAGES, MIN_PDF_DPI, viewPdf } from "./pdf.ts";
import { cronMatches, type Job, parseLocalTime, type Scheduler } from "./scheduler.ts";
import { workspaceDir } from "./session.ts";

export const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

export const ModelParam = Type.Optional(
	Type.Union([Type.Literal("main"), Type.Literal("local")], {
		description: 'Model to run on. "local": the owner\'s own local model (falls back to the main model if none is configured). Default "main".',
	}),
);
export const PrivateParam = Type.Optional(
	Type.Boolean({
		description: "Sensitive content (emails, health, finances, documents): runs only on the local model and is refused if there is none. Only the final answer comes back to you.",
	}),
);

/** Refuse private work up front when it could only run on the cloud model. */
export function assertPrivateAllowed(config: Config, isPrivate: boolean | undefined): void {
	const choice = chooseModel("local", Boolean(isPrivate), Boolean(config.local));
	if ("refuse" in choice) throw new Error(choice.refuse);
}

const workspacePath = (config: Config, path: string) => (isAbsolute(path) ? path : join(workspaceDir(config), path));

/** One-shot fallback on the main model, for non-private ask_local calls when no local model is configured. */
function mainChat(config: Config, modelRuntime: ModelRuntime): ChatFn {
	return async (messages, extra, signal) => {
		if (extra.response_format) return { status: 400, text: "constrained output not supported" };
		const model = getMainModel(config, modelRuntime);
		if (!model) return { status: 404, text: "main model not found" };
		const [system, ...rest] = messages;
		const reply = await completeText(modelRuntime, model, system?.content, rest.map((m) => m.content), { maxTokens: 2048, signal });
		if (reply.error) return { status: 500, text: reply.error };
		return { status: 200, text: reply.text };
	};
}

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Enough for the 20k-character page text after HTML is stripped. */
export const WEB_FETCH_BYTE_CAP = 2 * 1024 * 1024;

const BINARY_MEDIA = new Set(["application/octet-stream", "application/pdf"]);

function mediaType(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** image, audio, video, PDF, and opaque bytes are not page text. */
function isBinaryContent(contentType: string): boolean {
	const mime = mediaType(contentType);
	return mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || BINARY_MEDIA.has(mime);
}

/**
 * Decode at most `cap` bytes. `TextDecoder` stays in streaming mode so a character
 * split across chunks survives; the unread remainder is cancelled.
 */
export async function readCappedText(stream: ReadableStream<Uint8Array> | null, cap: number): Promise<{ text: string; bytes: number; cut: boolean }> {
	if (!stream) return { text: "", bytes: 0, cut: false };
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const parts: string[] = [];
	let bytes = 0;
	let cut = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const room = cap - bytes;
			if (value.byteLength > room) {
				if (room > 0) parts.push(decoder.decode(value.subarray(0, room), { stream: true }));
				bytes += room;
				cut = true;
				break;
			}
			parts.push(decoder.decode(value, { stream: true }));
			bytes += value.byteLength;
		}
		parts.push(decoder.decode());
	} finally {
		await reader.cancel().catch(() => {});
	}
	return { text: parts.join(""), bytes, cut };
}

function describeJob(job: Job, timeZone: string): string {
	const when = job.at
		? new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(job.at)
		: `cron ${job.cron}${job.until ? ` until ${new Date(job.until).toISOString().slice(0, 10)}` : ""}`;
	const background = job.background ? ` [background${job.private ? ", private" : job.model === "local" ? ", local" : ""}]` : "";
	const gate = job.gate ? ` [gate${job.gate.shadow ? ", shadow" : ""}]` : "";
	return `${job.id} | ${job.name} | ${job.kind}${job.then ? `->${job.then}` : ""}${background}${gate} | ${when} | ${describeHealth(job, timeZone)} | ${job.body.replace(/\s+/g, " ").slice(0, 120)}`;
}

/** Health column of schedule_list, so a broken job is visible without reading logs. */
function describeHealth(job: Job, timeZone: string): string {
	if (job.cron) {
		try {
			cronMatches(job.cron, new Date(), timeZone);
		} catch (error) {
			return `UNUSABLE SCHEDULE (${(error as Error).message})`;
		}
	}
	const stamp = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "short", timeStyle: "short" }).format(ms);
	const health = job.health;
	if (health?.failures) {
		const notes = [health.repairAt !== undefined ? "repair tried" : "", health.escalated ? "owner told" : ""].filter(Boolean).join(", ");
		return `FAILING x${health.failures} since ${stamp(health.since ?? health.lastFailure ?? Date.now())}${notes ? ` (${notes})` : ""}: ${(health.lastError ?? "").slice(0, 120)}`;
	}
	if (health?.lastSuccess) return `ok, last ${stamp(health.lastSuccess)}`;
	return job.lastFired ? "ran, no health record" : "not run yet";
}

/**
 * Tools Nano adds on top of Pi's built-in read/bash/edit/write/grep/find/ls.
 * In a background worker (`worker: true`), `channel` is a buffer: nothing reaches the owner directly.
 */
export function nanoTools(
	config: Config,
	channel: Channel,
	scheduler: Scheduler,
	spaceId: string,
	extra: { modelRuntime: ModelRuntime; worker?: boolean },
): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "schedule_add",
			label: "Schedule",
			description: [
				"Schedule something for later: a reminder, a recurring check, a monitor.",
				'kind "message": send `body` to the owner word for word at that time. Use for plain reminders.',
				'kind "task": at that time you receive `body` as instructions and act on them with your tools. Use when the reminder depends on checking something first, or for recurring research. Write `body` so it makes sense with no other context. If there is nothing worth telling the owner, reply exactly [silent].',
				'kind "script": run `body` as a shell command. No output means nothing is sent. Output is sent as is (then "send") or handed to you to judge (then "task"). Use for cheap monitors that should only speak on change.',
				"Give exactly one of `at` (one time, owner's local time like 2026-11-12T09:00) or `cron` (five fields, owner's local time).",
				"`background: true` (task, or script with then \"task\"): the work runs in a separate background session so it never blocks chatting; only its final answer comes back to you to pass on, and [silent] still means nothing is sent. Use it for slow jobs (research, browsing, many tool calls). `model` and `private` choose where it runs.",
				'`gate` (script only, not private): a decision model reads the output first and only lets it through (to "send" or "task") when it matches `gate.notify`; it also drops what this job already told the owner. Unsure or failed decisions let it through. `gate.shadow: true` logs the decision without acting on it.',
			].join("\n"),
			parameters: Type.Object({
				name: Type.String({ description: "Short label, e.g. 'Return shoes'" }),
				kind: Type.Union([Type.Literal("message"), Type.Literal("task"), Type.Literal("script")]),
				body: Type.String(),
				at: Type.Optional(Type.String()),
				cron: Type.Optional(Type.String()),
				until: Type.Optional(Type.String({ description: "For cron jobs: stop after this local time" })),
				then: Type.Optional(Type.Union([Type.Literal("send"), Type.Literal("task")])),
				background: Type.Optional(Type.Boolean()),
				model: ModelParam,
				private: PrivateParam,
				gate: Type.Optional(
					Type.Object({
						notify: Type.String({ description: "What makes the output worth telling the owner, e.g. 'a new court ruling, deadline or claim form'" }),
						shadow: Type.Optional(Type.Boolean({ description: "Log decisions only; act as if ungated" })),
						min: Type.Optional(Type.Number({ description: "Stay quiet only when quiet is at least this likely (default 0.8)" })),
					}),
				),
			}),
			async execute(_id, params) {
				const tz = currentTimezone(config);
				if (Boolean(params.at) === Boolean(params.cron)) throw new Error("Give exactly one of `at` or `cron`.");
				const at = params.at ? parseLocalTime(params.at, tz) : undefined;
				if (at !== undefined && at < Date.now() - 60_000) throw new Error(`That time is in the past (${params.at}, ${tz}).`);
				const then = params.kind === "script" ? (params.then ?? "send") : undefined;
				const usesAgent = params.kind === "task" || then === "task";
				if ((params.background || params.model || params.private) && !usesAgent) {
					throw new Error('background, model and private apply to kind "task" or a script with then "task".');
				}
				// Private or local work only makes sense off the main thread, which always runs on the main model.
				const background = Boolean(params.background || params.private || params.model === "local");
				if (params.private) assertPrivateAllowed(config, true);
				const job = scheduler.add({
					name: params.name,
					kind: params.kind,
					body: params.body,
					then,
					at,
					cron: params.cron,
					until: params.until ? parseLocalTime(params.until, tz) : undefined,
					spaceId,
					...(background ? { background, model: params.model, private: params.private || undefined } : {}),
					...(params.gate ? { gate: params.gate } : {}),
				});
				return text(`Scheduled: ${describeJob(job, tz)}`);
			},
		});

		pi.registerTool({
			name: "schedule_list",
			label: "List schedule",
			description: "List everything currently scheduled (id | name | kind | when | health | body). Health shows failing jobs, repairs tried, and the last success.",
			parameters: Type.Object({}),
			async execute() {
				const jobs = scheduler.list();
				const tz = currentTimezone(config);
				return text(jobs.length === 0 ? "Nothing is scheduled." : jobs.map((j) => describeJob(j, tz)).join("\n"));
			},
		});

		pi.registerTool({
			name: "schedule_cancel",
			label: "Cancel schedule",
			description: "Cancel a scheduled job by id (see schedule_list).",
			parameters: Type.Object({ id: Type.String() }),
			async execute(_id, params) {
				const job = scheduler.cancel(params.id);
				if (!job) throw new Error(`No job with id ${params.id}.`);
				return text(`Cancelled: ${job.name}`);
			},
		});

		pi.registerTool({
			name: "send_file",
			label: "Send file",
			description: extra.worker
				? "Attach a file from disk to your result. Nano decides whether to send it to the owner."
				: "Send a file or image from disk to the person you are talking to, as an attachment in the chat. Use for pictures, PDFs, exports. An audio file (m4a/aac, such as a spoken reply from the voice-reply skill) arrives as a native iMessage voice memo that plays inline; pass as_voice: false to send audio as a plain file instead.",
			parameters: Type.Object({
				path: Type.String({ description: "Absolute path, or relative to the workspace" }),
				caption: Type.Optional(Type.String({ description: "Short text sent right after the file" })),
				as_voice: Type.Optional(
					Type.Boolean({
						description:
							"Audio files only. Default (unset): audio is sent as a voice memo. true: insist on a voice memo (m4a/aac plays inline; other formats need conversion). false: send the audio as a plain file attachment.",
					}),
				),
			}),
			async execute(_id, params) {
				const path = workspacePath(config, params.path);
				if (!existsSync(path)) throw new Error(`No such file: ${path}`);
				await channel.sendFile(spaceId, path, params.caption, { asVoice: params.as_voice });
				return text(extra.worker ? `Attached ${path} to your result` : `Sent ${path}`);
			},
		});

		pi.registerTool({
			name: "view_pdf",
			label: "View PDF",
			description: [
				"Render pages of a PDF file as images so you can inspect them directly with vision.",
				"Use this whenever you need to check or read a PDF — especially signatures, filled forms, checkboxes, handwriting, scans, tables or layout. Do not inspect raw PDF bytes or install Python PDF libraries.",
				`Defaults to the first ${DEFAULT_PDF_PAGES} pages (max ${MAX_PDF_PAGES} per call) at ${DEFAULT_PDF_DPI} DPI. Pass \`pages\` (e.g. "1", "2-4", "1,5") for other pages and \`dpi\` (${MIN_PDF_DPI}-${MAX_PDF_DPI}) for finer detail.`,
			].join("\n"),
			parameters: Type.Object({
				path: Type.String({ description: "Absolute path, or relative to the workspace" }),
				pages: Type.Optional(
					Type.String({
						description: `1-indexed pages or ranges to render, e.g. "1", "1-3", "2,4". Default: first ${DEFAULT_PDF_PAGES} pages (max ${MAX_PDF_PAGES} per call).`,
					}),
				),
				dpi: Type.Optional(Type.Number({ description: `Render resolution in DPI (${MIN_PDF_DPI}-${MAX_PDF_DPI}, default ${DEFAULT_PDF_DPI}).` })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const path = workspacePath(config, params.path);
				return await viewPdf(path, { pages: params.pages, dpi: params.dpi }, { signal, model: ctx?.model });
			},
		});

		pi.registerTool({
			name: "ask_local",
			label: "Ask local model",
			description: [
				"One-shot classification or extraction on the owner's local model, over a text or a file, without loading that content into this conversation. Returns only the short answer.",
				"Use it for sorting, tagging, yes/no checks and pulling a few fields out of sensitive or bulky material (emails, documents, logs). Give `choices` to get exactly one label back.",
				"Private by default: with no local model configured it refuses. Pass private: false to allow a one-shot call to the main model instead.",
			].join("\n"),
			parameters: Type.Object({
				instruction: Type.String({ description: "What to decide or extract, e.g. 'Is this email a bill that needs paying?'" }),
				text: Type.Optional(Type.String({ description: "The material, if it is short and already in the conversation" })),
				path: Type.Optional(Type.String({ description: "A file to read instead of `text` (absolute, or relative to the workspace)" })),
				choices: Type.Optional(Type.Array(Type.String(), { description: "Allowed labels; the answer is exactly one of them" })),
				private: Type.Optional(Type.Boolean({ description: "Default true" })),
			}),
			async execute(_id, params, signal) {
				const input = params.path ? readFileSync(workspacePath(config, params.path), "utf8") : params.text;
				const options = { instruction: params.instruction, input, choices: params.choices, signal };
				if (config.local) return text(await askLocal(config.local, options));
				const choice = chooseModel("local", params.private ?? true, false);
				if ("refuse" in choice) throw new Error(choice.refuse);
				const answer = await ask(mainChat(config, extra.modelRuntime), options, 64_000);
				return text(`${answer}\n(${choice.note})`);
			},
		});

		pi.registerTool({
			name: "web_fetch",
			label: "Fetch page",
			description: "Fetch a web page or API URL and return its readable text (HTML is stripped, long pages are cut).",
			parameters: Type.Object({
				url: Type.String(),
				max_chars: Type.Optional(Type.Number({ description: "Default 20000" })),
			}),
			async execute(_id, params, signal) {
				const response = await fetch(params.url, {
					signal: signal ?? AbortSignal.timeout(30_000),
					redirect: "follow",
					headers: { "user-agent": "Mozilla/5.0 (compatible; personal-assistant)", accept: "text/html,*/*" },
				});
				const type = response.headers.get("content-type") ?? "";
				if (isBinaryContent(type)) {
					await response.body?.cancel().catch(() => {});
					throw new Error(`Refusing binary content (${mediaType(type)}).`);
				}
				const download = await readCappedText(response.body, WEB_FETCH_BYTE_CAP);
				const readable = type.includes("html") ? htmlToText(download.text) : download.text;
				const max = params.max_chars ?? 20_000;
				const limited = readable.length > max ? `${readable.slice(0, max)}\n[cut at ${max} of ${readable.length} chars]` : readable;
				const body = download.cut ? [limited, `[cut at ${download.bytes} bytes]`].filter(Boolean).join("\n") : limited;
				return text(`HTTP ${response.status} ${type}\n\n${body}`);
			},
		});

		if (config.braveApiKey) {
			const key = config.braveApiKey;
			pi.registerTool({
				name: "web_search",
				label: "Web search",
				description: "Search the web. Returns titles, URLs and snippets. Follow up with web_fetch to read a result.",
				parameters: Type.Object({
					query: Type.String(),
					count: Type.Optional(Type.Number({ description: "Results to return, default 6, max 20" })),
				}),
				async execute(_id, params, signal) {
					const url = new URL("https://api.search.brave.com/res/v1/web/search");
					url.searchParams.set("q", params.query);
					url.searchParams.set("count", String(Math.min(params.count ?? 6, 20)));
					const response = await fetch(url, {
						signal: signal ?? AbortSignal.timeout(20_000),
						headers: { accept: "application/json", "x-subscription-token": key },
					});
					if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`);
					const data = (await response.json()) as {
						web?: { results?: { title: string; url: string; description?: string; age?: string }[] };
					};
					const results = data.web?.results ?? [];
					if (results.length === 0) return text("No results.");
					return text(
						results
							.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${htmlToText(r.description ?? "")}${r.age ? ` (${r.age})` : ""}`)
							.join("\n\n"),
					);
				},
			});
		}
	};
}
