// `vault` client. It never sees a secret: list, the portal URL, and fetch results
// are produced by the daemon and already redacted.

import { existsSync } from "node:fs";
import { socketCall, vaultControlled } from "./client.mjs";
import { VAULT_SOCKET } from "./paths.mjs";

const HELP = `vault: credentials the agent can use and cannot read

  list
  url [--add <site>]                 portal address; --add pre-fills the site field
  fetch <name> [-X METHOD] [-H 'Name: value']... [-d body] <url>
                                     call a URL with a saved API key`;

function call(argv) {
	return socketCall(VAULT_SOCKET, { argv }, {
		timeoutMs: 120_000,
		messages: {
			timeout: "vault did not answer in time",
			error: "vault is not running",
			json: "vault returned a response that is not JSON",
		},
	});
}

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || command === "help" || command === "--help" || command === "-h") {
	console.log(HELP);
	process.exit(0);
}
if (!vaultControlled() && !existsSync(VAULT_SOCKET)) {
	console.error("vault: the vault pack is not running");
	process.exit(1);
}
const result = await call(argv);
if (result.text) (result.ok ? process.stdout : process.stderr).write(`${result.text}\n`);
process.exit(result.ok ? 0 : 1);
