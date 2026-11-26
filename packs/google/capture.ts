import type { CaptureSource } from "../../src/capture.ts";
import { Auth } from "./lib/auth.ts";
import { realIo } from "./lib/cli.ts";
import { gmailCommands } from "./lib/gmail.ts";
import { Api, type Ctx } from "./lib/http.ts";
import { ownerTimezone } from "./lib/util.ts";

/**
 * Background filing (src/capture.ts) of emails the inbox watch judged worth filing: the filer may read the one email
 * its item is about, and no other. The message id comes from the item, never from the model.
 */
export default function googleCapture(): Record<string, CaptureSource> {
	return {
		gmail: {
			tools(payload) {
				const id = typeof payload.messageId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(payload.messageId) ? payload.messageId : undefined;
				if (!id) return [];
				return [
					{
						name: "gmail_read",
						description: "Read the full email this item is about, when the subject and snippet are not enough.",
						parameters: { type: "object", properties: {}, additionalProperties: false },
						async run() {
							const out: string[] = [];
							const io = { ...realIo(), out: (text: string) => void out.push(text), err: () => {} };
							// A fresh Auth each time, so a token the owner's other tools refreshed or replaced is picked up.
							const auth = new Auth(io);
							const ctx: Ctx = { io, auth, api: new Api(io, auth), tz: ownerTimezone(io.env) };
							try {
								await gmailCommands.read(ctx, [id, "--max-chars", "6000"]);
							} catch (error) {
								return `The email could not be read: ${((error as Error)?.message ?? String(error)).slice(0, 200)}`;
							}
							return out.join("\n") || "The email has no readable text.";
						},
					},
				];
			},
		},
	};
}
