import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as g from "./git";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("commits asked for at the same moment in one checkout all land", async () => {
	dir = mkdtempSync(join(tmpdir(), "gs-git-"));
	const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	sh("init", "-q", "-b", "main");
	sh("config", "user.name", "t");
	sh("config", "user.email", "t@t");
	sh("commit", "-q", "--allow-empty", "-m", "init");
	const ids = [1, 2, 3, 4, 5, 6, 7, 8];
	for (const i of ids) {
		mkdirSync(join(dir, `s/${i}`), { recursive: true });
		writeFileSync(join(dir, `s/${i}/session.json`), "x".repeat(200_000));
	}
	// Without taking turns, all but one of these die on index.lock.
	const done = await Promise.all(ids.map((i) => g.commitPaths(dir, [`s/${i}`], `record ${i}`)));
	expect(done).toEqual(ids.map(() => true));
	expect((await g.status(dir)).files).toEqual([]);
	expect((await g.log(dir, 20)).length).toBe(9);
});
