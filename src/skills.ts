import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { skillPaths } from "./packs.ts";

export interface SkillInfo {
	name: string;
	description: string;
	path: string;
}

/** Name and description from a SKILL.md's frontmatter. */
export function parseSkill(text: string): { name?: string; description?: string } {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
	const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "");
	return { name: field("name"), description: field("description") };
}

/** The skills advertised to the model (enabled packs plus data/skills). Later folders do not replace earlier names. */
export function listSkills(config: Config): SkillInfo[] {
	const skills = new Map<string, SkillInfo>();
	for (const dir of skillPaths(config)) {
		let entries: string[] = [];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			const path = join(dir, entry, "SKILL.md");
			if (!existsSync(path)) continue;
			try {
				const { name, description } = parseSkill(readFileSync(path, "utf8"));
				const id = name ?? entry;
				if (description && /^[\w.-]+$/.test(id) && !skills.has(id)) skills.set(id, { name: id, description, path });
			} catch {}
		}
	}
	return [...skills.values()];
}
