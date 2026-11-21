import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { notRuntime, parseReleaseConfig } from "../shared/release";
import { createProject } from "./project";
import { buildRelease, releaseManifest } from "./release";
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
		const build = await buildRelease({ root, projectName: "Ship Test", target: "linux", engineRepo });
		expect(build.checks.filter((c) => c.name !== "AppImage")).toEqual([
			{ name: "Runs from its own folder", ok: true, detail: "version 1.2.3, no warnings" },
			{ name: "tests/smoke.jsonl", ok: true, detail: "passed" },
		]);
		const pkg = join(root, build.dir);
		expect(build.dir).toBe("builds/1.2.3/linux/ship-test");
		expect(existsSync(join(pkg, "ship-test"))).toBe(true);
		expect(existsSync(join(pkg, "assets/scenes/main.json"))).toBe(true);
		expect(existsSync(join(pkg, "assets/sounds/beep/beep.ogg"))).toBe(true);
		expect(existsSync(join(pkg, "assets/sounds/beep/takes"))).toBe(false);
		expect(build.archives).toContain("builds/1.2.3/linux/ship-test-1.2.3-linux-x86_64.tar.gz");
		expect(sh(root, "status", "--porcelain")).not.toContain("builds");
	}, 300_000);

	const wine = ["/usr/bin/wine"].find((p) => existsSync(p));
	it.skipIf(!wine || !existsSync(join(engineRepo, "third_party/xwin/.complete")))("packages a Windows build checked under Wine", async () => {
		const root = await game();
		const build = await buildRelease({ root, projectName: "Ship Test", target: "windows", engineRepo, tools: { wine, winePrefix: join(tempDir(), "wine") } });
		expect(build.checks.map((c) => [c.name, c.ok])).toEqual([
			["Runs from its own folder", true],
			["tests/smoke.jsonl", true],
		]);
		expect(build.archives).toEqual(["builds/1.2.3/windows/ship-test-1.2.3-windows-x86_64.zip"]);
		expect(existsSync(join(root, build.dir, "ship-test.exe"))).toBe(true);
	}, 600_000);
});
