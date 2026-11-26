import type { CaptureSource } from "../../src/capture.ts";
import type { Config } from "../../src/config.ts";
import { Auth } from "./lib/auth.ts";
import { realIo } from "./lib/cli.ts";
import { gmailCommands } from "./lib/gmail.ts";
import { Api, type Ctx } from "./lib/http.ts";
import { CliError, type Io, ownerTimezone } from "./lib/util.ts";

const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/;
const MAX_THREAD_MESSAGES = 5;

/** Errors that will not succeed on retry (message deleted, missing OAuth scope, API disabled). */
function isDefiniteReadFailure(error: unknown): boolean {
	if (!(error instanceof CliError)) return false;
	return /Not found \(HTTP 404\)|permission for this request|Google API not enabled/i.test(error.message);
}

/**
 * Background filing (src/capture.ts) of emails the inbox watch judged worth filing: the filer may read only the
 * email(s) its item is about, and no other. Message ids come from the item, never from the model.
 */
export default function googleCapture(ctx?: { config?: Pick<Config, "dataDir">; io?: () => Io }): Record<string, CaptureSource> {
	return {
		gmail: {
			tools(payload) {
				const rawIds = Array.isArray(payload.messageIds) ? payload.messageIds : [payload.messageId];
				const ids = [...new Set(rawIds.filter((v): v is string => typeof v === "string" && MESSAGE_ID.test(v)))].slice(0, MAX_THREAD_MESSAGES);
				if (ids.length === 0) return [];
				return [
					{
						name: "gmail_read",
						description: "Read the full email this item is about, when the subject and snippet are not enough.",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						async run(_args, signal) {
							const out: string[] = [];
							const base = ctx?.io ? ctx.io() : realIo();
							const env = ctx?.config?.dataDir ? { ...base.env, NANO_DATA_DIR: ctx.config.dataDir } : base.env;
							const io: Io = {
								...base,
								env,
								fetch: (input, init) => {
									const combined = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
									return base.fetch(input, { ...init, signal: combined });
								},
								out: (text: string) => void out.push(text),
								err: () => {},
							};
							// A fresh Auth each time, so a token the owner's other tools refreshed or replaced is picked up.
							const auth = new Auth(io);
							const apiCtx: Ctx = { io, auth, api: new Api(io, auth), tz: ownerTimezone(io.env) };
							const perMessage = Math.max(1200, Math.floor(6000 / ids.length));
							try {
								await gmailCommands.read(apiCtx, ["--max-chars", String(perMessage), "--", ...ids]);
							} catch (error) {
								if (isDefiniteReadFailure(error)) {
									return `The email could not be read: ${((error as Error)?.message ?? String(error)).slice(0, 200)}`;
								}
								throw error;
							}
							return out.join("\n") || "The email has no readable text.";
						},
					},
				];
			},
		},
	};
}
