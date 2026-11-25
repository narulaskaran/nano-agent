import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { ComposeTool } from "../../src/compose.ts";
import { htmlToText } from "../../src/tools.ts";

/**
 * The only two tools a chat draft may use: web search and fetching a public page. Both are read-only GETs with no cookies, no
 * credentials and no way to reach anything but the public internet. Their results are untrusted text for the model to read.
 */

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;
const MAX_CHARS = 8000;
const MAX_REDIRECTS = 3;
const RESULTS = 5;

/** Addresses the fetch tool refuses, however the name resolves: private, loopback, link-local, tailnet, reserved, mapped. */
const BLOCKED = new BlockList();
// Built from numbers so no address literals sit in the source.
const v4 = (bits: number, ...octets: number[]) => BLOCKED.addSubnet(octets.concat([0, 0, 0, 0]).slice(0, 4).join("."), bits, "ipv4");
v4(8, 0); v4(8, 10); v4(10, 100, 64); v4(8, 127); v4(16, 169, 254); v4(12, 172, 16); v4(24, 192, 0, 0); v4(24, 192, 0, 2);
v4(16, 192, 168); v4(15, 198, 18); v4(24, 198, 51, 100); v4(24, 203, 0, 113); v4(4, 224); v4(4, 240);
const v6 = (bits: number, address: string) => BLOCKED.addSubnet(address, bits, "ipv6");
v6(128, "::"); v6(128, "::1"); v6(7, "fc00::"); v6(10, "fe80::"); v6(8, "ff00::"); v6(32, "2001:db8::");
v6(96, "64:ff9b::"); v6(16, "2002::");
// IPv4-mapped IPv6 addresses are checked against the IPv4 rules above by BlockList itself.

/** True for any address that is not an ordinary public one. */
export function restrictedAddress(address: string): boolean {
	const family = isIP(address);
	return family === 0 || BLOCKED.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** Overrides for tests only. Production uses the defaults. */
export interface WebPolicy {
	blocked: (address: string) => boolean;
	ports: number[];
	searchUrl: string;
	timeoutMs: number;
}
const DEFAULT_POLICY: WebPolicy = { blocked: restrictedAddress, ports: [80, 443], searchUrl: SEARCH_URL, timeoutMs: TIMEOUT_MS };

class Refused extends Error {}

type Reply = { status: number; type: string; location?: string; body: string };

/** One GET with every connection address checked as it is made, so a name that changes its answer cannot get past the check. */
function get(url: URL, signal: AbortSignal, policy: WebPolicy): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const secure = url.protocol === "https:";
		const port = Number(url.port || (secure ? 443 : 80));
		if (!secure && url.protocol !== "http:") return reject(new Refused("only http and https pages"));
		if (url.username || url.password) return reject(new Refused("no credentials in the address"));
		if (!policy.ports.includes(port)) return reject(new Refused("not a standard web port"));
		const host = url.hostname.replace(/^\[|\]$/g, "");
		if (isIP(host) && policy.blocked(host)) return reject(new Refused("not a public web address"));
		const req = (secure ? httpsRequest : httpRequest)(url, {
			method: "GET",
			signal,
			agent: false,
			headers: { "user-agent": "Mozilla/5.0 (compatible; Nano)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
			lookup: (name, options, callback) => {
				dnsLookup(name, { ...options, all: true }, (error, addresses) => {
					if (error) return (callback as any)(error);
					if (!addresses.length || addresses.some((item) => policy.blocked(item.address))) return (callback as any)(new Refused("not a public web address"));
					if ((options as { all?: boolean }).all) (callback as any)(null, addresses);
					else (callback as any)(null, addresses[0]!.address, addresses[0]!.family);
				});
			},
		}, (response) => {
			const type = String(response.headers["content-type"] ?? "");
			const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
			const status = response.statusCode ?? 0;
			if (location && status >= 300 && status < 400) {
				response.resume();
				return resolve({ status, type, location, body: "" });
			}
			if (!/^(text\/|application\/(json|xml|xhtml\+xml|[a-z.+-]*\+(json|xml)))/i.test(type) && type) {
				response.destroy();
				return reject(new Refused(`not a text page (${type.split(";")[0]})`));
			}
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				chunks.push(chunk);
				if (size > MAX_BYTES) response.destroy();
			});
			const finish = () => resolve({ status, type, body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8") });
			response.on("end", finish);
			response.on("close", finish);
			response.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

export async function publicFetch(rawUrl: string, signal: AbortSignal, policy: WebPolicy = DEFAULT_POLICY): Promise<string> {
	let url = new URL(rawUrl);
	for (let hop = 0; ; hop++) {
		const reply = await get(url, signal, policy);
		if (reply.location) {
			if (hop >= MAX_REDIRECTS) throw new Refused("too many redirects");
			url = new URL(reply.location, url);
			continue;
		}
		const readable = /html/i.test(reply.type) ? htmlToText(reply.body) : reply.body;
		return `HTTP ${reply.status} ${reply.type.split(";")[0]}\n\n${readable.length > MAX_CHARS ? `${readable.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS} of ${readable.length} characters]` : readable}`;
	}
}

async function search(query: string, key: string, signal: AbortSignal, policy: WebPolicy): Promise<string> {
	const url = new URL(policy.searchUrl);
	url.searchParams.set("q", query.slice(0, 300));
	url.searchParams.set("count", String(RESULTS));
	const response = await fetch(url, { signal, redirect: "error", headers: { accept: "application/json", "x-subscription-token": key } });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string; age?: string }[] } };
	const results = data.web?.results ?? [];
	if (!results.length) return "No results.";
	return results.map((item, i) => `${i + 1}. ${item.title ?? ""}\n${item.url ?? ""}\n${htmlToText(item.description ?? "")}${item.age ? ` (${item.age})` : ""}`).join("\n\n").slice(0, MAX_CHARS);
}

function stringArg(args: Record<string, unknown>, name: string, max: number): string {
	const value = args[name];
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a short string`);
	return value.trim();
}

/** The two tools. `search` is left out without a Brave key. A failed search abandons the draft; a failed page read is reported to the model. */
export function webTools(braveApiKey: string | undefined, policy: Partial<WebPolicy> = {}): ComposeTool[] {
	const rules = { ...DEFAULT_POLICY, ...policy };
	const limit = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(rules.timeoutMs)]);
	const tools: ComposeTool[] = [];
	if (braveApiKey) {
		tools.push({
			name: "web_search",
			description: "Search the public web. Returns titles, URLs and snippets.",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
			run: (args, signal) => search(stringArg(args, "query", 300), braveApiKey, limit(signal), rules),
		});
	}
	tools.push({
		name: "web_fetch",
		description: "Read a public web page by its http or https address and return its text.",
		parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
		async run(args, signal) {
			const bounded = limit(signal);
			try {
				return await publicFetch(stringArg(args, "url", 2000), bounded, rules);
			} catch (error) {
				if (signal.aborted) throw error;
				return `Could not read that page: ${error instanceof Refused ? error.message : bounded.aborted ? "timed out" : "request failed"}.`;
			}
		},
	});
	return tools;
}
