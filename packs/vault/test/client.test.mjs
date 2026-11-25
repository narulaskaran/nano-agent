import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROVIDER_SOCKET } from "../../../src/provider-client.ts";
import { createJsonSocketServer, socketCall, vaultControlled } from "../lib/client.mjs";
import { VAULT_RUN_DIR, VAULT_SOCKET } from "../lib/paths.mjs";

test("the runtime provider socket is the vault socket", () => {
	assert.equal(PROVIDER_SOCKET, VAULT_SOCKET);
});

test("vault control still requires a run directory owned by another user", () => {
	// A directory this process creates must not count, and a missing run dir must not either.
	const dir = mkdtempSync(join(tmpdir(), "nano-self-owned-"));
	try {
		assert.equal(statSync(dir).uid, process.getuid());
		if (!existsSync(VAULT_RUN_DIR)) assert.equal(vaultControlled(), false);
		else {
			const st = statSync(VAULT_RUN_DIR);
			assert.equal(vaultControlled(), st.isDirectory() && st.uid !== process.getuid());
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function serve(t, respond) {
	const dir = mkdtempSync(join(tmpdir(), "nano-vault-client-"));
	const socketPath = join(dir, "vault.sock");
	const server = http.createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => respond(body, res));
	});
	return new Promise((resolve, reject) => {
		server.listen(socketPath, () => resolve(socketPath));
		server.on("error", reject);
	}).then((path) => {
		t.after(
			() =>
				new Promise((resolve) => {
					server.close(() => {
						rmSync(dir, { recursive: true, force: true });
						resolve();
					});
				}),
		);
		return path;
	});
}

const browserMessages = { timeout: "browser daemon did not answer in time" };
const vaultMessages = {
	timeout: "vault did not answer in time",
	error: "vault is not running",
	json: "vault returned a response that is not JSON",
};

test("socketCall posts JSON and parses the daemon response", async (t) => {
	let seen = "";
	const socketPath = await serve(t, (body, res) => {
		seen = body;
		res.end(JSON.stringify({ ok: true, text: "listed" }));
	});
	const result = await socketCall(socketPath, { argv: ["list"] }, { timeoutMs: 1000, messages: browserMessages });
	assert.deepEqual(result, { ok: true, text: "listed" });
	assert.equal(seen, JSON.stringify({ argv: ["list"] }));
});

test("socketCall keeps each caller's timeout, connection and JSON errors", async (t) => {
	const badJson = await serve(t, (_body, res) => res.end("nope"));
	await assert.rejects(socketCall(badJson, { argv: ["list"] }, { timeoutMs: 1000, messages: vaultMessages }), { message: "vault returned a response that is not JSON" });
	await assert.rejects(socketCall(badJson, { argv: ["list"] }, { timeoutMs: 1000, messages: browserMessages }), SyntaxError);

	const missing = join(tmpdir(), "nano-vault-missing", "vault.sock");
	await assert.rejects(socketCall(missing, { argv: ["list"] }, { timeoutMs: 1000, messages: vaultMessages }), { message: "vault is not running" });
	await assert.rejects(socketCall(missing, { argv: ["list"] }, { timeoutMs: 1000, messages: browserMessages }), { code: "ENOENT" });

	const hanging = await serve(t, () => {});
	// destroy() emits "error", so a caller that sets messages.error sees that text on timeout too.
	await assert.rejects(socketCall(hanging, { argv: ["ping"] }, { timeoutMs: 200, messages: vaultMessages }), { message: "vault is not running" });
	await assert.rejects(socketCall(hanging, { argv: ["ping"] }, { timeoutMs: 200, messages: browserMessages }), { message: "browser daemon did not answer in time" });
});

test("createJsonSocketServer handles JSON requests, onRequest overrides and size limits", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "nano-vault-server-"));
	const socketPath = join(dir, "server.sock");
	const server = createJsonSocketServer((raw) => ({ ok: true, echo: JSON.parse(raw) }), {
		maxBytes: 64,
		onRequest(req, res) {
			if (req.url !== "/custom") return false;
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("custom-ok");
			return true;
		},
	});
	await new Promise((resolve, reject) => {
		server.listen(socketPath, () => resolve());
		server.on("error", reject);
	});
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(() => {
					rmSync(dir, { recursive: true, force: true });
					resolve();
				});
			}),
	);

	assert.deepEqual(await socketCall(socketPath, { a: 1 }, { timeoutMs: 1000 }), { ok: true, echo: { a: 1 } });
	await assert.rejects(socketCall(socketPath, { big: "x".repeat(100) }, { timeoutMs: 1000 }));
	const custom = await new Promise((resolve, reject) => {
		const req = http.request({ socketPath, path: "/custom", method: "GET" }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve(data));
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(custom, "custom-ok");
});
