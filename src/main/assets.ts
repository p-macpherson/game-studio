// Asset discovery for studio modules: the files of one checkout (the main one, or the worktree selected in the
// studio), and what that worktree changed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type AssetSearchHit, type AssetSummary, type ModuleInfo, type MoveResult, moduleOwns } from "../shared/modules";
import { designDocs, summarizeMarkdown } from "../modules/design-docs/info";
import { gameCode, summarizeCode } from "../modules/game-code/info";
import { models3d, summarizeModel } from "../modules/3d-models/info";
import { music, summarizeSong } from "../modules/music/info";
import { scenes, summarizeScene } from "../modules/scenes/info";
import { sounds, summarizeSound } from "../modules/sounds/info";
import { summarizeVoice, voices } from "../modules/voices/info";
import { summarizeTexture, textures } from "../modules/textures/info";
import { effects, summarizeEffect } from "../modules/effects/info";
import { shaders, summarizeShader } from "../modules/shaders/info";
import { scenarios, summarizeScenario } from "../modules/scenarios/info";
import { summarizeUi, ui } from "../modules/ui/info";
import { images, summarizeImage } from "../modules/images/info";
import type { AssetLinks } from "../shared/asset-links";
import { assetLinks } from "./asset-links";
import { moveAsset } from "./asset-move";
import type { SessionService } from "./sessions";

type Summary = { title: string; excerpt: string; status?: string };

/** A module summarizes its assets from their text, or (pictures) from their bytes, never read as text. */
export interface ModuleBackend {
	info: ModuleInfo;
	summarize?(text: string, path: string): Summary;
	summarizeBytes?(bytes: Buffer, path: string): Summary;
}

const isBinary = (m: ModuleBackend) => !!m.summarizeBytes;

function summaryOf(m: ModuleBackend, full: string, path: string): Summary {
	if (m.summarizeBytes) return m.summarizeBytes(readFileSync(full), path);
	return m.summarize ? m.summarize(readFileSync(full, "utf8"), path) : { title: path, excerpt: "" };
}

export const MODULES: ModuleBackend[] = [
	{ info: designDocs, summarize: summarizeMarkdown },
	{ info: gameCode, summarize: summarizeCode },
	{ info: models3d, summarize: summarizeModel },
	{ info: music, summarize: summarizeSong },
	{ info: sounds, summarize: summarizeSound },
	{ info: voices, summarize: summarizeVoice },
	{ info: scenes, summarize: summarizeScene },
	{ info: textures, summarize: summarizeTexture },
	{ info: ui, summarize: summarizeUi },
	{ info: shaders, summarize: summarizeShader },
	{ info: effects, summarize: summarizeEffect },
	{ info: scenarios, summarize: summarizeScenario },
	{ info: images, summarizeBytes: summarizeImage },
];

export function walk(dir: string, base: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, base, out);
		else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
	}
	return out;
}

/** Resolves a repo-relative path inside `root`, refusing anything that escapes it. */
export function safeJoin(root: string, path: string): string {
	const full = resolve(root, path);
	if (!full.startsWith(resolve(root) + sep)) throw new Error(`Path escapes the project: ${path}`);
	return full;
}

export class AssetService {
	/** file → its summary at a given size and time: listing a section doesn't read files that haven't changed. */
	private readonly summaries = new Map<string, { size: number; mtimeMs: number; summary: { title: string; excerpt: string; status?: string } }>();

	constructor(
		/** The root of a checkout: the main one (null) or a worktree's (by id). */
		private readonly checkoutRoot: (checkout: string | null) => string,
		private readonly sessions: SessionService,
	) {}

	private backend(moduleId: string): ModuleBackend {
		const m = MODULES.find((b) => b.info.id === moduleId);
		if (!m) throw new Error(`Unknown module ${moduleId}`);
		return m;
	}

	private files(m: ModuleBackend, root: string): string[] {
		return m.info.roots.flatMap((r) => walk(join(root, r), root)).filter((p) => moduleOwns(m.info, p));
	}

	/** A module's assets as one checkout has them; in a worktree, each says whether the worktree added or changed it. */
	async list(moduleId: string, checkout: string | null = null): Promise<AssetSummary[]> {
		const m = this.backend(moduleId);
		const root = this.checkoutRoot(checkout);
		const main = this.checkoutRoot(null);
		const changes = new Map((checkout ? await this.sessions.worktreeChangedFiles(checkout) : []).map((f) => [f.path, f.change]));
		const present: AssetSummary[] = this.files(m, root).map((path) => {
			const full = join(root, path);
			const change = changes.get(path);
			const st = statSync(full);
			let known = this.summaries.get(full);
			if (!known || known.size !== st.size || known.mtimeMs !== st.mtimeMs) {
				known = { size: st.size, mtimeMs: st.mtimeMs, summary: summaryOf(m, full, path) };
				this.summaries.set(full, known);
			}
			return {
				path,
				...known.summary,
				inMain: existsSync(join(main, path)),
				updatedAt: st.mtime.toISOString(),
				...(change === "added" || change === "modified" ? { change } : {}),
			};
		});
		// What the worktree removed: listed from main, so it can be seen (and the removal merged or undone).
		const removed: AssetSummary[] = [...changes]
			.filter(([path, change]) => change === "deleted" && moduleOwns(m.info, path) && existsSync(join(main, path)))
			.map(([path]) => ({ path, ...summaryOf(m, join(main, path), path), inMain: true, change: "deleted" as const }));
		return [...present, ...removed].sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Reads an asset from a checkout (the main one by default). */
	read(path: string, checkout: string | null = null): string {
		const m = MODULES.find((b) => moduleOwns(b.info, path));
		if (!m) throw new Error(`${path} isn't a studio asset`);
		const full = safeJoin(this.checkoutRoot(checkout), path);
		// A picture isn't text: its view shows the file itself (studioFile).
		return existsSync(full) && !isBinary(m) ? readFileSync(full, "utf8") : "";
	}

	/** Which assets use which in a checkout (scenes, prefabs, manifests, game code and tests; see asset-links.ts). */
	links(checkout: string | null = null): AssetLinks {
		const root = this.checkoutRoot(checkout);
		return assetLinks(root, MODULES.map((m) => m.info), MODULES.flatMap((m) => this.files(m, root)));
	}

	/** Moves or renames an asset or a folder of them, in a worktree (never main), rewriting references (asset-move.ts). */
	move(moduleId: string, checkout: string | null, from: string, to: string): MoveResult {
		if (!checkout) throw new Error("Moves happen in a worktree: select or create one first");
		return moveAsset(this.checkoutRoot(checkout), this.backend(moduleId).info, from, to);
	}

	search(moduleId: string, query: string, checkout: string | null = null): AssetSearchHit[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const root = this.checkoutRoot(checkout);
		const hits: AssetSearchHit[] = [];
		const m = this.backend(moduleId);
		if (isBinary(m)) {
			// Pictures are found by their path and what they show (a generated one's prompt).
			for (const path of this.files(m, root)) {
				const { excerpt } = summaryOf(m, join(root, path), path);
				if (`${path} ${excerpt}`.toLowerCase().includes(q)) hits.push({ path, line: 1, text: excerpt.slice(0, 200) });
			}
			return hits.slice(0, 200);
		}
		for (const path of this.files(m, root)) {
			readFileSync(join(root, path), "utf8")
				.split("\n")
				.forEach((text, i) => {
					if (text.toLowerCase().includes(q)) hits.push({ path, line: i + 1, text: text.trim().slice(0, 200) });
				});
		}
		return hits.slice(0, 200);
	}
}
