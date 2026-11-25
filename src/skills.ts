import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { skillPaths } from "./packs.ts";

interface SkillInfo {
	name: string;
	description: string;
	path: string;
}

/** Name and description from a SKILL.md's frontmatter. */
function parseSkill(text: string): { name?: string; description?: string } {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
	const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim().replace(/^["']|["']$/g, "");
	return { name: field("name"), description: field("description") };
}

interface SkillSnapshot {
	stamp: string;
	skills: SkillInfo[];
}

const skillSnapshots = new Map<string, SkillSnapshot>();

function skillsKey(config: Config): string {
	return `${config.appDir}\0${config.dataDir}\0${config.packs.join("\0")}`;
}

/** Skill directories and SKILL.md files. A changed mtime (or a path appearing or disappearing) rebuilds the list. */
function watchedSkillPaths(config: Config, skills: SkillInfo[]): string[] {
	return [
		join(config.dataDir, "skills"),
		...config.packs.flatMap((name) => [join(config.dataDir, "packs", name, "skills"), join(config.appDir, "packs", name, "skills")]),
		...skills.flatMap((skill) => [dirname(skill.path), skill.path]),
	];
}

function mtimeStamp(paths: string[]): string {
	let stamp = "";
	for (const path of paths) {
		let mtime = "";
		try {
			mtime = String(statSync(path).mtimeMs);
		} catch {
			// Missing. Creation or removal changes the stamp on the next call.
		}
		stamp += `${path}\0${mtime}\n`;
	}
	return stamp;
}

function scanSkills(config: Config): SkillInfo[] {
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

/** The skills advertised to the model (enabled packs plus data/skills). Later folders do not replace earlier names. */
export function listSkills(config: Config): SkillInfo[] {
	const key = skillsKey(config);
	const cached = skillSnapshots.get(key);
	if (cached && cached.stamp === mtimeStamp(watchedSkillPaths(config, cached.skills))) return cached.skills;
	const skills = scanSkills(config);
	skillSnapshots.set(key, { stamp: mtimeStamp(watchedSkillPaths(config, skills)), skills });
	return skills;
}
