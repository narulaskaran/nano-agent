import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { connect } from "node:net";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

const messagesDir = join(homedir(), "Library", "Messages");
const database = join(messagesDir, "chat.db");
const imsg = process.argv[2];
const maxAttachment = 250 * 1024 * 1024;
const sendSocket = join(homedir(), ".local", "share", "nano-messages", "send.sock");

function integer(value, min, max = Number.MAX_SAFE_INTEGER) {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid number");
	return value;
}

async function readRequest() {
	let input = "";
	for await (const chunk of process.stdin.setEncoding("utf8").iterator({ destroyOnReturn: false })) {
		input += chunk;
		if (input.includes("\n")) return JSON.parse(input);
	}
	throw new Error("Incomplete Messages request");
}

async function* rpc(method, params, watch = false) {
	const child = spawn(imsg, ["rpc"], { stdio: ["pipe", "pipe", "ignore"] });
	const exited = new Promise((resolve) => {
		child.once("error", () => resolve(false));
		child.once("close", (code) => resolve(code === 0));
	});
	child.stdin.on("error", () => {});
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	const stop = () => child.kill();
	process.once("SIGHUP", stop);
	process.once("SIGTERM", stop);
	if (watch) {
		process.stdin.once("end", stop);
		process.stdin.resume();
	}
	try {
		for await (const line of lines) {
			const frame = JSON.parse(line);
			if (frame.error || frame.method === "watch.overflow" || frame.method === "error") throw new Error("Messages RPC failed or overflowed. Check imsg and Full Disk Access on the guest.");
			if (frame.id === 1) {
				yield frame.result;
				if (!watch) return;
			}
			if (frame.method === "message") yield frame.params.message;
		}
		if (!await exited || !watch) throw new Error("Messages RPC exited without a response");
	} finally {
		process.removeListener("SIGHUP", stop);
		process.removeListener("SIGTERM", stop);
		if (watch) {
			process.stdin.removeListener("end", stop);
			process.stdin.pause();
		}
		lines.close();
		stop();
	}
}

async function request(method, params) {
	for await (const result of rpc(method, params)) return result;
}

function send(value) {
	return new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + "\n", (error) => error ? reject(error) : resolve()));
}

function publicMessage(message) {
	const attachments = message.attachments.map(({ original_path, converted_path, filename, ...attachment }) => attachment);
	return { ...message, attachments };
}

async function readMessage(id) {
	integer(id, 1);
	const { messages } = await request("messages.after", { since_rowid: id - 1, limit: 1, attachments: true });
	if (messages[0]?.id !== id) throw new Error("Message not found");
	return messages[0];
}

async function watch(start) {
	const info = await stat(database, { bigint: true });
	const generation = `${info.ino}:${info.birthtimeNs}`;
	if (start && start.generation !== generation) throw new Error("Messages database changed. Check the guest and reset the Nano cursor to resume.");
	const cursor = start ? integer(start.cursor, 0) : currentTail();
	let ready = false;
	for await (const value of rpc("watch.subscribe", { since_rowid: cursor || -1, attachments: true }, true)) {
		if (!ready) {
			await send({ kind: "ready", generation, cursor });
			ready = true;
		} else if (!value.type) {
			await send({ kind: "message", message: publicMessage(value) });
		}
	}
}

function currentTail() {
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		return integer(db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS tail FROM message").get().tail, 0);
	} finally {
		db.close();
	}
}

function chatRow(input) {
	const db = new DatabaseSync(database, { readOnly: true });
	try {
		const columns = "SELECT ROWID AS id, guid, display_name, style FROM chat";
		const row = input.chat_id === undefined
			? db.prepare(`${columns} WHERE guid = ? COLLATE NOCASE`).get(input.chat_guid)
			: db.prepare(`${columns} WHERE ROWID = ?`).get(integer(input.chat_id, 1));
		return row ? { id: Number(row.id), guid: String(row.guid), name: String(row.display_name || ""), group: row.style === 43 } : null;
	} finally {
		db.close();
	}
}

/** The send agent in the GUI session does the sending. Fails fast when it is not running, with a reason Nano can report. */
function sendViaAgent(message) {
	return new Promise((resolve, reject) => {
		const socket = connect(sendSocket);
		let output = "";
		const fail = (reason) => { socket.destroy(); reject(new Error(reason)); };
		const timer = setTimeout(() => fail("The send agent did not answer in time"), 40_000);
		socket.setEncoding("utf8");
		socket.once("error", () => { clearTimeout(timer); fail("The send agent is not running on the guest"); });
		socket.once("connect", () => socket.write(JSON.stringify(message) + "\n"));
		socket.on("data", (chunk) => { output += chunk; });
		socket.once("close", () => {
			clearTimeout(timer);
			try {
				const answer = JSON.parse(output);
				if (answer.status === "sent") resolve();
				else reject(new Error(typeof answer.error === "string" ? answer.error.slice(0, 200) : "Send failed"));
			} catch {
				reject(new Error("The send agent gave no answer"));
			}
		});
	});
}

async function reply({ chat_guid, text }) {
	await sendViaAgent({ chat_guid, text });
	await send({ status: "sent" });
}

async function attachment(id, index) {
	const message = await readMessage(id);
	const item = message.attachments[integer(index, 0)];
	if (!item?.original_path || item.missing) throw new Error("Attachment is not downloaded in Messages");
	const root = await realpath(join(messagesDir, "Attachments"));
	const path = await realpath(item.original_path);
	const fromRoot = relative(root, path);
	if (!fromRoot || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) throw new Error("Attachment is outside the Messages library");
	const info = await stat(path);
	if (!info.isFile() || info.size > maxAttachment) throw new Error("Attachment is not a file or exceeds 250 MiB");
	await send({ name: String(item.transfer_name || "attachment").slice(0, 255), mime_type: String(item.mime_type || "application/octet-stream").slice(0, 255), size: info.size });
	if (info.size) await pipeline(createReadStream(path, { start: 0, end: info.size - 1 }), process.stdout);
}

async function main() {
	if (!imsg || !isAbsolute(imsg)) throw new Error("Configure the absolute imsg path");
	const input = await readRequest();
	switch (input.op) {
		case "watch": return watch(input.start);
		case "chats": return send(await request("chats.list", { limit: integer(input.limit, 1, 100) }));
		case "search": {
			if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 500) throw new Error("Invalid search query");
			const { messages } = await request("messages.search", { query: input.query, limit: integer(input.limit, 1, 100) });
			return send({ messages: messages.map(publicMessage) });
		}
		case "history": {
			const { messages } = await request("messages.history", { chat_id: integer(input.id, 1), limit: integer(input.limit, 1, 100), attachments: true });
			return send({ messages: messages.map(publicMessage) });
		}
		case "read": return send(publicMessage(await readMessage(input.id)));
		case "attachment": return attachment(input.id, input.index);
		case "send": return reply(input);
		case "chat": return send({ chat: chatRow(input) });
		default: throw new Error("Unknown Messages request");
	}
}

main().catch((error) => {
	console.error(error instanceof Error && !error.code ? error.message : "Messages bridge failed. Check the guest and Full Disk Access.");
	process.exitCode = 1;
});
