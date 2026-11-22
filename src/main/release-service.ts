// The Release section's service: release.json and what ships, builds (one at a time, with progress), running a built
// package, and publishing to itch.io with butler. The tools it needs beyond the engine's (appimagetool, butler) are
// downloaded into the studio's data folder the first time; Wine is the system's.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioEvent } from "../shared/ipc";
import {
	DEFAULT_ITCH_CHANNEL,
	formatReleases,
	nextRelease,
	type ReleaseBuild,
	type ReleaseBuilding,
	type ReleaseConfig,
	RELEASE_FILE,
	type ReleaseInfo,
	type ReleaseManifest,
	RELEASE_TARGET_LABEL,
	RELEASE_TARGETS,
	type ReleaseTarget,
} from "../shared/release";
import { type BrowserRun, buildRelease, readReleaseConfig, readReleases, releaseManifest } from "./release";
import { handler, type StudioRequestHandlers } from "./studio-requests";

const APPIMAGETOOL_URL = "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage";
const BUTLER_URL = "https://broth.itch.zone/butler/linux-amd64/LATEST/archive/default";

export interface ReleaseServiceOptions {
	/** A checkout's folder: main (null) or a worktree. */
	checkoutRoot(checkout: string | null): string;
	projectName(): string;
	engineRepo(): string;
	/** The studio's data folder: tools/, itch/butler_creds and the Wine prefix live here. */
	dataDir: string;
	emit(e: StudioEvent): void;
	/** Overrides (tests): a butler stand-in, appimagetool's path or "off". */
	butler?: string;
	appimagetool?: string;
	/** Web builds: the checks' browser, and how a built one is shown (served from this machine, opened in the default browser). */
	browser?: BrowserRun;
	openWeb?(dir: string): Promise<void>;
	/**
	 * Starts a session to look into a build, in the build's worktree (from main: in a new one), and returns its id.
	 * Without it nothing is investigated.
	 */
	investigate?(checkout: string | null, title: string, prompt: string): Promise<string>;
}

export class ReleaseService {
	private building: ReleaseBuilding | null = null;

	constructor(private readonly o: ReleaseServiceOptions) {}

	info(checkout: string | null): ReleaseInfo {
		const root = this.o.checkoutRoot(checkout);
		const { releases, problems } = readReleases(root, this.o.projectName());
		return {
			releases,
			problems,
			suggested: nextRelease(releases, this.o.projectName()),
			builds: listBuilds(root),
			building: this.building,
			tools: { wine: !!which("wine"), appimagetool: this.o.appimagetool !== "off", web: existsSync(join(root, "engine/tools/web.sh")) },
			itchKey: existsSync(this.credsFile),
		};
	}

	/** Which files a release ships, and which it leaves out and why. */
	manifest(checkout: string | null, version: string): ReleaseManifest {
		const root = this.o.checkoutRoot(checkout);
		return releaseManifest(root, readReleaseConfig(root, this.o.projectName(), version).config);
	}

	/**
	 * Builds, packages and checks one target of a release, reporting each step as a release_progress event. One at a
	 * time. A build that fails outright (no package) gets a session to look into it.
	 */
	async build(checkout: string | null, version: string, target: ReleaseTarget): Promise<ReleaseBuild> {
		if (this.building) throw new Error(`A release is already being built (${this.building.version} for ${RELEASE_TARGET_LABEL[this.building.target]})`);
		const building: ReleaseBuilding = { checkout: checkout ?? "main", version, target, startedAt: new Date().toISOString(), log: [] };
		this.building = building;
		this.o.emit({ type: "release_changed" });
		const progress = (text: string) => {
			building.log.push(text);
			this.o.emit({ type: "release_progress", checkout: building.checkout, version, target, text });
		};
		const root = this.o.checkoutRoot(checkout);
		try {
			const result = await this.buildAt(root, target, progress, version);
			progress(result.ok ? "Done: every check passed" : "Done, with failed checks");
			// A session was already asked why it was slow: the finished build points at it too.
			if (building.investigation) attachInvestigation(root, version, target, building.investigation);
			return result;
		} catch (err) {
			const failed = listBuilds(root).find((b) => b.version === version && b.target === target);
			if (failed?.error && building.investigation) attachInvestigation(root, version, target, building.investigation);
			else if (failed?.error && this.o.investigate) {
				try {
					const name = readReleaseConfig(root, this.o.projectName(), version).config.name;
					const id = await this.o.investigate(checkout, `${RELEASE_TARGET_LABEL[target]} build of ${version} failed`, investigationBrief(name, failed, null));
					attachInvestigation(root, version, target, id);
				} catch (e) {
					progress(`Couldn't start a session to look into it: ${(e as Error).message}`);
				}
			}
			throw err;
		} finally {
			this.building = null;
			this.o.emit({ type: "release_changed" });
		}
	}

	/**
	 * Has a session look into a build: the one running now (it's taking long), or the last one of this release and
	 * target (it failed, or its checks did). Returns the session's id; asking again returns the same session.
	 */
	async investigate(checkout: string | null, version: string, target: ReleaseTarget): Promise<string> {
		if (!this.o.investigate) throw new Error("Sessions can't be started from here");
		const root = this.o.checkoutRoot(checkout);
		const name = readReleaseConfig(root, this.o.projectName(), version).config.name;
		const running = this.building && this.building.checkout === (checkout ?? "main") && this.building.version === version && this.building.target === target ? this.building : null;
		if (running) {
			if (running.investigation) return running.investigation;
			const id = await this.o.investigate(checkout, `${RELEASE_TARGET_LABEL[target]} build of ${version} is slow`, investigationBrief(name, null, running));
			running.investigation = id;
			this.o.emit({ type: "release_changed" });
			return id;
		}
		const build = listBuilds(root).find((b) => b.version === version && b.target === target);
		if (!build) throw new Error(`There's no ${target} build of ${version} to look into`);
		if (build.ok) throw new Error("That build has nothing wrong with it");
		if (build.investigation) return build.investigation;
		const id = await this.o.investigate(checkout, `${RELEASE_TARGET_LABEL[target]} build of ${version}: ${build.error ? "failed" : "failed checks"}`, investigationBrief(name, build, null));
		attachInvestigation(root, version, target, id);
		this.o.emit({ type: "release_changed" });
		return id;
	}

	/** Removes a release's builds (builds/<version>/): its release.json entry goes with the section's delete_release. */
	deleteBuilds(checkout: string | null, version: string): void {
		if (!/^[\w.+-]+$/.test(version)) throw new Error(`"${version}" isn't a version`);
		if (this.building && this.building.checkout === (checkout ?? "main") && this.building.version === version) throw new Error("That release is being built: wait for it to finish");
		rmSync(join(this.o.checkoutRoot(checkout), "builds", version), { recursive: true, force: true });
		this.o.emit({ type: "release_changed" });
	}

	/** A build in any checkout folder (the section's, or an agent's worktree for build_release). */
	async buildAt(root: string, target: ReleaseTarget, progress: (text: string) => void = () => {}, version?: string): Promise<ReleaseBuild> {
		const appimagetool = target === "linux" ? await this.tool("appimagetool", progress) : undefined;
		return buildRelease({
			root,
			projectName: this.o.projectName(),
			target,
			version,
			engineRepo: this.o.engineRepo(),
			tools: { appimagetool, wine: which("wine") ?? undefined, winePrefix: join(this.o.dataDir, "wine"), browser: this.o.browser },
			onProgress: progress,
		});
	}

	/** Starts a built package in a window of its own (Windows builds under Wine; web builds in the default browser). */
	async run(checkout: string | null, version: string, target: ReleaseTarget): Promise<void> {
		const { dir, exe } = this.packageOf(checkout, version, target);
		if (target === "web") {
			if (!this.o.openWeb) throw new Error("There's no browser to open the web build in here");
			return this.o.openWeb(dir);
		}
		const wine = which("wine");
		if (target === "windows" && !wine) throw new Error("Wine isn't installed, so the Windows build can't run here");
		const [cmd, args] = target === "windows" ? [wine!, [join(dir, exe)]] : [join(dir, exe), []];
		const env = target === "windows" ? { ...process.env, WINEPREFIX: join(this.o.dataDir, "wine"), WINEDEBUG: "-all" } : process.env;
		spawn(cmd, args, { cwd: dir, env, detached: true, stdio: "ignore" }).unref();
	}

	/** The package folder of a build, absolute. */
	folder(checkout: string | null, version: string, target: ReleaseTarget): string {
		return this.packageOf(checkout, version, target).dir;
	}

	/** Uploads a build's package to its itch.io channel with butler. Only a build whose checks all passed. */
	async publish(checkout: string | null, version: string, target: ReleaseTarget): Promise<string> {
		const root = this.o.checkoutRoot(checkout);
		const { config } = readReleaseConfig(root, this.o.projectName(), version);
		if (!config.itch?.target) throw new Error("Set the itch.io page (user/game) in the release settings first");
		if (!existsSync(this.credsFile)) throw new Error("Add your itch.io API key under Settings → Accounts first");
		const build = listBuilds(root).find((b) => b.version === version && b.target === target);
		if (!build) throw new Error(`There's no ${target} build of ${version}`);
		if (!build.ok) throw new Error(`The ${target} build of ${version} has failed checks; fix them and build again before publishing`);
		const progress = (text: string) => this.o.emit({ type: "release_progress", checkout: checkout ?? "main", version, target, text });
		const butler = await this.tool("butler", progress);
		if (!butler) throw new Error("butler isn't available");
		const channel = config.itch.channels?.[target] ?? DEFAULT_ITCH_CHANNEL[target];
		progress(`Uploading to ${config.itch.target}:${channel}`);
		const res = await runTool(butler, ["push", join(root, build.dir), `${config.itch.target}:${channel}`, "--userversion", version, "-i", this.credsFile], (line) => progress(line));
		if (res.code !== 0) throw new Error(`butler push failed:\n${res.output.slice(-1500)}`);
		progress("Uploaded");
		return res.output;
	}

	/** butler status for the release's itch.io page: its channels and their latest builds. */
	async itchStatus(checkout: string | null, version?: string): Promise<string> {
		const { config } = readReleaseConfig(this.o.checkoutRoot(checkout), this.o.projectName(), version);
		if (!config.itch?.target) throw new Error("Set the itch.io page (user/game) in the release settings first");
		if (!existsSync(this.credsFile)) throw new Error("Add your itch.io API key under Settings → Accounts first");
		const butler = await this.tool("butler", () => {});
		const res = await runTool(butler!, ["status", config.itch.target, "-i", this.credsFile]);
		if (res.code !== 0) throw new Error(res.output.trim().slice(-800));
		return res.output;
	}

	hasItchKey(): boolean {
		return existsSync(this.credsFile);
	}

	/** Saves the itch.io API key where only butler reads it (null removes it). */
	setItchKey(key: string | null): void {
		if (key === null) {
			rmSync(this.credsFile, { force: true });
			return;
		}
		const k = key.trim();
		if (!/^[A-Za-z0-9]{20,}$/.test(k)) throw new Error("That doesn't look like an itch.io API key (itch.io → Settings → API keys)");
		mkdirSync(join(this.o.dataDir, "itch"), { recursive: true });
		writeFileSync(this.credsFile, k, { mode: 0o600 });
	}

	private get credsFile(): string {
		return join(this.o.dataDir, "itch/butler_creds");
	}

	private packageOf(checkout: string | null, version: string, target: ReleaseTarget): { dir: string; exe: string } {
		const root = this.o.checkoutRoot(checkout);
		const build = listBuilds(root).find((b) => b.version === version && b.target === target);
		if (!build || build.error) throw new Error(`There's no ${target} build of ${version}`);
		const slug = build.dir.slice(build.dir.lastIndexOf("/") + 1);
		return { dir: join(root, build.dir), exe: target === "windows" ? `${slug}.exe` : slug };
	}

	/** A downloaded tool, fetched the first time it's needed. */
	private async tool(name: "appimagetool" | "butler", progress: (t: string) => void): Promise<string | undefined> {
		const override = name === "butler" ? this.o.butler : this.o.appimagetool;
		if (override === "off") return undefined;
		if (override) return override;
		const dir = join(this.o.dataDir, "tools");
		const path = name === "butler" ? join(dir, "butler", "butler") : join(dir, "appimagetool");
		if (existsSync(path)) return path;
		progress(`Downloading ${name} (once)`);
		mkdirSync(dir, { recursive: true });
		const res = await fetch(name === "butler" ? BUTLER_URL : APPIMAGETOOL_URL);
		if (!res.ok) throw new Error(`Couldn't download ${name}: HTTP ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		if (name === "appimagetool") writeFileSync(path, bytes, { mode: 0o755 });
		else {
			const zip = join(dir, "butler.zip");
			writeFileSync(zip, bytes);
			rmSync(join(dir, "butler"), { recursive: true, force: true });
			execFileSync("python3", ["-m", "zipfile", "-e", zip, join(dir, "butler")]);
			rmSync(zip);
			for (const f of readdirSync(join(dir, "butler"))) chmodSync(join(dir, "butler", f), 0o755);
		}
		return path;
	}
}

/** The builds under builds/<version>/<target>/build.json, newest first. */
export function listBuilds(root: string): ReleaseBuild[] {
	const base = join(root, "builds");
	if (!existsSync(base)) return [];
	const out: ReleaseBuild[] = [];
	for (const version of readdirSync(base)) {
		for (const target of RELEASE_TARGETS) {
			const f = join(base, version, target, "build.json");
			if (!existsSync(f)) continue;
			try {
				out.push(JSON.parse(readFileSync(f, "utf8")) as ReleaseBuild);
			} catch {
				// a build interrupted while writing its record: not listed
			}
		}
	}
	return out.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
}

/** Notes on a build's record which session is looking into it. */
function attachInvestigation(root: string, version: string, target: ReleaseTarget, sessionId: string): void {
	const f = join(root, "builds", version, target, "build.json");
	try {
		const b = JSON.parse(readFileSync(f, "utf8")) as ReleaseBuild;
		writeFileSync(f, `${JSON.stringify({ ...b, investigation: sessionId }, null, "\t")}\n`);
	} catch {
		// no record to note it on (the build is still running, or its folder was removed)
	}
}

/**
 * What a session is told about a build to look into: one that failed or whose checks failed (`build`), or one that
 * is still running after a long time (`running`).
 */
export function investigationBrief(name: string, build: ReleaseBuild | null, running: ReleaseBuilding | null): string {
	const b = build ?? running!;
	const what = `the ${RELEASE_TARGET_LABEL[b.target]} build of ${name} ${b.version}`;
	const log = (lines: string[] | undefined) => (lines?.length ? `Its steps so far:\n${lines.map((l) => `- ${l}`).join("\n")}` : "");
	const confirm = `When you have fixed it, confirm with the build_release tool ({"target": "${b.target}", "version": "${b.version}"}): it must end with every check passing.`;
	const report = "Then report what was wrong and what you changed. If the cause is outside the game (the engine, the studio's build steps, a tool missing on this machine), say so plainly rather than working around it in the game.";
	if (running) {
		const minutes = Math.max(1, Math.round((Date.now() - Date.parse(running.startedAt)) / 60_000));
		return [
			`The Release section started ${what} about ${minutes} minute${minutes === 1 ? "" : "s"} ago and it is still running, which is longer than a build should take.`,
			log(running.log),
			"Find out what it is waiting on. The last step above is where it is: \"Compiling\" is the engine's release script; \"Checking the package\" starts the packaged game and then runs every tests/*.jsonl against it, one after another (a test that plays minutes of game time, or one that never ends, holds the build up: a first line `// flags: --mode=none` makes a test that needs no picture run many times faster). Look at the processes that are running and at the tests.",
			"Don't start another build while this one runs. Report what is slow and why; fix it in the game if that is where the cause is.",
		]
			.filter(Boolean)
			.join("\n\n");
	}
	if (build!.error) {
		return [`The Release section tried ${what} and the build failed: no package was made.`, `The error:\n${build!.error}`, log(build!.log), `Find the cause and fix it in this worktree. ${confirm}`, report].filter(Boolean).join("\n\n");
	}
	const failed = build!.checks.filter((c) => !c.ok);
	return [
		`The Release section made ${what}, but ${failed.length === 1 ? "one of its checks" : `${failed.length} of its checks`} failed. The package is in ${build!.dir}.`,
		`The failed checks:\n${failed.map((c) => `- ${c.name}: ${c.detail.slice(0, 1500)}`).join("\n")}`,
		"The checks run the packaged game (not the development build): started from another folder, then each tests/*.jsonl against it. A file the game loads but the package lacks is the usual difference: it ships only what the game code names (release.json's include adds more).",
		`Find the cause and fix it in this worktree. ${confirm}`,
		report,
	].join("\n\n");
}

/** release.json, written whole. */
export function writeReleases(root: string, releases: ReleaseConfig[]): void {
	writeFileSync(join(root, RELEASE_FILE), formatReleases(releases));
}

/** Adds a release (newest first), or with `replaces` changes the settings of that version. */
export function saveRelease(root: string, projectName: string, config: ReleaseConfig, replaces?: string): void {
	const { releases } = readReleases(root, projectName);
	const taken = releases.some((r) => r.version === config.version && r.version !== replaces);
	if (taken) throw new Error(`There's already a release ${config.version}`);
	if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(config.version)) throw new Error(`The version "${config.version}" isn't like 1.0.0`);
	if (!config.name.trim()) throw new Error("Give the release the game's name");
	const at = replaces ? releases.findIndex((r) => r.version === replaces) : -1;
	if (replaces && at < 0) throw new Error(`There's no release ${replaces}`);
	if (at >= 0) releases[at] = config;
	else releases.unshift(config);
	writeReleases(root, releases);
}

/** Release steps: the section's edits of release.json, and agents' build_release (publishing stays a person's). */
export function releaseRequests(service: () => ReleaseService, projectName: () => string): StudioRequestHandlers {
	return {
		save_release: handler<{ config: ReleaseConfig; replaces?: string }>(
			(ctx, p) => saveRelease(ctx.cwd, projectName(), p.config, p.replaces),
			(p) => ({ label: p.replaces ? `Release ${p.config.version} settings` : `New release ${p.config.version}`, scopes: [{ path: RELEASE_FILE }] }),
		),
		delete_release: handler<{ version: string }>(
			(ctx, p) => {
				const { releases } = readReleases(ctx.cwd, projectName());
				if (!releases.some((r) => r.version === p.version)) throw new Error(`There's no release ${p.version}`);
				writeReleases(ctx.cwd, releases.filter((r) => r.version !== p.version));
			},
			(p) => ({ label: `Delete release ${p.version}`, scopes: [{ path: RELEASE_FILE }] }),
		),
		build_release: handler<{ target?: ReleaseTarget; version?: string }>(async (ctx, p) => {
			const target = p.target ?? "linux";
			const b = await service().buildAt(ctx.cwd, target, ctx.progress, p.version);
			return { ...b, note: b.ok ? "Every check passed." : "Some checks failed: read each check's detail." };
		}),
	};
}

function which(cmd: string): string | null {
	try {
		return execFileSync("which", [cmd], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

function runTool(cmd: string, args: string[], onLine?: (line: string) => void): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		const add = (d: Buffer) => {
			const text = d.toString();
			output += text;
			for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine?.(line.trim());
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		child.on("error", (e) => resolve({ code: -1, output: String(e) }));
		child.on("close", (code) => resolve({ code: code ?? -1, output }));
	});
}
