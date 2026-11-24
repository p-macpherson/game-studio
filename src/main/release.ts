// Release builds for players (Release section; see the vault's M13 Shipping Builds): which files ship, the build
// itself (the engine's tools/release.sh), the package folder and its archives, and checks run on the package.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	type LeftOutFile,
	type ReleaseBuild,
	type ReleaseCheck,
	type ReleaseConfig,
	RELEASE_FILE,
	type ReleaseManifest,
	type ShippedFile,
	type ReleaseTarget,
	globMatcher,
	isCompanion,
	notRuntime,
	parseReleaseConfig,
	parseReleases,
	releaseArchiveName,
	releaseSlug,
} from "../shared/release";
import { walk } from "./assets";
import { linkEngineLibs } from "./sessions";

/** release.json's releases, newest first. */
export function readReleases(root: string, projectName: string): { releases: ReleaseConfig[]; problems: string[] } {
	const file = join(root, RELEASE_FILE);
	return parseReleases(existsSync(file) ? readFileSync(file, "utf8") : undefined, projectName);
}

/**
 * One release's settings: the one with `version`, else the newest; with no release.json at all, the defaults (the
 * project's name at 0.1.0), so an agent can build before anyone has made a release.
 */
export function readReleaseConfig(root: string, projectName: string, version?: string): { config: ReleaseConfig; problems: string[] } {
	const { releases, problems } = readReleases(root, projectName);
	const config = version ? releases.find((r) => r.version === version) : releases[0];
	if (config) return { config, problems: problems.filter((p) => p.startsWith(`${config.version}: `) || !/^\d/.test(p)) };
	const fallback = parseReleaseConfig(undefined, projectName).config;
	return { config: fallback, problems: version ? [...problems, `there's no release ${version}`] : problems };
}

/**
 * What a player's copy of the game needs from assets/: files the engine can load (see notRuntime) that the game code
 * reaches, directly or through scenes, prefabs, screens and effects (by the quoted paths in them), with each file's
 * companions (sound variants, texture maps, slice sidecars), the icon and release.json's includes.
 */
export function releaseManifest(root: string, config: ReleaseConfig): ReleaseManifest {
	const all = walk(join(root, "assets"), join(root, "assets"));
	const size = (p: string) => statSync(join(root, "assets", p)).size;
	const excluded = globMatcher(config.exclude);
	const included = globMatcher(config.include);
	const leftOut: LeftOutFile[] = [];
	const runtime = new Set<string>();
	for (const p of all) {
		const why = notRuntime(p) ?? (excluded(p) ? "release.json exclude" : null);
		if (why) leftOut.push({ path: `assets/${p}`, size: size(p), why });
		else runtime.add(p);
	}
	const byStem = new Map<string, string[]>();
	for (const p of runtime) {
		const stem = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : p;
		byStem.set(stem, [...(byStem.get(stem) ?? []), p]);
	}
	// By the name game code may give an asset on its own: `sounds/beep/beep.ogg` and `ui/title.json` are "beep" and "title".
	const byName = new Map<string, string[]>();
	for (const p of runtime) {
		const parts = p.split("/");
		const file = parts[parts.length - 1];
		const name = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
		if (parts.length === 2 || (parts.length === 3 && parts[1] === name)) byName.set(name, [...(byName.get(name) ?? []), p]);
	}
	const reached = new Map<string, string>();
	const queue: string[] = [];
	const reach = (p: string, why: string) => {
		if (reached.has(p)) return;
		reached.set(p, why);
		queue.push(p);
	};
	const scan = (text: string, why: string, code = false) => {
		if (code) {
			// Game code names assets without a path: ui_show("title") is assets/ui/title.json, and a helper given "gun-shot"
			// that builds the path itself plays assets/sounds/gun-shot/gun-shot.ogg.
			for (const [, s] of text.matchAll(/"([\w-]+)"/g)) for (const p of byName.get(s) ?? []) reach(p, why);
			// A path built at run time, fmt.tprintf("sounds/%s/%s-%d.ogg", ...): every file of that shape.
			for (const [, s] of text.matchAll(/"([^"\n]*\/[^"\n]*)"/g)) {
				if (!/%[sdvi]/.test(s)) continue;
				const shape = (s.startsWith("assets/") ? s.slice("assets/".length) : s)
					.split(/(%[sdvi])/)
					.map((part) => (part === "%d" || part === "%i" ? "\\d+" : /^%[sv]$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
					.join("");
				const re = new RegExp(`^${shape}$`);
				for (const p of runtime) if (re.test(p)) reach(p, why);
			}
		}
		for (const [, s] of text.matchAll(/"([^"\n]+\/[^"\n]+)"/g)) {
			const p = s.startsWith("assets/") ? s.slice("assets/".length) : s;
			if (runtime.has(p)) reach(p, why);
			else for (const q of byStem.get(p) ?? []) reach(q, why);
		}
	};
	for (const code of walk(join(root, "game"), root).filter((p) => p.endsWith(".odin"))) scan(readFileSync(join(root, code), "utf8"), `game code (${code})`, true);
	if (config.icon && runtime.has(config.icon)) reach(config.icon, "release icon");
	for (const p of runtime) if (included(p)) reach(p, "release.json include");
	while (queue.length) {
		const p = queue.shift()!;
		for (const q of runtime) if (isCompanion(p, q)) reach(q, `goes with assets/${p}`);
		if (p.endsWith(".json")) scan(readFileSync(join(root, "assets", p), "utf8"), `used by assets/${p}`);
	}
	const files: ShippedFile[] = [];
	for (const p of [...runtime].sort()) {
		const why = reached.get(p);
		if (why) files.push({ path: `assets/${p}`, size: size(p), why });
		else leftOut.push({ path: `assets/${p}`, size: size(p), why: "nothing uses it" });
	}
	leftOut.sort((a, b) => a.path.localeCompare(b.path));
	return { files, leftOut, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** `dir` served over HTTP and opened with `args` as the query string (the game's flags); `files` are added to the page's file system. */
export type BrowserRun = (opts: { dir: string; args: string[]; files: Record<string, Buffer>; timeoutMs: number }) => Promise<{ code: number; output: string }>;
/** Starts the packaged game with flags; `tests`: with the project's tests/ beside it, from its folder (else from an unrelated folder). */
type Play = (args: string[], tests: boolean) => Promise<{ code: number; output: string }>;

export interface ReleaseTools {
	/** appimagetool; without it no AppImage is made. */
	appimagetool?: string;
	/** Wine runs the Windows build's checks; without it they're skipped (and the build isn't ok). */
	wine?: string;
	winePrefix?: string;
	/**
	 * Runs a web build in a browser (the studio: a hidden window, see web-runner.ts) and reports the game's exit code and
	 * console output; without it the web build's checks are skipped (and the build isn't ok).
	 */
	browser?: BrowserRun;
	/** Turns the icon PNG into an .ico for the .exe (Electron's nativeImage resizes); default: the PNG as it is. */
	ico?: (png: Buffer) => Buffer;
}

/** Builds, packages and checks a release of the project at `root` for `target`. */
export async function buildRelease(opts: {
	root: string;
	projectName: string;
	/** The studio's engine checkout: its fetched sysroot and Windows SDK are linked into the game's engine. */
	engineRepo?: string;
	target: ReleaseTarget;
	/** Which release (default: the newest). */
	version?: string;
	tools?: ReleaseTools;
	onProgress?: (step: string) => void;
}): Promise<ReleaseBuild> {
	const { root, target } = opts;
	const { config, problems } = readReleaseConfig(root, opts.projectName, opts.version);
	if (problems.length) throw new Error(`release.json: ${problems.join("; ")}`);
	const started = Date.now();
	const log: string[] = [];
	const onProgress = (step: string) => {
		log.push(step);
		opts.onProgress?.(step);
	};
	const out = join(root, "builds", config.version, target);
	const record = (b: ReleaseBuild) => {
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "build.json"), `${JSON.stringify(b, null, "\t")}\n`);
		return b;
	};
	try {
		const built = await makeRelease({ ...opts, onProgress }, config);
		return record({ ...built, log, seconds: Math.round((Date.now() - started) / 1000) });
	} catch (err) {
		// The build itself failed: nothing to run, but the section shows what happened (and a session looks into it).
		record({ target, version: config.version, dir: "", archives: [], checks: [], ok: false, error: (err as Error).message, log, seconds: Math.round((Date.now() - started) / 1000), files: 0, bytes: 0, builtAt: new Date().toISOString() });
		throw err;
	}
}

/**
 * A web build to play now (remote access's Play): the newest release's name and files (or the defaults with no
 * release.json), compiled into `out` as a page folder. Not a release: no version folder in the game, no archive, no
 * checks, and the game's debug code stays in (no RELEASE define).
 */
export async function buildPlayable(opts: { root: string; projectName: string; engineRepo?: string; out: string; onProgress?: (step: string) => void }): Promise<void> {
	const { root, out } = opts;
	const progress = opts.onProgress ?? (() => {});
	const { config } = readReleaseConfig(root, opts.projectName);
	if (opts.engineRepo) await linkEngineLibs(join(root, "engine"), opts.engineRepo);
	const script = join(root, "engine/tools/web.sh");
	if (!existsSync(script)) throw new Error("the game's engine can't build for the web yet (no tools/web.sh): update the engine first");
	const work = mkdtempSync(join(tmpdir(), "gs-play-"));
	try {
		progress("Choosing files");
		const manifest = releaseManifest(root, config);
		mkdirSync(join(work, "assets"));
		for (const f of manifest.files) cpSync(join(root, f.path), join(work, f.path));
		progress("Compiling for the web");
		// Built beside the old one, then swapped in: a page being played isn't pulled out from under it until it's ready.
		const next = `${out}.next`;
		rmSync(next, { recursive: true, force: true });
		mkdirSync(next, { recursive: true });
		const built = await run(script, ["game", next, join(work, "assets")], { cwd: root, env: { WEB_TITLE: config.name } });
		if (built.code !== 0) throw new Error(`the web build failed:\n${built.output.slice(-3000)}`);
		rmSync(out, { recursive: true, force: true });
		renameSync(next, out);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function makeRelease(opts: Parameters<typeof buildRelease>[0], config: ReleaseConfig): Promise<ReleaseBuild> {
	const { root, target, tools = {} } = opts;
	const progress = opts.onProgress ?? (() => {});
	if (opts.engineRepo) await linkEngineLibs(join(root, "engine"), opts.engineRepo);
	const script = join(root, target === "web" ? "engine/tools/web.sh" : "engine/tools/release.sh");
	if (!existsSync(script)) throw new Error(target === "web" ? "the game's engine can't build for the web yet (no tools/web.sh): update the engine first" : "the game's engine has no tools/release.sh: update the engine first");
	const slug = releaseSlug(config.name);
	const out = join(root, "builds", config.version, target);
	const pkg = join(out, slug);
	ignoreBuilds(root);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(pkg, { recursive: true });
	const work = mkdtempSync(join(tmpdir(), "gs-release-"));
	try {
		progress("Choosing files");
		const manifest = releaseManifest(root, config);

		progress(`Compiling for ${target}`);
		const defines = [`-define:GAME_VERSION=${config.version}`, ...(config.icon ? [`-define:GAME_ICON=${config.icon}`] : [])];
		const env: Record<string, string> = {};
		if (target === "windows" && config.icon && existsSync(join(root, "assets", config.icon))) {
			const png = readFileSync(join(root, "assets", config.icon));
			env.WIN_ICON = join(work, "icon.ico");
			writeFileSync(env.WIN_ICON, tools.ico ? tools.ico(png) : icoFromPng(png));
		}
		const binary = join(work, "game");
		const exe = target === "windows" ? `${slug}.exe` : target === "web" ? "index.html" : slug;
		if (target === "web") {
			// The page's assets are packed into index.data, so only the files that ship are handed to the build.
			const assets = join(work, "assets");
			mkdirSync(assets);
			for (const f of manifest.files) cpSync(join(root, f.path), join(work, f.path));
			env.WEB_TITLE = config.name;
			if (config.icon && existsSync(join(root, "assets", config.icon))) env.WEB_ICON = join(root, "assets", config.icon);
			const built = await run(script, ["game", pkg, assets, "-define:RELEASE=true", ...defines], { cwd: root, env });
			if (built.code !== 0) throw new Error(`the web build failed:\n${built.output.slice(-3000)}`);
		} else {
			const built = await run(script, ["game", binary, target, ...defines], { cwd: root, env });
			if (built.code !== 0) throw new Error(`the ${target} build failed:\n${built.output.slice(-3000)}`);
			cpSync(target === "windows" ? `${binary}.exe` : binary, join(pkg, exe));
		}

		progress("Packaging");
		if (target !== "web") {
			for (const f of manifest.files) cpSync(join(root, f.path), join(pkg, f.path));
			writeFileSync(join(pkg, "README.txt"), readme(config, target, exe));
		}
		writeFileSync(join(pkg, "LICENSES.txt"), licences(manifest, target));
		const archives: string[] = [];
		if (target === "web") {
			// index.html at the zip's root: what itch.io (and most hosts) expect of a browser game.
			const zip = join(out, releaseArchiveName(config, target, "zip"));
			await mustRun("python3", ["-m", "zipfile", "-c", zip, ...readdirSync(pkg).sort()], { cwd: pkg });
			archives.push(zip);
		} else if (target === "linux") {
			const tgz = join(out, releaseArchiveName(config, target, "tar.gz"));
			await mustRun("tar", ["-czf", tgz, "-C", out, slug]);
			archives.push(tgz);
		} else {
			const zip = join(out, releaseArchiveName(config, target, "zip"));
			await mustRun("python3", ["-m", "zipfile", "-c", zip, slug], { cwd: out });
			archives.push(zip);
		}

		progress("Checking the package");
		const checks: ReleaseCheck[] = [];
		const runner = target === "windows" ? tools.wine : undefined;
		if (target === "windows" && !runner) checks.push({ name: "Runs from its own folder", ok: false, detail: "Wine isn't installed, so the Windows build can't be checked here" });
		else if (target === "web" && !tools.browser) checks.push({ name: "Runs in a browser", ok: false, detail: "There's no browser to check the web build with here" });
		else {
			const play = target === "web" ? webPlay(root, pkg, tools.browser!) : nativePlay(root, pkg, exe, work, runner, tools.winePrefix);
			checks.push(await checkStarts(play, config, target === "web" ? "Runs in a browser" : "Runs from its own folder"));
			checks.push(...(await checkTests(root, play)));
		}
		if (target === "linux") {
			// Without appimagetool (turned off, as in tests) there's simply no AppImage.
			if (tools.appimagetool) {
				progress("Making the AppImage");
				const image = join(out, releaseArchiveName(config, target, "AppImage"));
				const made = await appImage(root, config, pkg, exe, image, work, tools.appimagetool);
				checks.push(made);
				if (made.ok) archives.push(image);
			}
		}
		const result: ReleaseBuild = {
			target,
			version: config.version,
			dir: rel(root, pkg),
			archives: archives.map((a) => rel(root, a)),
			checks,
			ok: checks.every((c) => c.ok),
			files: manifest.files.length,
			bytes: manifest.bytes,
			builtAt: new Date().toISOString(),
		};
		return result;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const rel = (root: string, p: string) => p.slice(root.length + 1);

/** builds/ never goes into git; projects made before the template ignored it get it in .git/info/exclude. */
function ignoreBuilds(root: string): void {
	const gi = join(root, ".gitignore");
	if (existsSync(gi) && /^\/?builds\/?$/m.test(readFileSync(gi, "utf8"))) return;
	if (!existsSync(join(root, ".git"))) return;
	// A worktree's .git is a file: ask git where the (shared) exclude file is.
	const exclude = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8" }).trim();
	const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
	if (!/^\/builds\/$/m.test(text)) {
		mkdirSync(dirname(exclude), { recursive: true });
		appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}/builds/\n`);
	}
}

const START_SCRIPT = '{"cmd": "wait", "frames": 60}\n{"cmd": "info"}\n{"cmd": "logs"}\n';

/** The package copied elsewhere and started from an unrelated folder; for tests, a copy with tests/ beside it, from inside. */
function nativePlay(root: string, pkg: string, exe: string, work: string, wine?: string, prefix?: string): Play {
	let startCopy: string | undefined;
	let testCopy: string | undefined;
	return (args, tests) => {
		if (tests) {
			if (!testCopy) {
				testCopy = join(work, "tests", "game");
				cpSync(pkg, testCopy, { recursive: true });
				cpSync(join(root, "tests"), join(testCopy, "tests"), { recursive: true });
				mkdirSync(join(testCopy, "build"), { recursive: true });
			}
			return runGame(join(testCopy, exe), ["--dev", ...args], testCopy, wine, prefix);
		}
		if (!startCopy) {
			startCopy = join(work, "start", "game");
			cpSync(pkg, startCopy, { recursive: true });
			writeFileSync(join(work, "start", "check.jsonl"), START_SCRIPT);
		}
		return runGame(join(startCopy, exe), ["--dev", ...args.map((a) => (a === "--script=check.jsonl" ? `--script=${join(work, "start", "check.jsonl")}` : a))], tmpdir(), wine, prefix);
	};
}

/** The package as it ships, opened in a browser; scripts (and for tests, the project's tests/) are added to the page's file system. */
function webPlay(root: string, pkg: string, browser: BrowserRun): Play {
	return (args, tests) => {
		const files: Record<string, Buffer> = { "/check.jsonl": Buffer.from(START_SCRIPT) };
		if (tests) for (const f of walk(join(root, "tests"), join(root, "tests"))) files[`/tests/${f}`] = readFileSync(join(root, "tests", f));
		// The page's flags are its query string: --fixed-dt is "fixed-dt", --script=x is "script=x".
		return browser({ dir: pkg, args: ["dev", ...args.map((a) => a.replace(/^--/, ""))], files, timeoutMs: 300_000 });
	};
}

/** The package starts away from the project: no missing files, a release build, the release's version, no warnings. */
async function checkStarts(play: Play, config: ReleaseConfig, name: string): Promise<ReleaseCheck> {
	// Hidden: it renders, but with its sound off and no real keyboard, mouse or gamepad read (a web build too).
	const res = await play(["--mode=hidden", "--fixed-dt", "--script=check.jsonl"], false);
	if (res.code !== 0) return { name, ok: false, detail: `exited with ${res.code}: ${res.output.slice(-800)}` };
	const replies = res.output
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => {
			try {
				return JSON.parse(l) as { ok?: boolean; result?: unknown };
			} catch {
				return {};
			}
		});
	const info = replies.find((r) => (r.result as { release?: boolean } | undefined)?.release !== undefined)?.result as { release: boolean; game_version: string } | undefined;
	if (!info?.release) return { name, ok: false, detail: "it isn't a release build" };
	if (info.game_version !== config.version) return { name, ok: false, detail: `it reports version ${info.game_version}, not ${config.version}` };
	const logs = (replies.find((r) => Array.isArray(r.result))?.result as { level: string; text: string }[] | undefined) ?? [];
	const problems = logs.filter((e) => /warn|error|fatal/.test(e.level)).map((e) => e.text);
	if (problems.length) return { name, ok: false, detail: problems.slice(0, 8).join("\n") };
	return { name, ok: true, detail: `version ${info.game_version}, no warnings` };
}

/**
 * The game flags a test script runs with: its first line when that is `// flags: --mode=none --seed=3` (a test that needs
 * no picture runs without one, many times faster, and in a browser not at the display's pace), else a hidden window.
 */
export function testFlags(script: string): string[] {
	const first = /^\/\/\s*flags:(.*)$/.exec(script.split("\n", 1)[0].trim());
	const flags = first ? first[1].trim().split(/\s+/).filter((f) => f.startsWith("--")) : [];
	return flags.length ? flags : ["--mode=hidden"];
}

/** Each of the game's tests/*.jsonl, run against the packaged release build. */
async function checkTests(root: string, play: Play): Promise<ReleaseCheck[]> {
	// Multiplayer scripts (*.mp.jsonl) need several copies of the game talking to each other: not run against packages yet.
	const tests = existsSync(join(root, "tests")) ? readdirSync(join(root, "tests")).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".mp.jsonl")).sort() : [];
	const checks: ReleaseCheck[] = [];
	for (const t of tests) {
		const res = await play([...testFlags(readFileSync(join(root, "tests", t), "utf8")), "--fixed-dt", `--script=tests/${t}`], true);
		const failed = res.output.split("\n").filter((l) => l.includes('"ok":false'));
		checks.push({ name: `tests/${t}`, ok: res.code === 0, detail: res.code === 0 ? "passed" : failed.slice(0, 5).join("\n") || res.output.slice(-800) });
	}
	return checks;
}

async function appImage(root: string, config: ReleaseConfig, pkg: string, exe: string, image: string, work: string, tool: string): Promise<ReleaseCheck> {
	const name = "AppImage";
	const dir = join(work, "AppDir");
	cpSync(pkg, join(dir, "usr/bin"), { recursive: true });
	writeFileSync(join(dir, "AppRun"), `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/${exe}" "$@"\n`, { mode: 0o755 });
	writeFileSync(join(dir, `${exe}.desktop`), `[Desktop Entry]\nType=Application\nName=${config.name}\nExec=${exe}\nIcon=${exe}\nCategories=Game;\n`);
	const icon = config.icon && existsSync(join(root, "assets", config.icon)) ? join(root, "assets", config.icon) : undefined;
	if (icon) cpSync(icon, join(dir, `${exe}.png`));
	else writeFileSync(join(dir, `${exe}.png`), BLANK_PNG);
	const made = await run(tool, ["--appimage-extract-and-run", dir, image], { env: { ARCH: "x86_64" } });
	if (made.code !== 0) return { name, ok: false, detail: made.output.slice(-800) };
	const res = await runGame(image, ["--dev", "--mode=hidden", "--frames=30"], tmpdir());
	return res.code === 0 ? { name, ok: true, detail: "made, and it starts" } : { name, ok: false, detail: `made, but it didn't start: ${res.output.slice(-600)}` };
}

function readme(config: ReleaseConfig, target: ReleaseTarget, exe: string): string {
	const log = target === "windows" ? `%LOCALAPPDATA%\\${config.name}\\log.txt` : `~/.local/share/${config.name}/log.txt`;
	return [
		`${config.name} ${config.version}`,
		"",
		target === "windows" ? `To play, run ${exe}.` : `To play, run ./${exe}. It needs a 64-bit Linux with glibc 2.29 or later and OpenGL 3.3.`,
		"Keep the assets folder next to it.",
		"",
		`If something goes wrong, the game's log is ${log}.`,
		"",
		"Made with Game Studio and headless-game-engine. Third-party notices are in LICENSES.txt.",
		"",
	].join(target === "windows" ? "\r\n" : "\n");
}

function licences(manifest: ReleaseManifest, target: ReleaseTarget): string {
	const music = manifest.files.some((f) => f.path.startsWith("assets/music/"));
	return [
		"This game includes the following third-party software:",
		"",
		"- raylib (https://www.raylib.com), zlib licence, Copyright (c) 2013-2026 Ramon Santamaria (@raysan5); with GLFW",
		"  (zlib licence), miniaudio, stb and cgltf (public domain or MIT).",
		...(target === "web" ? ["- Emscripten's runtime and C library (https://emscripten.org), MIT licence; musl libc, MIT licence."] : ["- ENet (http://enet.bespin.org), MIT licence, Copyright (c) 2002-2024 Lee Salzman."]),
		"- box3d, MIT licence, Copyright (c) 2025 Erin Catto.",
		"- The Odin core library (https://odin-lang.org), BSD 3-Clause licence, Copyright (c) 2016-2026 Ginger Bill.",
		...(music ? ["", "Music rendered with the GeneralUser GS SoundFont by S. Christian Collins (http://www.schristiancollins.com)."] : []),
		"",
	].join("\n");
}

/** An .ico holding the PNG as it is (Windows Vista and later read PNG icons; up to 256 pixels look right). */
export function icoFromPng(png: Buffer): Buffer {
	const w = png.readUInt32BE(16);
	const h = png.readUInt32BE(20);
	const head = Buffer.alloc(22);
	head.writeUInt16LE(0, 0);
	head.writeUInt16LE(1, 2);
	head.writeUInt16LE(1, 4);
	head.writeUInt8(w >= 256 ? 0 : w, 6);
	head.writeUInt8(h >= 256 ? 0 : h, 7);
	head.writeUInt16LE(1, 10);
	head.writeUInt16LE(32, 12);
	head.writeUInt32LE(png.length, 14);
	head.writeUInt32LE(22, 18);
	return Buffer.concat([head, png]);
}

/** A 1×1 transparent PNG, for an AppImage without an icon (appimagetool requires one). */
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function runGame(binary: string, args: string[], cwd: string, wine?: string, prefix?: string) {
	if (!wine) return run(binary, args, { cwd, timeoutMs: 180_000 });
	// Wine makes a missing prefix itself, but not the folder it goes in.
	if (prefix) mkdirSync(dirname(prefix), { recursive: true });
	return run(wine, [binary, ...args], { cwd, timeoutMs: 300_000, env: { WINEDEBUG: "-all", ...(prefix ? { WINEPREFIX: prefix } : {}) } });
}

async function mustRun(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
	const r = await run(cmd, args, opts);
	if (r.code !== 0) throw new Error(`${cmd} failed: ${r.output.slice(-1500)}`);
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const add = (d: Buffer) => {
			output += d.toString();
			if (output.length > 2_000_000) output = output.slice(-1_000_000);
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
		child.on("error", (e) => resolve({ code: -1, output: String(e) }));
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ code: code ?? -1, output });
		});
	});
}
