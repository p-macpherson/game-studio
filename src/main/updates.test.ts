import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../shared/types";
import { sh, makeRepo, tempDir, waitFor } from "./test-helpers";
import { UpdateService } from "./updates";

/** An install like install/install.sh makes: <home>/app cloned from an origin, and <home>/bin/game-studio-update. */
function install(updater: string) {
	const home = tempDir();
	const origin = makeRepo(join(home, "origin"));
	execFileSync("git", ["clone", "-q", origin, join(home, "app")]);
	mkdirSync(join(home, "bin"));
	writeFileSync(join(home, "bin/game-studio-update"), `#!/bin/sh\n${updater}\n`, { mode: 0o755 });
	const commit = (msg: string) => (writeFileSync(join(origin, "f.txt"), msg), sh(origin, "commit", "-qam", msg, "--allow-empty"));
	return { home, origin, commit };
}

describe("UpdateService", () => {
	it("lists the pushed commits an installed copy doesn't have, newest first", async () => {
		const { home, commit } = install("exit 0");
		commit("Add the Release section");
		commit("Fix the icon");
		const status = await new UpdateService(join(home, "app"), () => {}).check();
		expect(status.installed).toBe(true);
		expect(status.available.map((c) => c.subject)).toEqual(["Fix the icon", "Add the Release section"]);
	});

	it("offers no updates to a development checkout", async () => {
		const repo = makeRepo(join(tempDir(), "game-studio"));
		const status = await new UpdateService(repo, () => {}).check();
		expect(status).toMatchObject({ installed: false, available: [] });
	});

	it("prepares with the updater, then restarts into it by handing over this process's id", async () => {
		// The updater stand-in: --prepare leaves a prepared copy; --apply-after records its arguments.
		const { home, commit } = install(
			'if [ "$1" = --prepare ]; then echo ">> Building"; mkdir -p "$(dirname "$0")/../app-next"; echo abcdef123 > "$(dirname "$0")/../app-next/.prepared"; else echo "$@" > "$(dirname "$0")/../args"; fi',
		);
		commit("New feature");
		const events: UpdateStatus[] = [];
		const updates = new UpdateService(join(home, "app"), (e) => e.type === "update_status" && events.push(e.status));
		const ready = await updates.prepare();
		expect(ready).toMatchObject({ phase: "ready", prepared: "abcdef1" });
		expect(events.some((s) => s.phase === "preparing" && s.log.includes(">> Building"))).toBe(true);
		let quit = false;
		updates.restart(() => (quit = true));
		expect(quit).toBe(true);
		await waitFor(() => existsSync(join(home, "args")));
		expect(readFileSync(join(home, "args"), "utf8").trim()).toBe(`--apply-after ${process.pid} --relaunch`);
	});

	it("keeps this version when the update fails, and says why", async () => {
		const { home } = install('echo "!! Tests failed" >&2; exit 1');
		const status = await new UpdateService(join(home, "app"), () => {}).prepare();
		expect(status.phase).toBe("failed");
		expect(status.log).toContain("!! Tests failed");
		expect(() => new UpdateService(join(home, "app"), () => {}).restart(() => {})).toThrow(/No update is ready/);
	});
});
