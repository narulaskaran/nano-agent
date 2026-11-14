import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Read a JSON state file. Missing means `fallback`. Unreadable means the file is set aside as
 * `<path>.corrupt-<time>` (so nothing is lost silently) and `fallback` is returned.
 */
export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		const aside = `${path}.corrupt-${Date.now()}`;
		console.error(`nano: could not read ${path} (${(error as Error)?.message ?? error}); kept a copy at ${aside}, starting empty`);
		try {
			renameSync(path, aside);
		} catch {}
		return fallback;
	}
}

/** Write through a temp file and rename, so a crash never leaves half a file. */
export function writeJsonFile(path: string, data: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, path);
}
