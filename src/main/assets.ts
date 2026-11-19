// Asset discovery for studio modules: files in the project's main checkout, plus drafts that active
// sessions are changing in their worktrees.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { type AssetDraft, type AssetSearchHit, type AssetSummary, type ModuleInfo, moduleOwns } from "../shared/modules";
import { designDocs, summarizeMarkdown } from "../modules/design-docs/info";
import { gameCode, summarizeCode } from "../modules/game-code/info";
import type { SessionService } from "./sessions";

export interface ModuleBackend {
	info: ModuleInfo;
	summarize(text: string, path: string): { title: string; excerpt: string };
}

export const MODULES: ModuleBackend[] = [
	{ info: designDocs, summarize: summarizeMarkdown },
	{ info: gameCode, summarize: summarizeCode },
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
		private readonly projectPath: () => string | null,
		private readonly sessions: SessionService,
	) {}

	private backend(moduleId: string): ModuleBackend {
		const m = MODULES.find((b) => b.info.id === moduleId);
		if (!m) throw new Error(`Unknown module ${moduleId}`);
		return m;
	}

	private project(): string {
		const p = this.projectPath();
		if (!p) throw new Error("No project is open");
		return p;
	}

	private mainFiles(m: ModuleBackend): string[] {
		const project = this.project();
		return m.info.roots.flatMap((r) => walk(join(project, r), project)).filter((p) => moduleOwns(m.info, p));
	}

	/** Changes to this module's assets in every unfinished project session with a worktree. */
	private async drafts(m: ModuleBackend): Promise<Map<string, AssetDraft[]>> {
		const out = new Map<string, AssetDraft[]>();
		for (const s of this.sessions.list()) {
			if (s.target !== "project" || s.status === "done" || s.worktree !== "active") continue;
			for (const f of await this.sessions.changedFiles(s.id)) {
				if (!moduleOwns(m.info, f.path)) continue;
				const list = out.get(f.path) ?? [];
				list.push({ sessionId: s.id, sessionTitle: s.title, status: s.status, change: f.change });
				out.set(f.path, list);
			}
		}
		return out;
	}

	async list(moduleId: string): Promise<AssetSummary[]> {
		const m = this.backend(moduleId);
		const project = this.project();
		const drafts = await this.drafts(m);
		const assets: AssetSummary[] = this.mainFiles(m).map((path) => {
			const full = join(project, path);
			return {
				path,
				...m.summarize(readFileSync(full, "utf8"), path),
				inMain: true,
				updatedAt: statSync(full).mtime.toISOString(),
				drafts: drafts.get(path) ?? [],
			};
		});
		for (const [path, list] of drafts) {
			if (assets.some((a) => a.path === path)) continue;
			const added = list.find((d) => d.change === "added");
			if (!added) continue;
			const text = this.read(path, added.sessionId);
			assets.push({ path, ...m.summarize(text, path), inMain: false, drafts: list });
		}
		return assets.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Reads an asset from the main checkout, or from a session's worktree. */
	read(path: string, sessionId?: string): string {
		if (!MODULES.some((m) => moduleOwns(m.info, path))) throw new Error(`${path} isn't a studio asset`);
		const root = sessionId ? this.sessions.get(sessionId).worktreePath : this.project();
		const full = safeJoin(root, path);
		return existsSync(full) ? readFileSync(full, "utf8") : "";
	}

	search(moduleId: string, query: string): AssetSearchHit[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const project = this.project();
		const hits: AssetSearchHit[] = [];
		for (const path of this.mainFiles(this.backend(moduleId))) {
			readFileSync(join(project, path), "utf8")
				.split("\n")
				.forEach((text, i) => {
					if (text.toLowerCase().includes(q)) hits.push({ path, line: i + 1, text: text.trim().slice(0, 200) });
				});
		}
		return hits.slice(0, 200);
	}
}
