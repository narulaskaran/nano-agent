// Unix-socket client shared by the vault CLI and the browser. Responses are
// produced by the daemon and already redacted; this module never reads a secret.

import { statSync } from "node:fs";
import http from "node:http";
import { VAULT_RUN_DIR } from "./paths.mjs";

// The vault directory is created by root and owned by the vault user. A directory
// the agent made for itself does not count: that would let it impersonate the vault.
export function vaultControlled() {
	try {
		const st = statSync(VAULT_RUN_DIR);
		return st.isDirectory() && st.uid !== process.getuid();
	} catch {
		return false;
	}
}

// POST JSON to a Unix socket and parse the JSON response.
// `messages.timeout` is the error passed to destroy() when the socket is idle.
// destroy() also emits "error", so `messages.error`, when set, is what the caller
// sees for that timeout as well as for a failed connection. `messages.json`, when
// set, replaces a response that is not JSON; otherwise the parse error is kept.
export function socketCall(socketPath, body, { timeoutMs, messages = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: "/", method: "POST", timeout: timeoutMs }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => {
				try {
					resolve(JSON.parse(data));
				} catch (error) {
					reject(messages.json ? new Error(messages.json) : error);
				}
			});
		});
		req.on("timeout", () => req.destroy(new Error(messages.timeout)));
		req.on("error", (error) => reject(messages.error ? new Error(messages.error) : error));
		req.end(JSON.stringify(body));
	});
}

/**
 * Unix-socket HTTP server that reads one bounded UTF-8 JSON request body and writes one JSON reply.
 * Optional `onRequest(req, res)` runs first and returns true when it owns the response.
 */
export function createJsonSocketServer(handler, { maxBytes = 2_000_000, onRequest } = {}) {
	return http.createServer((req, res) => {
		if (onRequest?.(req, res)) return;
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) req.destroy();
			else chunks.push(chunk);
		});
		req.on("end", () => {
			void Promise.resolve(handler(Buffer.concat(chunks).toString("utf8")))
				.then((reply) => {
					if (res.writableEnded) return;
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify(reply));
				})
				.catch(() => {
					if (!res.writableEnded) res.end();
				});
		});
	});
}
