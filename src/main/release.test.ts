import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { notRuntime, parseReleaseConfig } from "../shared/release";
import { createProject } from "./project";
import { testFlags, buildRelease, inParallel, longestFirst, releaseManifest, releaseTests } from "./release";
import { buildNote } from "./release-service";
import { sh, tempDir } from "./test-helpers";

function project(files: Record<string, string>): string {
	const root = tempDir();
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(join(root, p, ".."), { recursive: true });
		writeFileSync(join(root, p), text);
	}
	return root;
}

describe("releaseManifest", () => {
	const config = parseReleaseConfig(undefined, "Test").config;

	it("ships what the game reaches, with companions, and leaves out working files, records and unused files", () => {
		const root = project({
			"game/main.odin": 'engine.run({}, {scene = "scenes/main.json"})\nengine.play_sound("sounds/beep/beep.ogg")\nengine.ui_show("title")',
			"assets/ui/title.json": '{"root": {"frame": "ui/art/panel/panel.png"}}',
			"assets/ui/art/panel/panel.png": "png",
			"assets/ui/art/panel/panel.json": '{"slice": [1, 1, 1, 1]}',
			"assets/ui/art/panel/candidates/panel-1.png": "png",
			"assets/scenes/main.json": '{"entities": [{"Model": {"path": "models/crate/crate.glb"}}]}',
			"assets/models/crate/crate.glb": "glb",
			"assets/models/crate/model.json": "{}",
			"assets/models/crate/source/crate-raw.glb": "raw",
			"assets/sounds/beep/beep.ogg": "ogg",
			"assets/sounds/beep/beep-2.ogg": "ogg",
			"assets/sounds/beep/takes/take-1.wav": "wav",
			"assets/sounds/unused/unused.ogg": "ogg",
		});
		const m = releaseManifest(root, config);
		expect(Object.fromEntries(m.files.map((f) => [f.path, f.why]))).toEqual({
			"assets/scenes/main.json": "game code (game/main.odin)",
			"assets/models/crate/crate.glb": "used by assets/scenes/main.json",
			"assets/sounds/beep/beep.ogg": "game code (game/main.odin)",
			"assets/sounds/beep/beep-2.ogg": "goes with assets/sounds/beep/beep.ogg",
			"assets/ui/title.json": "game code (game/main.odin)",
			"assets/ui/art/panel/panel.png": "used by assets/ui/title.json",
			"assets/ui/art/panel/panel.json": "goes with assets/ui/art/panel/panel.png",
		});
		expect(Object.fromEntries(m.leftOut.map((f) => [f.path, f.why]))).toEqual({
			"assets/models/crate/model.json": "studio record",
			"assets/models/crate/source/crate-raw.glb": "working file (source/)",
			"assets/ui/art/panel/candidates/panel-1.png": "working file (candidates/)",
			"assets/sounds/beep/takes/take-1.wav": "working file (takes/)",
			"assets/sounds/unused/unused.ogg": "nothing uses it",
		});
	});

	it("ships assets the game code names without a path, or by a path it builds", () => {
		const root = project({
			"game/main.odin": 'snd("gun-shot", 2)\nfx :: proc(n: string) -> string {return fmt.tprintf("effects/%s.json", n)}\nvoice := fmt.tprintf("voices/guide/line-%d.ogg", i)',
			"assets/sounds/gun-shot/gun-shot.ogg": "ogg",
			"assets/sounds/gun-shot/gun-shot-2.ogg": "ogg",
			"assets/sounds/horn/horn.ogg": "ogg",
			"assets/effects/boom.json": "{}",
			"assets/voices/guide/line-1.ogg": "ogg",
			"assets/voices/guide/outtake.ogg": "ogg",
		});
		const m = releaseManifest(root, config);
		expect(m.files.map((f) => f.path).sort()).toEqual(["assets/effects/boom.json", "assets/sounds/gun-shot/gun-shot-2.ogg", "assets/sounds/gun-shot/gun-shot.ogg", "assets/voices/guide/line-1.ogg"]);
		expect(m.leftOut.map((f) => f.path).sort()).toEqual(["assets/sounds/horn/horn.ogg", "assets/voices/guide/outtake.ogg"]);
	});

	it("ships an image only when the game uses its path, never because a word in the code matches its name", () => {
		const root = project({
			"game/main.odin": 'engine.ui_show("title")\nbg := engine.load_texture("images/backdrops/sky.png")',
			"assets/ui/title.json": "{}",
			"assets/images/title.png": "png",
			"assets/images/backdrops/sky.png": "png",
			"assets/images/concept/knight.png": "png",
		});
		const m = releaseManifest(root, config);
		expect(m.files.map((f) => f.path).sort()).toEqual(["assets/images/backdrops/sky.png", "assets/ui/title.json"]);
		expect(m.leftOut.map((f) => f.path).sort()).toEqual(["assets/images/concept/knight.png", "assets/images/title.png"]);
	});

	it("follows release.json's include and exclude", () => {
		const root = project({
			"game/main.odin": '"sounds/a/a.ogg"',
			"assets/sounds/a/a.ogg": "ogg",
			"assets/sounds/b/b.ogg": "ogg",
		});
		const m = releaseManifest(root, { ...config, include: ["sounds/b/*"], exclude: ["sounds/a/**"] });
		expect(m.files.map((f) => [f.path, f.why])).toEqual([["assets/sounds/b/b.ogg", "release.json include"]]);
		expect(m.leftOut.map((f) => [f.path, f.why])).toEqual([["assets/sounds/a/a.ogg", "release.json exclude"]]);
	});

	it("keeps UI art's slice sidecars and drops particle texture recipes", () => {
		expect(notRuntime("ui/art/panel/panel.json")).toBeNull();
		expect(notRuntime("effects/textures/ember/ember.json")).toBe("studio record");
		expect(notRuntime("effects/sparks.json")).toBeNull();
	});
});

// Builds a real game from the template and packages it, so it needs the engine checkout next to this repo (with its
// Debian sysroot fetched), odin, clang and a display. Windows also needs Wine and the engine's xwin download.
const engineRepo = resolve(process.env.GAME_STUDIO_TEST_ENGINE ?? "../headless-game-engine");
const haveEngine = existsSync(join(engineRepo, "third_party/sysroot/debian11/.complete"));

describe.skipIf(!haveEngine)("buildRelease", () => {
	async function game(): Promise<string> {
		const path = join(tempDir(), "game");
		mkdirSync(path);
		sh(path, "init", "-q", "-b", "main");
		sh(path, "config", "user.email", "test@example.com");
		sh(path, "config", "user.name", "Test");
		await createProject({ path, name: "Ship Test", templateDir: resolve("templates/game"), engineRepo });
		writeFileSync(join(path, "release.json"), JSON.stringify({ name: "Ship Test", version: "1.2.3" }));
		// A file only the code names (a computed path in a real game would need release.json's include).
		const main = join(path, "game/main.odin");
		writeFileSync(main, `${readFileSync(main, "utf8")}\nBEEP :: "sounds/beep/beep.ogg"\n`);
		mkdirSync(join(path, "assets/sounds/beep/takes"), { recursive: true });
		writeFileSync(join(path, "assets/sounds/beep/beep.ogg"), "not really audio");
		writeFileSync(join(path, "assets/sounds/beep/takes/take-1.wav"), "working file");
		return path;
	}

	it("packages a Linux build that passes its checks from its own folder", async () => {
		const root = await game();
		writeFileSync(join(root, "tests/second.jsonl"), '{"cmd": "wait", "frames": 2}\n');
		const build = await buildRelease({ root, projectName: "Ship Test", target: "linux", engineRepo });
		expect(build.checks.filter((c) => c.name !== "AppImage")).toEqual([
			{ name: "Runs from its own folder", ok: true, detail: "version 1.2.3, no warnings" },
			{ name: "tests/second.jsonl", ok: true, detail: "passed", ms: expect.any(Number) },
			{ name: "tests/smoke.jsonl", ok: true, detail: "passed", ms: expect.any(Number) },
		]);
		expect(build.ok).toBe(true);
		expect(build.partial).toBeUndefined();
		const pkg = join(root, build.dir);
		expect(build.dir).toBe("builds/1.2.3/linux/ship-test");
		expect(existsSync(join(pkg, "ship-test"))).toBe(true);
		expect(existsSync(join(pkg, "assets/scenes/main.json"))).toBe(true);
		expect(existsSync(join(pkg, "assets/sounds/beep/beep.ogg"))).toBe(true);
		expect(existsSync(join(pkg, "assets/sounds/beep/takes"))).toBe(false);
		expect(build.archives).toContain("builds/1.2.3/linux/ship-test-1.2.3-linux-x86_64.tar.gz");
		expect(sh(root, "status", "--porcelain")).not.toContain("builds");

		// An agent re-checking one script: a partial check, recorded as one and never ok.
		const quick = await buildRelease({ root, projectName: "Ship Test", target: "linux", engineRepo, tests: ["tests/smoke.jsonl"] });
		expect(quick.checks.filter((c) => c.name.startsWith("tests/")).map((c) => [c.name, c.ok])).toEqual([["tests/smoke.jsonl", true]]);
		expect(quick).toMatchObject({ ok: false, partial: { ran: ["tests/smoke.jsonl"], skipped: 1 } });
		expect(JSON.parse(readFileSync(join(root, "builds/1.2.3/linux/build.json"), "utf8")).partial).toEqual({ ran: ["tests/smoke.jsonl"], skipped: 1 });
		expect(buildNote(quick)).toMatch(/^PARTIAL CHECK: only 1 test script \(tests\/smoke.jsonl\) ran against the package; 1 other was skipped\./);
		// None at all: built, packaged and started, nothing else.
		const none = await buildRelease({ root, projectName: "Ship Test", target: "linux", engineRepo, tests: [], tools: {} });
		expect(none.checks.map((c) => c.name)).toEqual(["Runs from its own folder"]);
		expect(none).toMatchObject({ ok: false, partial: { ran: [], skipped: 2 } });
		// Each script's time is kept through partial checks, so the next full one starts the longest first.
		expect(Object.keys(JSON.parse(readFileSync(join(root, "builds/1.2.3/linux-test-times.json"), "utf8")))).toEqual(["tests/second.jsonl", "tests/smoke.jsonl"]);
		// A script that isn't there is refused before anything is built.
		await expect(buildRelease({ root, projectName: "Ship Test", target: "linux", engineRepo, tests: ["tests/nope.jsonl"] })).rejects.toThrow("No such test script to check the package with: tests/nope.jsonl");
	}, 300_000);

	// No browser outside the studio: the package is made and the check says it couldn't run (the e2e runs it for real).
	it.skipIf(!existsSync(join(engineRepo, "tools/web.sh")) || !existsSync(join(engineRepo, "third_party/lib/web/libraylib.a")))("packages a web build: a page with only the files that ship, zipped with index.html at its root", async () => {
		const root = await game();
		const build = await buildRelease({ root, projectName: "Ship Test", target: "web", engineRepo });
		expect(build.checks).toEqual([{ name: "Runs in a browser", ok: false, detail: "There's no browser to check the web build with here" }]);
		const pkg = join(root, build.dir);
		expect(build.dir).toBe("builds/1.2.3/web/ship-test");
		expect(readdirSync(pkg).sort()).toEqual(["LICENSES.txt", "index.data", "index.html", "index.js", "index.wasm", "odin.js"]);
		expect(readFileSync(join(pkg, "index.html"), "utf8")).toContain("<title>Ship Test</title>");
		// The assets are inside index.data: its file list (in index.js) names what ships and nothing else.
		const loader = readFileSync(join(pkg, "index.js"), "utf8");
		expect(loader).toContain("/assets/sounds/beep/beep.ogg");
		expect(loader).not.toContain("take-1.wav");
		expect(build.archives).toEqual(["builds/1.2.3/web/ship-test-1.2.3-web.zip"]);
		expect(execFileSync("python3", ["-m", "zipfile", "-l", join(root, build.archives[0])], { encoding: "utf8" })).toMatch(/^index\.html\s/m);
	}, 300_000);

	const wine = ["/usr/bin/wine"].find((p) => existsSync(p));
	it.skipIf(!wine || !existsSync(join(engineRepo, "third_party/xwin/.complete")))("packages a Windows build checked under Wine", async () => {
		const root = await game();
		// One Wine prefix (about 700 MB) reused by every run, on disk: a fresh one per run in /tmp (RAM) added up.
		const winePrefix = join(homedir(), ".cache/game-studio/test-wine");
		const build = await buildRelease({ root, projectName: "Ship Test", target: "windows", engineRepo, tools: { wine, winePrefix } });
		expect(build.checks.map((c) => [c.name, c.ok])).toEqual([
			["Runs from its own folder", true],
			["tests/smoke.jsonl", true],
		]);
		expect(build.archives).toEqual(["builds/1.2.3/windows/ship-test-1.2.3-windows-x86_64.zip"]);
		expect(existsSync(join(root, build.dir, "ship-test.exe"))).toBe(true);
	}, 600_000);
});

describe("releaseTests", () => {
	const root = project({ "tests/a.jsonl": "{}", "tests/b.jsonl": "{}", "tests/duel.mp.jsonl": "{}", "tests/review/c.jsonl": "{}" });

	it("is every tests/*.jsonl but multiplayer ones, or only those named", () => {
		expect(releaseTests(root)).toEqual({ run: ["tests/a.jsonl", "tests/b.jsonl"], all: ["tests/a.jsonl", "tests/b.jsonl"], partial: false });
		expect(releaseTests(root, ["b.jsonl", "./tests/review/c.jsonl", "tests/b.jsonl"])).toMatchObject({ run: ["tests/b.jsonl", "tests/review/c.jsonl"], partial: true });
		expect(releaseTests(root, [])).toMatchObject({ run: [], partial: true });
		// Naming every one is the full check.
		expect(releaseTests(root, ["tests/b.jsonl", "tests/a.jsonl"]).partial).toBe(false);
	});

	it("refuses scripts that aren't there, multiplayer ones and paths out of tests/", () => {
		expect(() => releaseTests(root, ["tests/a.jsonl", "tests/zzz.jsonl", "tests/duel.mp.jsonl", "tests/../release.json"])).toThrow(
			"No such test scripts to check the package with: tests/zzz.jsonl, tests/duel.mp.jsonl, tests/../release.json",
		);
	});
});

describe("running checks side by side", () => {
	it("starts the longest first (never-timed ones before them) and keeps at most `parallel` running", async () => {
		const took: Record<string, number> = { a: 5, b: 50, c: 20 };
		expect(longestFirst(["a", "b", "c", "new"], (s) => took[s])).toEqual(["new", "b", "c", "a"]);
		let running = 0;
		let most = 0;
		const out = await inParallel([30, 10, 20, 5, 15], 2, async (ms) => {
			most = Math.max(most, ++running);
			await new Promise((r) => setTimeout(r, ms));
			running--;
			return ms * 2;
		});
		expect(out).toEqual([60, 20, 40, 10, 30]);
		expect(most).toBe(2);
	});

	it("says what a build's result means to the agent that asked", () => {
		const base = { target: "web" as const, version: "1.0.0", dir: "d", archives: [], files: 1, bytes: 1, builtAt: "" };
		const pass = { name: "tests/a.jsonl", ok: true, detail: "passed" };
		const fail = { name: "tests/b.jsonl", ok: false, detail: "line 3" };
		expect(buildNote({ ...base, checks: [pass], ok: true })).toMatch(/^Every check passed \(the full check/);
		expect(buildNote({ ...base, checks: [pass, fail], ok: false })).toMatch(/^1 check failed: tests\/b.jsonl\..*re-check only the failing scripts/);
		expect(buildNote({ ...base, checks: [fail], ok: false, partial: { ran: ["tests/b.jsonl"], skipped: 40 } })).toMatch(
			/^PARTIAL CHECK: only 1 test script \(tests\/b.jsonl\) ran against the package; 40 others were skipped\. .* 1 check failed: tests\/b.jsonl\..* finish with one full check/,
		);
		expect(buildNote({ ...base, checks: [], ok: false, partial: { ran: [], skipped: 2 } })).toMatch(/^PARTIAL CHECK: no test scripts ran .* Everything that ran passed\./);
	});
});

describe("testFlags", () => {
	it("takes a test's game flags from its first line, else a hidden window", () => {
		expect(testFlags('// flags: --mode=none --seed=3\n{"cmd": "wait"}\n')).toEqual(["--mode=none", "--seed=3"]);
		expect(testFlags('// Starts the game.\n{"cmd": "wait"}\n')).toEqual(["--mode=hidden"]);
		expect(testFlags('{"cmd": "wait"}\n// flags: --mode=none\n')).toEqual(["--mode=hidden"]);
	});
});
