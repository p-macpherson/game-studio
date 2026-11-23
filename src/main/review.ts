// What the Review page shows for a worktree (shared/review.ts does the working out): its changed files grouped under
// the assets they belong to, each with a file that stands for it now and in main, the session that made it, and
// the sessions asking for review.
import type { ModuleInfo } from "../shared/modules";
import { STYLE_REVIEWER, type WorktreeReview, groupChanges } from "../shared/review";
import { type AssetService, MODULES } from "./assets";
import { gatherSessionAssets, previewOf } from "./session-assets";
import type { SessionService } from "./sessions";
import { type StudioRequestHandlers, handler } from "./studio-requests";

/** Agents' tools for a review's evidence: `capture_clip` films the game (see RunService.captureClip). */
export function reviewRequests(capture: (sessionId: string, params: { name?: string; script?: string; seconds?: number; fps?: number }) => Promise<unknown>): StudioRequestHandlers {
	return { capture_clip: handler((ctx, p: { name?: string; script?: string; seconds?: number; fps?: number }) => capture(ctx.sessionId, p)) };
}

export async function gatherReview(worktreeId: string, sessions: SessionService, assets: AssetService, checkoutRoot: (checkout: string | null) => string): Promise<WorktreeReview> {
	const w = sessions.listWorktrees().find((x) => x.id === worktreeId);
	if (!w) throw new Error(`Unknown worktree ${worktreeId}`);
	// The Style Reviewer's sessions judge the work; they aren't it.
	const inIt = sessions.list().filter((s) => s.worktreeId === worktreeId && s.agentType !== STYLE_REVIEWER);
	const requests = inIt
		.filter((s) => s.reviewRequested && s.status !== "done")
		.map((s) => ({ sessionId: s.id, title: s.title, agentType: s.agentType, summary: s.reviewSummary ?? "", at: s.reviewRequestedAt, lookAt: s.reviewLookAt ?? [], images: s.reviewImages ?? [], ...(s.reviewStartHere ? { startHere: s.reviewStartHere } : {}) }))
		.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
	// Newest first; a person's own sessions (no parent) before sub-agents.
	const fallbackSession = [...inIt].sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || b.createdAt.localeCompare(a.createdAt))[0]?.id;
	const changed = await sessions.worktreeChangedFiles(worktreeId);
	// The engine's and the studio's worktrees have no sections: everything is read as a diff.
	if (w.target !== "project") return { items: [], code: changed.filter((f) => !f.path.startsWith(".studio/")), requests, fallbackSession };
	const modules = MODULES.map((m) => m.info);
	const listed = (await Promise.all(MODULES.map(async (m) => (await assets.list(m.info.id, worktreeId)).map((asset) => ({ module: m.info, asset }))))).flat();
	const { items, code } = groupChanges(modules, listed, changed);
	const root = checkoutRoot(worktreeId);
	const main = checkoutRoot(null);
	const moduleOf = new Map<string, ModuleInfo>(modules.map((m) => [m.id, m]));
	for (const i of items) {
		const m = moduleOf.get(i.module.id)!;
		if (i.change !== "deleted") i.preview = previewOf(root, i.path, m);
		if (i.change !== "added") i.before = previewOf(main, i.path, m);
	}
	// Who made what: each session's cards, oldest session first so the latest to touch an asset wins.
	const wanted = new Set(items.map((i) => i.path));
	const maker = new Map<string, string>();
	for (const s of [...inIt].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
		try {
			const cards = (await gatherSessionAssets(s.id, sessions, assets, checkoutRoot)).turns.flat();
			for (const c of cards) if (wanted.has(c.path)) maker.set(c.path, s.id);
		} catch {
			// A transcript that can't be read: its items go to the fallback session.
		}
	}
	for (const i of items) if (maker.has(i.path)) i.sessionId = maker.get(i.path);
	return { items, code, requests, fallbackSession };
}
