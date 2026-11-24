import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { currentTimezone, loadConfig, localStamp } from "../src/config.ts";

test("timezone follows settings.json mtime and local stamps use that zone", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "nano-tz-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const config = loadConfig({ NANO_CHANNEL: "stdin", NANO_DATA_DIR: dataDir, NANO_PACKS: "" });
	const settings = join(dataDir, "settings.json");
	const at = new Date("2026-01-15T15:00:00Z");

	assert.equal(currentTimezone(config), process.env.TZ || "UTC");

	writeFileSync(settings, JSON.stringify({ timezone: "America/New_York" }));
	// utimes only restores whole milliseconds, so pin the mtime before the cached read.
	const frozen = new Date(Math.floor(Date.now() / 1000) * 1000);
	utimesSync(settings, frozen, frozen);
	assert.equal(currentTimezone(config), "America/New_York");
	const eastern = localStamp(config, at);
	assert.match(eastern, /EST/);
	assert.equal(localStamp(config, at), eastern);

	// Same mtime keeps the cached zone; a newer mtime picks up the edit.
	writeFileSync(settings, JSON.stringify({ timezone: "Europe/London" }));
	utimesSync(settings, frozen, frozen);
	assert.equal(currentTimezone(config), "America/New_York");
	assert.equal(localStamp(config, at), eastern);

	const bumped = new Date(frozen.getTime() + 1000);
	utimesSync(settings, bumped, bumped);
	assert.equal(currentTimezone(config), "Europe/London");
	const london = localStamp(config, at);
	assert.match(london, /GMT/);
	assert.notEqual(london, eastern);

	rmSync(settings);
	assert.equal(currentTimezone(config), process.env.TZ || "UTC");
});
