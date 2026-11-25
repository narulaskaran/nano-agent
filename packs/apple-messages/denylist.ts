import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ChatDenylist {
	private readonly db: DatabaseSync;

	constructor(dataDir: string) {
		const dir = join(dataDir, "apple-messages");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(dir, "denied-chats.sqlite"));
		this.db.exec(`
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS denied (guid TEXT PRIMARY KEY) WITHOUT ROWID;
		`);
	}

	has(guid: string): boolean {
		return Boolean(this.db.prepare("SELECT 1 FROM denied WHERE guid = ?").get(guid.toLowerCase()));
	}

	list(): string[] {
		return this.db.prepare("SELECT guid FROM denied ORDER BY guid").all().map((row) => String(row.guid));
	}

	set(guid: string, denied: boolean): void {
		const sql = denied ? "INSERT OR IGNORE INTO denied (guid) VALUES (?)" : "DELETE FROM denied WHERE guid = ?";
		this.db.prepare(sql).run(guid.toLowerCase());
	}

	[Symbol.dispose](): void {
		this.db.close();
	}
}
