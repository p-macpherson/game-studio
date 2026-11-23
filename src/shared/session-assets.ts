// The assets a session touched or talked about, for its chat: under each turn, a card per asset that turn made,
// changed, removed or showed (from its tool calls); and in the agent's words, the paths that name an asset (they
// become links). Worked out by the studio from the transcript, so it doesn't depend on the agent remembering to link.
import { assetLabel, ownerOf } from "./asset-links";
import type { AssetSummary, ModuleInfo } from "./modules";

export interface AssetCard {
	/** The asset's path (or, for a plain image the agent showed, the image's). */
	path: string;
	name: string;
	/** Its section; absent for a plain image. */
	module?: { id: string; name: string; icon: string };
	/** How the session's worktree stands against main for it; absent when unchanged or no longer known (merged). */
	change?: "added" | "modified" | "deleted";
	/** Where to open it and load its preview from: the session's worktree, or main (null). */
	checkout: string | null;
	/** A file that stands for it: a picture, or what it sounds like. */
	preview?: { kind: "image" | "audio"; path: string };
	/** The agent showed it on purpose (open_in_studio). */
	shown?: boolean;
}

export interface SessionAssets {
	/** By turn: turn n is everything after the nth message from the person (0: before their first). */
	turns: AssetCard[][];
	/** Paths as the agent wrote them → the asset they name. */
	mentions: Record<string, AssetCard>;
}

interface Block {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}
export interface TranscriptMessage {
	role: string;
	content: string | Block[];
	toolCallId?: string;
	isError?: boolean;
}

type Source = "write" | "tool" | "script" | "shown";
export interface Touch {
	/** A repo path, or a bare name (`byName`: of which sections). */
	path: string;
	source: Source;
	/** Set for a bare name: the sections the tool's name points at. */
	sections?: string[];
}

/** Tools that only look: nothing they name was touched. */
const LOOKS = /^(read|grep|find|ls|bash|ask_user|delegate|set_session_title|request_review|run_tests?|build_game|build_release)$|^(preview|capture|list|get|read|search|inspect|measure|check|describe|look|view|play|run)_/;
const IMAGE = /\.(png|jpe?g|webp)$/i;

/** Which sections a studio tool works in, from its name (generate_sound_takes → sounds). */
const HINTS: [RegExp, string][] = [
	[/model|rig|animat|concept/, "3d-models"],
	[/song|music/, "music"],
	[/sound/, "sounds"],
	[/voice/, "voices"],
	[/texture|surface/, "textures"],
	[/ui/, "ui"],
	[/scene|prefab/, "scenes"],
	[/effect|particle/, "effects"],
	[/shader/, "shaders"],
	[/doc/, "design-docs"],
];

const text = (content: TranscriptMessage["content"]): string => (typeof content === "string" ? content : content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n"));

function strings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out);
	else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
	return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds repo paths under the sections' folders in free text (an absolute path counts from the folder on). */
export function pathFinder(modules: ModuleInfo[]): (s: string) => string[] {
	const roots = [...new Set(modules.flatMap((m) => m.roots))].sort((a, b) => b.length - a.length);
	if (!roots.length) return () => [];
	const re = new RegExp(`(?<![\\w.-])(?:${roots.map(escape).join("|")})/[\\w\\-./]*[\\w\\-/]`, "g");
	// A file name may have spaces ("docs/design/Art Style.md"): when a match stops at a word with no extension and
	// the words after it end in one, that longer reading is offered too (whichever names an asset wins).
	const more = /^(?: [\w\-]+){0,3} [\w\-]*\.[A-Za-z0-9]{1,5}(?![\w/])/;
	return (s) => {
		const found: string[] = [];
		for (const m of s.matchAll(re)) {
			const p = m[0];
			const last = p.slice(p.lastIndexOf("/") + 1);
			const longer = last.includes(".") ? null : s.slice(m.index + p.length).match(more);
			if (longer) found.push(p + longer[0]);
			found.push(p.replace(/\/+$/, ""));
		}
		return found;
	};
}

/** What each turn's tool calls touched, as candidates (still to be matched against the assets that exist). */
export function touches(messages: TranscriptMessage[], modules: ModuleInfo[]): Touch[][] {
	const find = pathFinder(modules);
	const results = new Map<string, TranscriptMessage>();
	for (const m of messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const turns: Touch[][] = [[]];
	for (const m of messages) {
		if (m.role === "user") turns.push([]);
		if (m.role !== "assistant" || typeof m.content === "string") continue;
		const turn = turns[turns.length - 1];
		for (const b of m.content) {
			if (b.type !== "toolCall" || !b.name) continue;
			const result = b.id ? results.get(b.id) : undefined;
			if (result?.isError) continue;
			const args = (b.arguments ?? {}) as Record<string, unknown>;
			if (b.name === "open_in_studio") {
				if (typeof args.path === "string") turn.push({ path: args.path.replace(/^\.?\//, ""), source: "shown" });
			} else if (b.name === "write" || b.name === "edit") {
				if (typeof args.path === "string") for (const p of find(args.path)) turn.push({ path: p, source: "write" });
			} else if (b.name === "codemode") {
				for (const s of strings(args)) for (const p of find(s)) turn.push({ path: p, source: "script" });
			} else if (!LOOKS.test(b.name)) {
				for (const s of [...strings(args), result ? text(result.content) : ""]) for (const p of find(s)) turn.push({ path: p, source: "tool" });
				// "generate_model barrel": the asset by its name, in the sections the tool's name points at.
				const sections = HINTS.filter(([re]) => re.test(b.name!)).map(([, id]) => id);
				for (const key of ["name", "asset", "model", "song", "sound", "voice", "texture", "screen", "scene", "effect", "shader"]) {
					const v = args[key];
					if (sections.length && typeof v === "string" && v && !v.includes(" ") && !find(v).length) turn.push({ path: v, source: "tool", sections });
				}
			}
		}
	}
	return turns;
}

/** An asset's name within its section's folder: `props/barrel` for assets/models/props/barrel/model.json. */
function nameIn(module: ModuleInfo, path: string): string {
	const root = module.roots.find((r) => path.startsWith(`${r}/`)) ?? "";
	const rel = path.slice(root.length + 1);
	const ext = module.extensions.find((e) => rel.endsWith(e)) ?? "";
	const bare = rel.slice(0, rel.length - ext.length);
	// A folder-shaped asset (ui/art/frame/frame.json) goes by its folder.
	const folder = (module.folderAssets ?? []).find((f) => path.startsWith(`${f}/`));
	if (folder && bare.includes("/")) return bare.slice(0, bare.lastIndexOf("/"));
	return bare;
}

export interface Listed {
	module: ModuleInfo;
	asset: AssetSummary;
}

/**
 * Builds a session's cards and mentions. `listed`: every asset of the checkout the session's work is read from
 * (its worktree while open, with each asset's change; else main). `previewOf` looks on disk for a file standing
 * for an asset; `isFile` says whether a repo path exists there (for plain images the agent showed).
 */
export function sessionAssets(o: {
	messages: TranscriptMessage[];
	modules: ModuleInfo[];
	listed: Listed[];
	/** The session's worktree while it's open; null once merged or discarded (main). */
	checkout: string | null;
	previewOf(path: string, module: ModuleInfo): AssetCard["preview"];
	isFile(path: string): boolean;
}): SessionAssets {
	const byPath = new Map(o.listed.map((l) => [l.asset.path, l]));
	const paths = new Set(byPath.keys());
	const byName = new Map<string, string>();
	for (const l of o.listed) byName.set(`${l.module.id}:${nameIn(l.module, l.asset.path)}`, l.asset.path);

	/** The asset a path belongs to: itself, the manifest of the folder it's in, or the file it sits beside. */
	const owner = (path: string): string | null => {
		const direct = ownerOf(o.modules, paths, path);
		if (direct) return direct;
		const dir = path.slice(0, path.lastIndexOf("/"));
		const dot = path.lastIndexOf(".");
		const base = dot > dir.length ? path.slice(0, dot) : path;
		for (const l of o.listed) {
			const p = l.asset.path;
			// barrel.png beside barrel.json; frame.png inside ui/art/frame/; a folder named like its asset.
			if (p.startsWith(`${base}.`) && p.lastIndexOf(".") === base.length) return p;
			if (p === `${dir}/${dir.slice(dir.lastIndexOf("/") + 1)}.json`) return p;
			if (p.startsWith(`${path}/`) && nameIn(l.module, p) === path.slice((l.module.roots.find((r) => path.startsWith(`${r}/`)) ?? "").length + 1)) return p;
		}
		return null;
	};

	const cards = new Map<string, AssetCard>();
	const card = (path: string): AssetCard => {
		let c = cards.get(path);
		if (!c) {
			const l = byPath.get(path)!;
			const label = assetLabel(o.modules, path);
			const folder = nameIn(l.module, path);
			c = {
				path,
				name: l.module.extensions.every((e) => e.startsWith("/")) || (l.module.folderAssets ?? []).some((f) => path.startsWith(`${f}/`)) ? folder.slice(folder.lastIndexOf("/") + 1) : label.name,
				module: { id: l.module.id, name: l.module.name, icon: l.module.icon },
				checkout: o.checkout,
				...(l.asset.change ? { change: l.asset.change } : {}),
			};
			const preview = l.asset.change === "deleted" ? undefined : o.previewOf(path, l.module);
			if (preview) c.preview = preview;
			cards.set(path, c);
		}
		return c;
	};

	const turns = touches(o.messages, o.modules).map((turn) => {
		const out = new Map<string, AssetCard>();
		for (const t of turn) {
			const path = t.sections ? (t.sections.map((s) => byName.get(`${s}:${t.path}`)).find(Boolean) ?? null) : owner(t.path);
			if (!path) {
				// Not an asset: a picture the agent showed (a screenshot under build/) still gets a card.
				if (t.source === "shown" && IMAGE.test(t.path) && o.isFile(t.path) && !out.has(t.path)) {
					out.set(t.path, { path: t.path, name: t.path.slice(t.path.lastIndexOf("/") + 1), checkout: o.checkout, preview: { kind: "image", path: t.path }, shown: true });
				}
				continue;
			}
			const c = card(path);
			// With the worktree open, its changes say what was really touched (a script may only have read the rest).
			// Once it's merged that isn't known: trust the tools that write, not what a script happened to name.
			const keep = t.source === "shown" || (o.checkout ? !!c.change : t.source !== "script");
			if (!keep) continue;
			out.set(path, t.source === "shown" ? { ...c, shown: true } : (out.get(path) ?? c));
		}
		return [...out.values()];
	});

	const mentions: Record<string, AssetCard> = {};
	const find = pathFinder(o.modules);
	for (const m of o.messages) {
		if (m.role !== "assistant") continue;
		for (const written of find(text(m.content))) {
			if (written in mentions) continue;
			const path = owner(written);
			if (path) mentions[written] = card(path);
		}
	}
	return { turns, mentions };
}
