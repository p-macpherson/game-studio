// The Release section's service: release.json and what ships, builds (one at a time, with progress), running a built
// package, and publishing to itch.io with butler. The tools it needs beyond the engine's (appimagetool, butler) are
// downloaded into the studio's data folder the first time; Wine is the system's.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioEvent } from "../shared/ipc";
import { DEFAULT_ITCH_CHANNEL, type ReleaseBuild, type ReleaseConfig, RELEASE_FILE, type ReleaseInfo, RELEASE_TARGETS, type ReleaseTarget } from "../shared/release";
import { type BrowserRun, buildRelease, readReleaseConfig, releaseManifest } from "./release";
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
}

export class ReleaseService {
	private busy = false;

	constructor(private readonly o: ReleaseServiceOptions) {}

	info(checkout: string | null): ReleaseInfo {
		const root = this.o.checkoutRoot(checkout);
		const { config, problems } = readReleaseConfig(root, this.o.projectName());
		return {
			config,
			problems,
			saved: existsSync(join(root, RELEASE_FILE)),
			manifest: releaseManifest(root, config),
			builds: listBuilds(root),
			tools: { wine: !!which("wine"), appimagetool: this.o.appimagetool !== "off", web: existsSync(join(root, "engine/tools/web.sh")) },
			itchKey: existsSync(this.credsFile),
		};
	}

	/** Builds, packages and checks one target, reporting each step as a release_progress event. */
	async build(checkout: string | null, target: ReleaseTarget): Promise<ReleaseBuild> {
		if (this.busy) throw new Error("A release is already being built");
		this.busy = true;
		const progress = (text: string) => this.o.emit({ type: "release_progress", checkout: checkout ?? "main", target, text });
		try {
			const result = await this.buildAt(this.o.checkoutRoot(checkout), target, progress);
			progress(result.ok ? "Done: every check passed" : "Done, with failed checks");
			return result;
		} finally {
			this.busy = false;
		}
	}

	/** A build in any checkout folder (the section's, or an agent's worktree for build_release). */
	async buildAt(root: string, target: ReleaseTarget, progress: (text: string) => void = () => {}): Promise<ReleaseBuild> {
		const appimagetool = target === "linux" ? await this.tool("appimagetool", progress) : undefined;
		return buildRelease({
			root,
			projectName: this.o.projectName(),
			target,
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
		const { config } = readReleaseConfig(root, this.o.projectName());
		if (!config.itch?.target) throw new Error("Set the itch.io page (user/game) in the release settings first");
		if (!existsSync(this.credsFile)) throw new Error("Add your itch.io API key under Settings → Accounts first");
		const build = listBuilds(root).find((b) => b.version === version && b.target === target);
		if (!build) throw new Error(`There's no ${target} build of ${version}`);
		if (!build.ok) throw new Error(`The ${target} build of ${version} has failed checks; fix them and build again before publishing`);
		const progress = (text: string) => this.o.emit({ type: "release_progress", checkout: checkout ?? "main", target, text });
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
	async itchStatus(checkout: string | null): Promise<string> {
		const { config } = readReleaseConfig(this.o.checkoutRoot(checkout), this.o.projectName());
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
		if (!build) throw new Error(`There's no ${target} build of ${version}`);
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

/** release.json, written whole: what the section's settings form saves (a person's edit, undoable). */
export function writeReleaseConfig(root: string, config: ReleaseConfig): void {
	const clean: Record<string, unknown> = { name: config.name, version: config.version };
	if (config.icon) clean.icon = config.icon;
	clean.targets = config.targets;
	if (config.include.length) clean.include = config.include;
	if (config.exclude.length) clean.exclude = config.exclude;
	if (config.itch?.target) clean.itch = config.itch;
	writeFileSync(join(root, RELEASE_FILE), `${JSON.stringify(clean, null, "\t")}\n`);
}

/** Release steps: the section's settings edit, and agents' build_release (publishing stays a person's). */
export function releaseRequests(service: () => ReleaseService): StudioRequestHandlers {
	return {
		edit_release: handler<{ config: ReleaseConfig }>(
			(ctx, p) => writeReleaseConfig(ctx.cwd, p.config),
			() => ({ label: "Release settings", scopes: [{ path: RELEASE_FILE }] }),
		),
		build_release: handler<{ target?: ReleaseTarget }>(async (ctx, p) => {
			const target = p.target ?? "linux";
			const b = await service().buildAt(ctx.cwd, target, ctx.progress);
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
