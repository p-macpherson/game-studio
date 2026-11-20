// Asset discovery for studio modules: the files of one checkout (the main one, or the worktree selected in the
// studio), and what that worktree changed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type AssetSearchHit, type AssetSummary, type ModuleInfo, moduleOwns } from "../shared/modules";
import { designDocs, summarizeMarkdown } from "../modules/design-docs/info";
import { gameCode, summarizeCode } from "../modules/game-code/info";
import { models3d, summarizeModel } from "../modules/3d-models/info";
import { music, summarizeSong } from "../modules/music/info";
import { scenes, summarizeScene } from "../modules/scenes/info";
import { sounds, summarizeSound } from "../modules/sounds/info";
import type { SessionService } from "./sessions";

export interface ModuleBackend {
	info: ModuleInfo;
	summarize(text: string, path: string): { title: string; excerpt: string };
}

export const MODULES: ModuleBackend[] = [
	{ info: designDocs, summarize: summarizeMarkdown },
	{ info: gameCode, summarize: summarizeCode },
	{ info: models3d, summarize: summarizeModel },
	{ info: music, summarize: summarizeSong },
	{ info: sounds, summarize: summarizeSound },
	{ info: scenes, summarize: summarizeScene },
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
			return {
				path,
				...m.summarize(readFileSync(full, "utf8"), path),
				inMain: existsSync(join(main, path)),
				updatedAt: statSync(full).mtime.toISOString(),
				...(change === "added" || change === "modified" ? { change } : {}),
			};
		});
		// What the worktree removed: listed from main, so it can be seen (and the removal merged or undone).
		const removed: AssetSummary[] = [...changes]
			.filter(([path, change]) => change === "deleted" && moduleOwns(m.info, path) && existsSync(join(main, path)))
			.map(([path]) => ({ path, ...m.summarize(readFileSync(join(main, path), "utf8"), path), inMain: true, change: "deleted" as const }));
		return [...present, ...removed].sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Reads an asset from a checkout (the main one by default). */
	read(path: string, checkout: string | null = null): string {
		if (!MODULES.some((m) => moduleOwns(m.info, path))) throw new Error(`${path} isn't a studio asset`);
		const full = safeJoin(this.checkoutRoot(checkout), path);
		return existsSync(full) ? readFileSync(full, "utf8") : "";
	}

	search(moduleId: string, query: string, checkout: string | null = null): AssetSearchHit[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const root = this.checkoutRoot(checkout);
		const hits: AssetSearchHit[] = [];
		for (const path of this.files(this.backend(moduleId), root)) {
			readFileSync(join(root, path), "utf8")
				.split("\n")
				.forEach((text, i) => {
					if (text.toLowerCase().includes(q)) hits.push({ path, line: i + 1, text: text.trim().slice(0, 200) });
				});
		}
		return hits.slice(0, 200);
	}
}
