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
