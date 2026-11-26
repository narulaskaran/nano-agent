import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "./client.ts";

export const MEMORY_INTERVAL = 10 * 60_000;
export const REPLY_MAX_AGE = 60 * 60_000;

export function inboxPath(dataDir: string): string {
	return join(dataDir, "apple-messages", "inbox.sqlite");
}

export function openInbox(dataDir: string): DatabaseSync {
	mkdirSync(join(dataDir, "apple-messages"), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(inboxPath(dataDir));
	db.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = WAL;
		PRAGMA secure_delete = ON;
		CREATE TABLE IF NOT EXISTS stream (
			id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL,
			cursor INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS pending (
			id INTEGER PRIMARY KEY, sender TEXT, chat TEXT, request TEXT NOT NULL,
			notify INTEGER, replied INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS side_settings (id INTEGER PRIMARY KEY CHECK (id = 1));
		CREATE TABLE IF NOT EXISTS side_chats (
			chat TEXT PRIMARY KEY COLLATE NOCASE, enabled INTEGER NOT NULL,
			paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS side_replies (
			id INTEGER PRIMARY KEY, chat TEXT NOT NULL COLLATE NOCASE, body TEXT NOT NULL, owner INTEGER NOT NULL,
			sent_at INTEGER NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
			outgoing TEXT, attempt_at INTEGER, notice TEXT
		);
		CREATE INDEX IF NOT EXISTS side_replies_chat ON side_replies (chat, id);
		CREATE TABLE IF NOT EXISTS side_memory_pending (
			id INTEGER PRIMARY KEY, chat TEXT NOT NULL COLLATE NOCASE, actor TEXT NOT NULL,
			actor_name TEXT, owner INTEGER NOT NULL, sent_at INTEGER NOT NULL, body TEXT NOT NULL, due_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS side_memory_pending_chat ON side_memory_pending (chat, id);
		CREATE TABLE IF NOT EXISTS side_memory (
			key INTEGER PRIMARY KEY, chat TEXT NOT NULL COLLATE NOCASE, source_id INTEGER NOT NULL,
			actor TEXT NOT NULL, owner INTEGER NOT NULL, sent_at INTEGER NOT NULL, fact TEXT,
			UNIQUE (chat, source_id)
		);
		CREATE INDEX IF NOT EXISTS side_memory_chat ON side_memory (chat, sent_at);
		CREATE TABLE IF NOT EXISTS side_people (actor TEXT PRIMARY KEY, name TEXT NOT NULL);
	`);
	return db;
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = run();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function seedChats(db: DatabaseSync, setting = process.env.NANO_APPLE_MESSAGES_CHATS): void {
	transaction(db, () => {
		if (!db.prepare("INSERT OR IGNORE INTO side_settings VALUES (1)").run().changes) return;
		const insert = db.prepare("INSERT OR IGNORE INTO side_chats (chat, enabled) VALUES (?, 1)");
		for (const guid of (setting ?? "").split(",").map((guid) => guid.trim()).filter(Boolean)) insert.run(guid);
	});
}

export type ChatControl = "enable" | "stop" | "pause" | "resume";
export type ChatState = { enabled: number; paused: number; revision: number };

export function chatState(db: DatabaseSync, chat: string): ChatState | undefined {
	return db.prepare("SELECT enabled, paused, revision FROM side_chats WHERE chat = ?").get(chat) as ChatState | undefined;
}

/** Called inside the same transaction as either the stream checkpoint or the private command. */
export function controlChat(db: DatabaseSync, chat: string, action: ChatControl): boolean {
	const current = chatState(db, chat);
	if (action === "pause" || action === "resume") {
		if (!current?.enabled) return false;
		db.prepare("UPDATE side_chats SET paused = ? WHERE chat = ?").run(Number(action === "pause"), chat);
	} else {
		const enabled = Number(action === "enable");
		if (current?.enabled !== enabled) {
			db.prepare(`INSERT INTO side_chats (chat, enabled) VALUES (?, ?)
				ON CONFLICT(chat) DO UPDATE SET enabled = excluded.enabled, paused = 0, revision = revision + 1`).run(chat, enabled);
		}
	}
	if (action === "stop" || action === "pause") {
		db.prepare("DELETE FROM side_replies WHERE chat = ? AND attempt_at IS NULL").run(chat);
	}
	if (action === "stop") db.prepare("DELETE FROM side_memory_pending WHERE chat = ?").run(chat);
	return true;
}

export function queueMemory(db: DatabaseSync, chat: string, message: Message, body: string, now: number, backfill = false): void {
	const due = backfill ? now : now + MEMORY_INTERVAL;
	const actor = message.is_from_me ? "" : (message.sender ?? "").trim().toLowerCase();
	const name = actor ? message.sender_name?.trim().slice(0, 120) : undefined;
	db.prepare(`INSERT OR IGNORE INTO side_memory_pending (id, chat, actor, actor_name, owner, sent_at, body, due_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT MIN(due_at) FROM side_memory_pending WHERE chat = ?), ?)
		WHERE NOT EXISTS (SELECT 1 FROM side_memory WHERE chat = ? AND source_id = ?)`).run(
		message.id, chat, actor, name || null, Number(message.is_from_me),
		Date.parse(message.created_at ?? "") || now, body, chat, due, chat, message.id,
	);
}

export type MemoryNote = { key: number; chat: string; source_id: number; actor: string; owner: number; sent_at: number; fact: string };

export function chatNotes(db: DatabaseSync, chat: string, limit = 25): MemoryNote[] {
	return db.prepare(`SELECT key, chat, source_id, actor, owner, sent_at, fact FROM side_memory
		WHERE chat = ? AND fact IS NOT NULL ORDER BY sent_at DESC, key DESC LIMIT ?`).all(chat, limit) as MemoryNote[];
}

export function privateNotes(db: DatabaseSync, query = ""): (MemoryNote & { name: string | null })[] {
	// Present a live private view over the source notes. Editing or forgetting a source changes this view atomically.
	return db.prepare(`SELECT m.*, p.name FROM side_memory m LEFT JOIN side_people p ON m.actor = p.actor
		WHERE fact IS NOT NULL AND (instr(lower(fact), lower(?)) OR instr(m.actor, lower(?)) OR instr(lower(p.name), lower(?)))
		ORDER BY m.actor, sent_at DESC, key DESC LIMIT 100`).all(query, query, query) as (MemoryNote & { name: string | null })[];
}
