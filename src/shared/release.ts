// Shipping builds: the project's release.json (its releases, one per version), and which of its files a player's copy of
// the game needs. The main process (src/main/release.ts) builds, packages and checks releases with these rules.

export type ReleaseTarget = "linux" | "windows" | "web";
export const RELEASE_TARGETS: ReleaseTarget[] = ["linux", "windows", "web"];
export const RELEASE_TARGET_LABEL: Record<ReleaseTarget, string> = { linux: "Linux", windows: "Windows", web: "Web" };
/** The itch.io channel a target uploads to unless the release names one. */
export const DEFAULT_ITCH_CHANNEL: Record<ReleaseTarget, string> = { linux: "linux", windows: "windows", web: "html5" };
export const RELEASE_FILE = "release.json";

/** One release: a version of the game for players, built for whichever platforms are asked for. */
export interface ReleaseConfig {
	/** The game's name for players: archive and folder names are made from it. */
	name: string;
	/** The version players see (in the log, the `info` command and file names), e.g. "1.0.0". It names the release. */
	version: string;
	/** The window and .exe icon: a PNG under assets/, assets-relative (e.g. "ui/icon.png"). */
	icon?: string;
	/** Asset files (assets-relative globs) to ship although nothing seems to use them: loaded by a computed path. */
	include: string[];
	/** Asset files (assets-relative globs) never to ship. */
	exclude: string[];
	/** itch.io page ("user/game") and the channel for each target. */
	itch?: { target: string; channels?: Partial<Record<ReleaseTarget, string>> };
}

function parseEntry(raw: Record<string, unknown>, projectName: string, problems: string[]): ReleaseConfig {
	const str = (k: string) => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
	const list = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
	const version = str("version") ?? "0.1.0";
	if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) problems.push(`version "${version}" isn't like 1.0.0`);
	const icon = str("icon");
	if (icon && !icon.toLowerCase().endsWith(".png")) problems.push(`icon "${icon}" must be a PNG under assets/`);
	const itchRaw = raw.itch as { target?: unknown; channels?: unknown } | undefined;
	const itch =
		itchRaw && typeof itchRaw.target === "string"
			? { target: itchRaw.target, channels: itchRaw.channels as Partial<Record<ReleaseTarget, string>> | undefined }
			: undefined;
	if (itch && !/^[\w-]+\/[\w-]+$/.test(itch.target)) problems.push(`itch target "${itch.target}" must be user/game`);
	return { name: str("name") ?? projectName, version, icon, include: list("include"), exclude: list("exclude"), itch };
}

function parseObject(text: string | undefined, problems: string[]): Record<string, unknown> {
	if (text === undefined) return {};
	try {
		const v = JSON.parse(text) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
		problems.push("release.json must be an object");
	} catch (e) {
		problems.push(`release.json is not valid JSON: ${(e as Error).message}`);
	}
	return {};
}

/** One release's settings from its JSON, with defaults for what it leaves out (`text` undefined: all defaults). */
export function parseReleaseConfig(text: string | undefined, projectName: string): { config: ReleaseConfig; problems: string[] } {
	const problems: string[] = [];
	return { config: parseEntry(parseObject(text, problems), projectName, problems), problems };
}

/**
 * release.json's releases, newest first: `{"releases": [{...}, ...]}`. A file from before releases were a list (one
 * object with the settings) is one release; no file is none.
 */
export function parseReleases(text: string | undefined, projectName: string): { releases: ReleaseConfig[]; problems: string[] } {
	const problems: string[] = [];
	if (text === undefined) return { releases: [], problems };
	const raw = parseObject(text, problems);
	if (problems.length) return { releases: [], problems };
	const entries = Array.isArray(raw.releases) ? raw.releases.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : [raw];
	const releases: ReleaseConfig[] = [];
	for (const e of entries) {
		const own: string[] = [];
		const config = parseEntry(e, projectName, own);
		problems.push(...own.map((p) => `${config.version}: ${p}`));
		if (releases.some((r) => r.version === config.version)) problems.push(`version ${config.version} is there twice`);
		else releases.push(config);
	}
	return { releases, problems };
}

/** release.json's text for these releases. */
export function formatReleases(releases: ReleaseConfig[]): string {
	const clean = releases.map((c) => ({
		name: c.name,
		version: c.version,
		...(c.icon ? { icon: c.icon } : {}),
		...(c.include.length ? { include: c.include } : {}),
		...(c.exclude.length ? { exclude: c.exclude } : {}),
		...(c.itch?.target ? { itch: c.itch } : {}),
	}));
	return `${JSON.stringify({ releases: clean }, null, "\t")}\n`;
}

/** What a new release starts as: the newest one's settings with the next patch version, else the project's name at 0.1.0. */
export function nextRelease(releases: ReleaseConfig[], projectName: string): ReleaseConfig {
	const last = releases[0];
	if (!last) return { name: projectName, version: "0.1.0", include: [], exclude: [] };
	let version = last.version;
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	let patch = m ? Number(m[3]) : 0;
	do {
		patch += 1;
		version = m ? `${m[1]}.${m[2]}.${patch}` : `0.1.${patch}`;
	} while (releases.some((r) => r.version === version));
	return { ...last, version, include: [...last.include], exclude: [...last.exclude] };
}

/** A file-name-safe form of the game's name: "Goblin Gold" → "goblin-gold". */
export function releaseSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^\w\s-]/g, "")
			.trim()
			.replace(/[\s_]+/g, "-")
			.replace(/-+/g, "-") || "game"
	);
}

/** The archive (or AppImage) names for a build. */
export function releaseArchiveName(config: ReleaseConfig, target: ReleaseTarget, kind: "tar.gz" | "zip" | "AppImage"): string {
	if (target === "web") return `${releaseSlug(config.name)}-${config.version}-web.${kind}`;
	return `${releaseSlug(config.name)}-${config.version}-${target}-x86_64.${kind}`;
}

/** Folders inside asset folders that hold the studio's working files: generation inputs and outputs not chosen. */
const WORKING_FOLDERS = ["candidates", "concepts", "source", "takes", "stems"];
/** File types the engine loads. */
const RUNTIME_EXTENSIONS = ["glb", "gltf", "bin", "png", "jpg", "jpeg", "hdr", "ogg", "wav", "mp3", "flac", "glsl", "ttf", "otf"];

/**
 * Why an asset file (assets-relative path) can never ship, or null if the engine can load it. JSON is engine data
 * only for scenes, prefabs, screens, UI art's slice sidecars and effects; elsewhere it's a studio record
 * (model.json, sound.json, a particle texture's recipe…).
 */
export function notRuntime(path: string): string | null {
	const parts = path.split("/");
	const name = parts[parts.length - 1];
	if (name.startsWith(".")) return "hidden file";
	const working = parts.slice(0, -1).find((p) => WORKING_FOLDERS.includes(p));
	if (working) return `working file (${working}/)`;
		const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
	if (RUNTIME_EXTENSIONS.includes(ext)) return null;
	if (ext === "json") {
		const top = parts[0];
		if (top === "scenes" || top === "prefabs") return null;
		if (top === "ui" && (parts.length === 2 || parts[1] === "art")) return null;
		if (top === "effects" && parts[1] !== "textures") return null;
		return "studio record";
	}
	return "not a file the engine loads";
}

/** True if `path` goes with `base` (same folder): a sound's variants (x-2.ogg), a texture's maps (x_normal.png), a sidecar (x.json). */
export function isCompanion(base: string, path: string): boolean {
	const dir = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
	if (path === base || dir(path) !== dir(base)) return false;
	const stem = (p: string) => {
		const n = p.slice(p.lastIndexOf("/") + 1);
		return n.includes(".") ? n.slice(0, n.indexOf(".")) : n;
	};
	const b = stem(base);
	const s = stem(path);
	return s === b || s.startsWith(`${b}-`) || s.startsWith(`${b}_`);
}

/** Glob (`*` within a folder, `**` across folders) to a test for assets-relative paths. */
export function globMatcher(globs: string[]): (path: string) => boolean {
	const res = globs.map(
		(gl) =>
			new RegExp(
				`^${gl
					.split("**")
					.map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
					.join(".*")}$`,
			),
	);
	return (path) => res.some((r) => r.test(path));
}

export interface ShippedFile {
	/** Repo-relative, under assets/. */
	path: string;
	size: number;
	/** Why it ships: "game code (game/main.odin)", "used by assets/scenes/x.json", "goes with …", "release.json include". */
	why: string;
}
export interface LeftOutFile {
	path: string;
	size: number;
	/** "working file (takes/)", "studio record", "nothing uses it", "release.json exclude". */
	why: string;
}
export interface ReleaseManifest {
	files: ShippedFile[];
	leftOut: LeftOutFile[];
	bytes: number;
}

export interface ReleaseCheck {
	name: string;
	ok: boolean;
	detail: string;
}
export interface ReleaseBuild {
	target: ReleaseTarget;
	version: string;
	/** The package folder (what the archives hold), project-relative: builds/<version>/<target>/<slug>. */
	dir: string;
	/** Archives (and the AppImage), project-relative. */
	archives: string[];
	checks: ReleaseCheck[];
	/** A package was made and every check passed. */
	ok: boolean;
	/** The build itself failed (it didn't compile, a tool is missing…): there is no package, only this. */
	error?: string;
	/** The steps it went through. */
	log?: string[];
	/** How long it took. */
	seconds?: number;
	/** The session looking into what went wrong with it, if one was started. */
	investigation?: string;
	files: number;
	bytes: number;
	builtAt: string;
}

/** A build that is running now. */
export interface ReleaseBuilding {
	/** "main" or a worktree id. */
	checkout: string;
	version: string;
	target: ReleaseTarget;
	startedAt: string;
	log: string[];
	/** The session asked to look into why it's taking so long. */
	investigation?: string;
}

/** After this long, a build is "taking a while" and the section offers to have a session look into it. */
export const RELEASE_SLOW_SECONDS = 180;

/** What the Release section shows for a checkout. */
export interface ReleaseInfo {
	/** release.json's releases, newest first. */
	releases: ReleaseConfig[];
	problems: string[];
	/** What "New release" starts from. */
	suggested: ReleaseConfig;
	/** Builds in builds/, newest first (also of versions release.json no longer has). */
	builds: ReleaseBuild[];
	/** The build running now, in any checkout (one at a time). */
	building: ReleaseBuilding | null;
	/** Wine is installed (Windows builds can be checked); appimagetool is here or can be downloaded; the game's engine can build for the web. */
	tools: { wine: boolean; appimagetool: boolean; web: boolean };
	/** An itch.io API key is saved (Settings → Accounts). */
	itchKey: boolean;
}
