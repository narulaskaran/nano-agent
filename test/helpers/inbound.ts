import { type InboundFile, normalizeInbound } from "../../src/channel.ts";

/** What `normalizeInbound` makes of one inbound message's content. */
export async function normalize(content: unknown, saveBinary: (content: any) => Promise<InboundFile | undefined> = async () => undefined) {
	const out = { text: [] as string[], files: [] as InboundFile[] };
	await normalizeInbound(content, out, saveBinary);
	return out;
}
