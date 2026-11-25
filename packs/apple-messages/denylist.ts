import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export class ChatDenylist {
	private readonly db: DatabaseSync;
	private readonly lookup: StatementSync;
	private readonly all: StatementSync;
	private readonly add: StatementSync;
	private readonly remove: StatementSync;

	constructor(dataDir: string) {
		const dir = join(dataDir, "apple-messages");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(dir, "denied-chats.sqlite"));
		this.db.exec(`
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS denied (guid TEXT PRIMARY KEY) WITHOUT ROWID;
		`);
		this.lookup = this.db.prepare("SELECT 1 FROM denied WHERE guid = ?");
		this.all = this.db.prepare("SELECT guid FROM denied ORDER BY guid");
		this.add = this.db.prepare("INSERT OR IGNORE INTO denied (guid) VALUES (?)");
		this.remove = this.db.prepare("DELETE FROM denied WHERE guid = ?");
	}

	has(guid: string): boolean {
		return Boolean(this.lookup.get(guid.toLowerCase()));
	}

	list(): string[] {
		return this.all.all().map((row) => String(row.guid));
	}

	set(guid: string, denied: boolean): void {
		(denied ? this.add : this.remove).run(guid.toLowerCase());
	}

	[Symbol.dispose](): void {
		this.db.close();
	}
}
