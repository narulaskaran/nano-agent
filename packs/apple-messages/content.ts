import { createHash } from "node:crypto";
import type { Message } from "./client.ts";

export const MENTION = /\bnano\b/iu;
const CODE_LABEL = /\b(?:otp|one[ -]time (?:code|password)|2fa|mfa|passcode|(?:verification|auth(?:entication)?|security|login|log[ -]in|sign[ -]in|access|confirmation|password reset) code|do not share)\b/iu;
const CODE_VALUE = /\b\d(?:[ -]?\d){3,7}\b/u;
const CONTACT = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\w)(?:\+\d{8,15}|(?:\+?\d{1,3}[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4})(?!\w)/iu;
const SECRET = /\b(?:password|api[ _-]?key|access[ _-]?token|secret)\s*(?:=|:)\s*\S|\bBearer\s+[\w.-]{8,}/iu;

export function looksLikeCode(text: string): boolean {
	return CODE_LABEL.test(text) && CODE_VALUE.test(text);
}

export function privatePattern(text: string): boolean {
	return looksLikeCode(text) || CONTACT.test(text) || SECRET.test(text);
}

export function isNanoPost(message: Pick<Message, "is_from_me" | "text">): boolean {
	return message.is_from_me && !!message.text?.trimStart().startsWith("🤖");
}

export function speakerLabel(chat: string, actor: string | undefined, owner: boolean): string {
	if (owner) return "Owner";
	if (!actor) return "Participant";
	const key = createHash("sha256").update(chat.toLowerCase()).update("\0").update(actor.trim().toLowerCase()).digest("hex");
	return `Participant ${key.slice(0, 8)}`;
}

export function memoryBody(message: Message): string | undefined {
	const text = message.text?.trim();
	if (!text || isNanoPost(message) || privatePattern(text) || message.attachments.some((item) => item?.mime_type?.startsWith("audio/"))) return;
	return text.slice(0, 1000);
}
