// Runs as a LaunchAgent in the signed-in GUI session, the session that runs Messages. Sending needs Automation
// permission for Messages. A process started by sshd has no GUI session to approve that in, so it hangs.
// This agent owns the permission once. The bridge asks it over a private socket and the agent forwards the request to Messages.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const osascript = process.argv[2] ?? "/usr/bin/osascript";
const stateDir = join(homedir(), ".local", "share", "nano-messages");
const socket = join(stateDir, "send.sock");
const script = `on run argv
	with timeout of 20 seconds
		tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
	end timeout
end run`;

function explain(stderr) {
	if (/-1743|not authori[sz]ed to send Apple events/i.test(stderr)) return "Messages Automation is not approved. Click Allow on the guest console";
	if (/-1728|can.t get chat/i.test(stderr)) return "Messages could not find that chat";
	if (/-1712|timed out/i.test(stderr)) return "Messages did not answer in time";
	return "Messages refused the send";
}

function osa(args, timeout) {
	return new Promise((resolve, reject) => {
		execFile(osascript, args, { timeout, killSignal: "SIGKILL" }, (error, _stdout, stderr) => {
			if (error) reject(new Error(explain(String(stderr))));
			else resolve();
		});
	});
}

function sendOne(request) {
	// A ping is an Apple event to Messages that sends nothing. It raises the Automation prompt once, so no real chat is needed to approve it.
	if (request?.op === "ping") return osa(["-e", 'with timeout of 60 seconds\ntell application "Messages" to get name\nend timeout'], 70_000);
	if (typeof request?.chat_guid !== "string" || typeof request.text !== "string") throw new Error("Invalid reply");
	return osa(["-e", script, "--", request.text, request.chat_guid], 30_000);
}

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
if (existsSync(socket)) rmSync(socket);
// One send at a time, in order.
let queue = Promise.resolve();
const server = createServer((connection) => {
	connection.setEncoding("utf8");
	connection.on("error", () => {});
	let input = "";
	connection.on("data", (chunk) => {
		input += chunk;
		if (!input.includes("\n")) return;
		const line = input.slice(0, input.indexOf("\n"));
		input = "";
		queue = queue.then(async () => {
			let answer;
			try {
				await sendOne(JSON.parse(line));
				answer = { status: "sent" };
			} catch (error) {
				answer = { error: error instanceof Error ? error.message : "Send failed" };
			}
			connection.end(JSON.stringify(answer) + "\n");
		});
	});
});
server.listen(socket, () => chmodSync(socket, 0o600));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { rmSync(socket, { force: true }); process.exit(0); });
