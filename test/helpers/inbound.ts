import { type InboundFile, type NormalizedInbound, normalizeInbound } from "../../src/channel.ts";

/** What `normalizeInbound` makes of one inbound message's content. */
export async function normalize(content: unknown, saveBinary: (content: any) => Promise<InboundFile | undefined> = async () => undefined) {
	const out: NormalizedInbound = { text: [], files: [] };
	await normalizeInbound(content, out, saveBinary);
	return out;
}
