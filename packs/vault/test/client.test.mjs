import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROVIDER_SOCKET } from "../../../src/provider-client.ts";
import { socketCall, vaultControlled } from "../lib/client.mjs";
import { VAULT_RUN_DIR, VAULT_SOCKET } from "../lib/paths.mjs";

test("the runtime provider socket is the vault socket", () => {
	assert.equal(PROVIDER_SOCKET, VAULT_SOCKET);
});

test("vault control still requires a run directory owned by another user", () => {
	const source = readFileSync(new URL("../lib/client.mjs", import.meta.url), "utf8");
	assert.match(source, /statSync\(VAULT_RUN_DIR\)/);
	assert.match(source, /st\.isDirectory\(\) && st\.uid !== process\.getuid\(\)/);
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

test("the browser and the vault cli share one socket client and keep their own errors", () => {
	const cli = readFileSync(new URL("../lib/cli.mjs", import.meta.url), "utf8");
	const browser = readFileSync(new URL("../../purchases/lib/browser.mjs", import.meta.url), "utf8");
	const client = readFileSync(new URL("../lib/client.mjs", import.meta.url), "utf8");
	assert.match(cli, /socketCall\(VAULT_SOCKET/);
	assert.match(browser, /socketCall\(activeSocket\(\)/);
	assert.match(cli, /vaultControlled\(\)/);
	assert.match(browser, /vaultControlled\(\)/);
	assert.doesNotMatch(cli, /http\.request/);
	assert.doesNotMatch(browser, /http\.request/);
	assert.doesNotMatch(browser, /function vaultControlled/);
	assert.match(client, /export function vaultControlled/);
	assert.match(client, /export function socketCall/);
	assert.match(cli, /timeout: "vault did not answer in time"/);
	assert.match(cli, /error: "vault is not running"/);
	assert.match(cli, /json: "vault returned a response that is not JSON"/);
	assert.match(cli, /timeoutMs: 120_000/);
	assert.match(browser, /timeout: "browser daemon did not answer in time"/);
	assert.match(browser, /timeoutMs = 300_000/);
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
