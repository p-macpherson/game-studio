// Reviewing a worktree: what it changed as things a person can judge (a card per asset, main's version beside the
// worktree's), their verdicts, and the notes that go back to the agents. The grouping and the messages are worked
// out here; main/review.ts gathers what they need from disk.
import { assetLabel, ownerOf } from "./asset-links";
import type { AssetSummary, ModuleInfo } from "./modules";

export type Change = "added" | "modified" | "deleted";
export interface ReviewPreview {
	kind: "image" | "audio";
	path: string;
}

export interface ReviewItem {
	/** The asset's path. */
	path: string;
	name: string;
	module: { id: string; name: string; icon: string };
	change: Change;
	/** Every changed file that belongs to it. */
	files: { path: string; change: Change }[];
	/** What it looks or sounds like now (absent once removed), and in main (absent when new). */
	preview?: ReviewPreview;
	before?: ReviewPreview;
	/** A line about it from its section (a doc's first words, a model's facts). */
	excerpt?: string;
	/** The session that last worked on it, when the transcripts say: its notes go there. */
	sessionId?: string;
}

/** A session in the worktree that asked for review. */
export interface ReviewRequest {
	sessionId: string;
	title: string;
	agentType: string;
	summary: string;
	at?: string;
	/** What the agent says to check or try, and its pictures of the change (paths in the worktree's checkout). */
	lookAt: string[];
	images: string[];
}

export interface WorktreeReview {
	items: ReviewItem[];
	/** Changed files that are read as a diff, not judged as a card: game code, tests, and files no section owns. */
	code: { path: string; change: Change }[];
	requests: ReviewRequest[];
	/** Where notes go when no session is known for an item: the newest session a person started in the worktree. */
	fallbackSession?: string;
}

/** The studio's own checks of a game worktree, run when a session asks for review: does it build, do its tests pass. */
export interface ReviewChecks {
	worktreeId: string;
	state: "running" | "done";
	/** The commit that was checked (the worktree's HEAD then). */
	commit: string;
	startedAt: string;
	finishedAt?: string;
	/** While running: what it's doing now. */
	doing?: string;
	build?: { ok: boolean; errors: string[] };
	tests: { script: string; ok: boolean; durationMs: number; problem?: string }[];
}

/** In a line: "Builds · 3 of 3 tests pass", "Doesn't build", "1 of 3 tests fails". */
export function checksLine(c: ReviewChecks): { ok: boolean | null; text: string } {
	if (c.state === "running") return { ok: null, text: c.doing ?? "Checking…" };
	if (c.build && !c.build.ok) return { ok: false, text: "Doesn't build" };
	const failed = c.tests.filter((t) => !t.ok).length;
	if (!c.tests.length) return { ok: true, text: "Builds · no tests to run" };
	if (failed) return { ok: false, text: `Builds · ${failed} of ${c.tests.length} test${c.tests.length === 1 ? "" : "s"} fail${failed === 1 ? "s" : ""}` };
	return { ok: true, text: `Builds · ${c.tests.length === 1 ? "its test passes" : `all ${c.tests.length} tests pass`}` };
}

export interface Verdict {
	verdict: "fine" | "redo";
	note?: string;
}

/** Sections whose changes are read as a diff. */
const AS_DIFF = new Set(["game-code"]);

/**
 * Sorts a worktree's changed files into the assets they belong to (a model's .glb and thumbnail are the model's)
 * and the rest. An asset whose own file didn't change but whose other files did counts as modified.
 */
export function groupChanges(modules: ModuleInfo[], listed: { module: ModuleInfo; asset: AssetSummary }[], changed: { path: string; change: Change }[]): Pick<WorktreeReview, "items" | "code"> {
	const assets = new Map(listed.map((l) => [l.asset.path, l]));
	const paths = new Set(assets.keys());
	const items = new Map<string, ReviewItem>();
	const code: WorktreeReview["code"] = [];
	for (const f of changed) {
		if (f.path.startsWith(".studio/")) continue;
		const owner = ownerOf(modules, paths, f.path);
		const l = owner ? assets.get(owner) : undefined;
		if (!l || AS_DIFF.has(l.module.id)) {
			code.push(f);
			continue;
		}
		let item = items.get(l.asset.path);
		if (!item) {
			item = {
				path: l.asset.path,
				name: l.asset.title || assetLabel(modules, l.asset.path).name,
				module: { id: l.module.id, name: l.module.name, icon: l.module.icon },
				change: l.asset.change ?? "modified",
				files: [],
				...(l.asset.excerpt ? { excerpt: l.asset.excerpt } : {}),
			};
			items.set(item.path, item);
		}
		item.files.push(f);
	}
	const order = new Map(modules.map((m, i) => [m.id, i]));
	return { items: [...items.values()].sort((a, b) => (order.get(a.module.id) ?? 99) - (order.get(b.module.id) ?? 99) || a.path.localeCompare(b.path)), code };
}

/**
 * The follow-up messages a review sends: one per session, listing what needs work there with the person's notes
 * (and, so the agent knows what not to touch, what was fine). Items with no session of their own go to `fallback`.
 */
export function reviewMessages(items: ReviewItem[], verdicts: Record<string, Verdict>, fallback: string | undefined, general = ""): { sessionId: string; text: string }[] {
	const redo = items.filter((i) => verdicts[i.path]?.verdict === "redo");
	const by = new Map<string, ReviewItem[]>();
	for (const i of redo) {
		const to = i.sessionId ?? fallback;
		if (to) by.set(to, [...(by.get(to) ?? []), i]);
	}
	if (general.trim() && fallback && !by.has(fallback)) by.set(fallback, []);
	const fine = items.filter((i) => verdicts[i.path]?.verdict === "fine");
	return [...by].map(([sessionId, list]) => {
		const lines = ["[Review] I've reviewed this worktree."];
		if (general.trim() && sessionId === fallback) lines.push("", general.trim());
		if (list.length) {
			lines.push("", "These need more work:");
			for (const i of list) lines.push(`- ${i.module.name}: ${i.name} (${i.path})${verdicts[i.path].note?.trim() ? `: ${verdicts[i.path].note!.trim()}` : ""}`);
		}
		const kept = fine.filter((i) => (i.sessionId ?? fallback) === sessionId);
		if (kept.length) lines.push("", `These are fine as they are, leave them: ${kept.map((i) => i.name).join(", ")}.`);
		lines.push("", "Make the changes, commit, and call request_review again when it's ready.");
		return { sessionId, text: lines.join("\n") };
	});
}
