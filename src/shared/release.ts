// Shipping builds: the project's release.json, and which of its files a player's copy of the game needs. The main
// process (src/main/release.ts) builds, packages and checks releases with these rules.

export type ReleaseTarget = "linux" | "windows" | "web";
export const RELEASE_TARGETS: ReleaseTarget[] = ["linux", "windows", "web"];
/** The platforms of a release.json that names none: web (a browser build) is opted into. */
export const DEFAULT_RELEASE_TARGETS: ReleaseTarget[] = ["linux", "windows"];
export const RELEASE_TARGET_LABEL: Record<ReleaseTarget, string> = { linux: "Linux", windows: "Windows", web: "Web" };
/** The itch.io channel a target uploads to unless release.json names one. */
export const DEFAULT_ITCH_CHANNEL: Record<ReleaseTarget, string> = { linux: "linux", windows: "windows", web: "html5" };
export const RELEASE_FILE = "release.json";

export interface ReleaseConfig {
	/** The game's name for players: archive and folder names are made from it. */
	name: string;
	/** The version players see (in the log, the `info` command and file names), e.g. "1.0.0". */
	version: string;
	/** The window and .exe icon: a PNG under assets/, assets-relative (e.g. "ui/icon.png"). */
	icon?: string;
	targets: ReleaseTarget[];
	/** Asset files (assets-relative globs) to ship although nothing seems to use them: loaded by a computed path. */
	include: string[];
	/** Asset files (assets-relative globs) never to ship. */
	exclude: string[];
	/** itch.io page ("user/game") and the channel for each target. */
	itch?: { target: string; channels?: Partial<Record<ReleaseTarget, string>> };
}

/** release.json, with defaults for what it leaves out (it may not exist yet: `text` undefined). */
export function parseReleaseConfig(text: string | undefined, projectName: string): { config: ReleaseConfig; problems: string[] } {
	const problems: string[] = [];
	let raw: Record<string, unknown> = {};
	if (text !== undefined) {
		try {
			const v = JSON.parse(text) as unknown;
			if (v && typeof v === "object" && !Array.isArray(v)) raw = v as Record<string, unknown>;
			else problems.push("release.json must be an object");
		} catch (e) {
			problems.push(`release.json is not valid JSON: ${(e as Error).message}`);
		}
	}
	const str = (k: string) => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
	const list = (k: string) => (Array.isArray(raw[k]) ? (raw[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
	const version = str("version") ?? "0.1.0";
	if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) problems.push(`version "${version}" isn't like 1.0.0`);
	const targets = raw.targets === undefined ? [...DEFAULT_RELEASE_TARGETS] : list("targets");
	for (const t of targets) if (!RELEASE_TARGETS.includes(t as ReleaseTarget)) problems.push(`unknown target "${t}" (linux, windows or web)`);
	const icon = str("icon");
	if (icon && !icon.toLowerCase().endsWith(".png")) problems.push(`icon "${icon}" must be a PNG under assets/`);
	const itchRaw = raw.itch as { target?: unknown; channels?: unknown } | undefined;
	const itch =
		itchRaw && typeof itchRaw.target === "string"
			? { target: itchRaw.target, channels: itchRaw.channels as Partial<Record<ReleaseTarget, string>> | undefined }
			: undefined;
	if (itch && !/^[\w-]+\/[\w-]+$/.test(itch.target)) problems.push(`itch target "${itch.target}" must be user/game`);
	return {
		config: {
			name: str("name") ?? projectName,
			version,
			icon,
			targets: targets.filter((t): t is ReleaseTarget => RELEASE_TARGETS.includes(t as ReleaseTarget)),
			include: list("include"),
			exclude: list("exclude"),
			itch,
		},
		problems,
	};
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
	ok: boolean;
	files: number;
	bytes: number;
	builtAt: string;
}


/** What the Release section shows for a checkout. */
export interface ReleaseInfo {
	config: ReleaseConfig;
	problems: string[];
	/** release.json exists (else the config is the defaults). */
	saved: boolean;
	manifest: ReleaseManifest;
	/** Past builds in builds/, newest first. */
	builds: ReleaseBuild[];
	/** Wine is installed (Windows builds can be checked); appimagetool is here or can be downloaded; the game's engine can build for the web. */
	tools: { wine: boolean; appimagetool: boolean; web: boolean };
	/** An itch.io API key is saved (Settings → Accounts). */
	itchKey: boolean;
}
