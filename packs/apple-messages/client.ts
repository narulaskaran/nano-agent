import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface Cursor {
	generation: string;
	cursor: number;
}

export interface Message {
	id: number;
	chat_guid?: string;
	chat_id: number;
	sender?: string;
	is_from_me: boolean;
	created_at?: string;
	text?: string;
	attachments: ({ mime_type?: string } | null)[];
}

export function connect(request: { op: string; [key: string]: unknown }, signal: AbortSignal): ChildProcessWithoutNullStreams {
	const config = process.env.NANO_APPLE_MESSAGES_SSH_CONFIG;
	if (!config) throw new Error("Set NANO_APPLE_MESSAGES_SSH_CONFIG to the bridge SSH config file");
	const child = spawn("ssh", ["-F", config, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "nano-messages"], { signal });
	child.stdin.on("error", () => {});
	const frame = JSON.stringify(request) + "\n";
	if (request.op === "watch") child.stdin.write(frame);
	else child.stdin.end(frame);
	return child;
}

export function completion(child: ChildProcessWithoutNullStreams): Promise<Error | undefined> {
	const diagnostics: Buffer[] = [];
	let size = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		if (size < 1024) diagnostics.push(chunk.subarray(0, 1024 - size));
		size += chunk.length;
	});
	return new Promise((resolve) => {
		child.once("error", resolve);
		child.once("close", (status) => resolve(status === 0 ? undefined : new Error(Buffer.concat(diagnostics).toString().trim() || `SSH bridge exited (${status})`)));
	});
}

/** Delivers one approved reply through the guest. Never retry a failure with an unknown outcome. */
export async function sendReply(chatGuid: string, text: string, signal: AbortSignal): Promise<void> {
	const child = connect({ op: "send", chat_guid: chatGuid, text }, signal);
	const done = completion(child);
	child.stdout.resume();
	const error = await done;
	if (error) throw error;
}
