import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "../src/config.ts";
import { nanoTools, readCappedText, WEB_FETCH_BYTE_CAP } from "../src/tools.ts";

type FetchResult = { content: { type: string; text?: string }[] };
type FetchParams = { url: string; max_chars?: number };
type WebFetch = (id: string, params: FetchParams, signal?: AbortSignal) => Promise<FetchResult>;

function webFetch(): WebFetch {
	let execute: WebFetch | undefined;
	const register = nanoTools({} as Config, {} as never, {} as never, "space", { modelRuntime: {} as never });
	void register({
		registerTool(tool: { name: string; execute: WebFetch }) {
			if (tool.name === "web_fetch") execute = tool.execute;
		},
	} as unknown as ExtensionAPI);
	if (!execute) throw new Error("web_fetch was not registered");
	return execute;
}

function pageText(result: FetchResult): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (port: number) => Promise<void>): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	try {
		await run((server.address() as AddressInfo).port);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("a small page is returned in the same shape as before", async () => {
	const fetchPage = webFetch();
	const html = "<html><body><h1>Hi</h1><p>A &amp; B</p></body></html>";
	await withServer((req, res) => {
		if (req.url === "/note.json") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
			return;
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
	}, async (port) => {
		const htmlPage = pageText(await fetchPage("1", { url: `http://127.0.0.1:${port}/` }));
		assert.equal(htmlPage, "HTTP 200 text/html; charset=utf-8\n\nHi\nA & B");
		const json = pageText(await fetchPage("2", { url: `http://127.0.0.1:${port}/note.json` }));
		assert.equal(json, 'HTTP 200 application/json\n\n{"ok":true}');
	});
});

test("the 20k character limit and its message are unchanged", async () => {
	const fetchPage = webFetch();
	const body = "y".repeat(25_000);
	await withServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(body);
	}, async (port) => {
		const url = `http://127.0.0.1:${port}/`;
		const page = pageText(await fetchPage("1", { url }));
		assert.equal(page, `HTTP 200 text/plain\n\n${"y".repeat(20_000)}\n[cut at 20000 of 25000 chars]`);
		const shorter = pageText(await fetchPage("2", { url, max_chars: 10 }));
		assert.equal(shorter, `HTTP 200 text/plain\n\n${"y".repeat(10)}\n[cut at 10 of 25000 chars]`);
	});
});

test("a page larger than the byte cap is cut promptly and the rest is not read", { timeout: 10_000 }, async () => {
	const fetchPage = webFetch();
	const total = 16 * 1024 * 1024;
	const chunk = Buffer.alloc(32 * 1024, "a");
	let sent = 0;
	let closed = false;
	let markClosed = () => {};
	const untilClosed = new Promise<void>((resolve) => {
		markClosed = resolve;
	});
	await withServer((req, res) => {
		req.on("error", () => {});
		res.on("error", () => {});
		const noteClosed = () => {
			if (closed) return;
			closed = true;
			markClosed();
		};
		req.on("close", noteClosed);
		res.on("close", noteClosed);
		res.writeHead(200, { "content-type": "text/html", "content-length": String(total) });
		const stallAfter = WEB_FETCH_BYTE_CAP + chunk.length;
		const pump = () => {
			while (sent < stallAfter && !res.destroyed && !res.writableEnded) {
				let ok = false;
				try {
					ok = res.write(chunk);
				} catch {
					return;
				}
				sent += chunk.length;
				if (!ok) {
					res.once("drain", pump);
					return;
				}
			}
		};
		pump();
	}, async (port) => {
		const started = Date.now();
		const page = pageText(await fetchPage("1", { url: `http://127.0.0.1:${port}/huge` }));
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 3_000, `took ${elapsed}ms`);
		const closedInTime = await Promise.race([
			untilClosed.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
		]);
		assert.equal(closedInTime, true, `connection stayed open after the cap; server sent ${sent} bytes`);
		assert.ok(sent <= WEB_FETCH_BYTE_CAP + 64 * 1024, `server sent ${sent} bytes`);
		assert.ok(sent < total);
		assert.ok(page.startsWith("HTTP 200 text/html\n\n"));
		assert.match(page, new RegExp(`\\[cut at 20000 of ${WEB_FETCH_BYTE_CAP} chars\\]`));
		assert.ok(page.endsWith(`[cut at ${WEB_FETCH_BYTE_CAP} bytes]`));
	});
});

test("a multibyte character split across chunks decodes intact", async () => {
	const encoded = new TextEncoder().encode("A€B😀C");
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
			controller.close();
		},
	});
	const read = await readCappedText(stream, 1024);
	assert.equal(read.cut, false);
	assert.equal(read.bytes, encoded.length);
	assert.equal(read.text, "A€B😀C");

	const capped = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoded.subarray(0, 2));
			controller.enqueue(encoded.subarray(2));
			controller.close();
		},
	});
	// € is three bytes starting at offset 1, so a 2-byte cap keeps "A" and the first byte of €.
	const cut = await readCappedText(capped, 2);
	assert.equal(cut.cut, true);
	assert.equal(cut.bytes, 2);
	assert.equal(cut.text.startsWith("A"), true);
	assert.equal(cut.text.includes("B"), false);
	assert.equal(cut.text.includes("😀"), false);
});

test("binary content types are refused instead of returned as text", async () => {
	const fetchPage = webFetch();
	const types: Record<string, string> = {
		"/pic": "image/png",
		"/sound": "audio/mpeg",
		"/clip": "video/mp4",
		"/blob": "application/octet-stream",
		"/doc": "Application/PDF",
		"/photo": "image/jpeg; charset=binary",
	};
	await withServer((req, res) => {
		res.on("error", () => {});
		const type = types[req.url ?? ""] ?? "text/plain";
		res.writeHead(200, { "content-type": type });
		res.end(Buffer.from("not page text"));
	}, async (port) => {
		for (const [path, type] of Object.entries(types)) {
			const mime = type.split(";", 1)[0]?.trim().toLowerCase();
			await assert.rejects(() => fetchPage("1", { url: `http://127.0.0.1:${port}${path}` }), new RegExp(`Refusing binary content \\(${mime}\\)\\.`));
		}
	});
});
