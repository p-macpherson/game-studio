// Worktrees: labelled pieces of work, each a git worktree on its own branch, that sessions (and the sections'
// edits) happen in and that merge as a whole. See the vault notes "Sessions & Worktrees" and "M8 Workflow & Sessions".
//   <repo>/.studio/worktrees/<id>.json      the record (committed with the repo, like session records)
//   <worktreeRoot>/<repo name>/<id>/         the checkout, on branch studio/<id>
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Settings, Target, WorktreeRecord } from "../shared/types";
import * as g from "./git";

export const WORKTREES_DIR = ".studio/worktrees";

export interface Worktree {
	record: WorktreeRecord;
	repoPath: string;
}

export type FileChange = { path: string; change: "added" | "modified" | "deleted" };

export class WorktreeStore {
	private readonly items = new Map<string, Worktree>();

	constructor(private readonly deps: { settings(): Settings; changed(): void }) {}

	path(w: Worktree): string {
		return join(this.deps.settings().worktreeRoot, basename(w.repoPath), w.record.id);
	}

	file(w: Worktree): string {
		return join(w.repoPath, WORKTREES_DIR, `${w.record.id}.json`);
	}

	hasCheckout(w: Worktree): boolean {
		return existsSync(join(this.path(w), ".git"));
	}

	/** (Re)reads the records of these repos; records of other repos are forgotten. */
	load(repos: { target: Target; path: string }[]): void {
		const seen = new Set<string>();
		for (const { target, path } of repos) {
			const dir = join(path, WORKTREES_DIR);
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
				const id = f.slice(0, -5);
				const known = this.items.get(id);
				const record: WorktreeRecord = known && known.repoPath === path ? known.record : { ...JSON.parse(readFileSync(join(dir, f), "utf8")), target };
				this.items.set(id, { record, repoPath: path });
				seen.add(id);
			}
		}
		for (const id of this.items.keys()) if (!seen.has(id)) this.items.delete(id);
	}

	get(id: string): Worktree {
		const w = this.items.get(id);
		if (!w) throw new Error(`Unknown worktree ${id}`);
		return w;
	}

	find(id: string): Worktree | undefined {
		return this.items.get(id);
	}

	all(): Worktree[] {
		return [...this.items.values()];
	}

	save(w: Worktree): void {
		w.record.updatedAt = new Date().toISOString();
		mkdirSync(join(w.repoPath, WORKTREES_DIR), { recursive: true });
		writeFileSync(this.file(w), `${JSON.stringify(w.record, null, "\t")}\n`);
		this.deps.changed();
	}

	/** Adds a record as it is (used when migrating sessions that had their own worktree). */
	adopt(record: WorktreeRecord, repoPath: string): Worktree {
		const w = { record, repoPath };
		this.items.set(record.id, w);
		this.save(w);
		return w;
	}

	/** A new worktree branched from the repo's current branch; its checkout is made by `ensureCheckout`. */
	async create(repoPath: string, target: Target, id: string, label: string): Promise<Worktree> {
		if (!(await g.hasCommits(repoPath))) throw new Error(`${repoPath} has no commits yet`);
		const now = new Date().toISOString();
		return this.adopt(
			{
				id,
				label,
				target,
				branch: `studio/${id}`,
				baseBranch: await g.currentBranch(repoPath),
				baseCommit: await g.revParse(repoPath, "HEAD"),
				status: "active",
				checkout: "removed",
				createdAt: now,
				updatedAt: now,
			},
			repoPath,
		);
	}

	rename(w: Worktree, label: string): void {
		if (!label.trim()) throw new Error("A worktree needs a label");
		w.record.label = label.trim();
		this.save(w);
	}

	/**
	 * Makes the checkout if it's missing, reopening a merged or discarded worktree: a merged branch is first
	 * fast-forwarded to the base, so work continues from what's in main.
	 */
	async ensureCheckout(w: Worktree, initSubmodules: (dir: string) => Promise<void>): Promise<void> {
		const r = w.record;
		if (this.hasCheckout(w)) {
			if (r.status !== "active" || r.checkout !== "active") {
				r.status = "active";
				r.checkout = "active";
				this.save(w);
			}
			return;
		}
		const dir = this.path(w);
		await g.git(w.repoPath, ["worktree", "prune"]);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, ".."), { recursive: true });
		if (await g.branchExists(w.repoPath, r.branch)) {
			if (r.status === "merged" && (await g.isAncestor(w.repoPath, r.branch, r.baseBranch))) {
				await g.git(w.repoPath, ["branch", "-f", r.branch, r.baseBranch]);
				r.baseCommit = await g.revParse(w.repoPath, r.baseBranch);
			}
			await g.worktreeAdd(w.repoPath, dir, r.branch);
		} else if (r.status === "merged") {
			// Its branch was deleted after the merge (its work is in the base now): start again from the base.
			r.baseCommit = await g.revParse(w.repoPath, r.baseBranch);
			await g.worktreeAdd(w.repoPath, dir, r.branch, r.baseCommit);
		} else {
			await g.worktreeAdd(w.repoPath, dir, r.branch, r.baseCommit);
		}
		await initSubmodules(dir);
		r.status = "active";
		r.checkout = "active";
		this.save(w);
	}

	/**
	 * Where the branch last matched its base: the merge-base, which moves forward when the worktree is updated from
	 * main (so main's work never shows as the worktree's changes); the commit it was made from if that fails.
	 */
	async base(w: Worktree): Promise<string> {
		return (await g.git(w.repoPath, ["merge-base", w.record.branch, w.record.baseBranch]).catch(() => w.record.baseCommit)).trim() || w.record.baseCommit;
	}

	/** Files changed on the branch since it last matched its base, committed or not. */
	async changedFiles(w: Worktree): Promise<FileChange[]> {
		if (!this.hasCheckout(w)) return [];
		const dir = this.path(w);
		const kinds = { A: "added", D: "deleted" } as const;
		const files = new Map<string, FileChange["change"]>();
		// Read-only: no index refresh, so this never holds index.lock while a commit or merge runs there.
		for (const line of (await g.git(dir, ["--no-optional-locks", "diff", "--name-status", "--no-renames", await this.base(w)])).split("\n")) {
			const [code, path] = line.split("\t");
			if (path) files.set(path, kinds[code as "A" | "D"] ?? "modified");
		}
		for (const f of (await g.status(dir)).files) if (f.index === "?") files.set(f.path, "added");
		return [...files].map(([path, change]) => ({ path, change }));
	}

	/** The branch's changes since it was made, including uncommitted work in the checkout. */
	async diff(w: Worktree): Promise<string> {
		if (!this.hasCheckout(w) && !(await g.branchExists(w.repoPath, w.record.branch))) {
			// Merged, and its branch deleted: its changes are the merge commit's.
			const merge = (await g.git(w.repoPath, ["log", "--merges", "-1", "--format=%H", "--fixed-strings", `--grep=(worktree ${w.record.id})`, w.record.baseBranch]).catch(() => "")).trim();
			if (merge) return g.git(w.repoPath, ["diff", `${merge}^1`, merge]);
			return `(“${w.record.label}” was ${w.record.status} and its branch is gone: no changes to show)\n`;
		}
		const base = await this.base(w);
		if (!this.hasCheckout(w)) return g.git(w.repoPath, ["diff", base, w.record.branch]);
		const dir = this.path(w);
		let out = await g.git(dir, ["--no-optional-locks", "diff", base]);
		for (const f of (await g.status(dir)).files.filter((f) => f.index === "?")) {
			out += await g.git(dir, ["diff", "--no-index", "/dev/null", f.path]).catch((err: Error) => {
				// `git diff --no-index` exits 1 when the files differ, which is always here
				const m = /git diff: ([\s\S]*)/.exec(err.message);
				return m ? `${m[1]}\n` : "";
			});
		}
		return out;
	}

	/** How far the base has moved on (commits not yet in the branch), and the conflicts of an update in progress. */
	async updateStatus(w: Worktree): Promise<{ behind: number; conflicts: string[] | null }> {
		const behind = Number((await g.git(w.repoPath, ["rev-list", "--count", `${w.record.branch}..${w.record.baseBranch}`]).catch(() => "0")).trim()) || 0;
		if (!this.hasCheckout(w)) return { behind, conflicts: null };
		const dir = this.path(w);
		const merging = await g.git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
		if (!merging) return { behind, conflicts: null };
		const conflicts = (await g.git(dir, ["--no-optional-locks", "diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
		return { behind, conflicts };
	}

	/** Merges the base (latest main) into the branch, in the checkout; conflicts leave the merge in progress. */
	async update(w: Worktree): Promise<{ commits: number; conflicts: string[] }> {
		const { behind } = await this.updateStatus(w);
		if (!behind) return { commits: 0, conflicts: [] };
		const dir = this.path(w);
		try {
			await g.git(dir, ["merge", "--no-edit", "-q", "-m", `Update “${w.record.label}” from ${w.record.baseBranch}`, w.record.baseBranch]);
			return { commits: behind, conflicts: [] };
		} catch (err) {
			const { conflicts } = await this.updateStatus(w);
			if (conflicts?.length) return { commits: behind, conflicts };
			throw new Error(`Updating from ${w.record.baseBranch} failed: ${(err as Error).message}`);
		}
	}

	/** Gives up an update in progress: the checkout goes back to how it was before it. */
	async abortUpdate(w: Worktree): Promise<void> {
		await g.git(this.path(w), ["merge", "--abort"]);
	}

	/** Commits what's uncommitted in the checkout, then merges the branch into the base (no fast-forward). */
	async merge(w: Worktree, uncommittedMessage: string): Promise<void> {
		const r = w.record;
		if (this.hasCheckout(w)) await g.commitAll(this.path(w), uncommittedMessage);
		const current = await g.currentBranch(w.repoPath);
		if (current !== r.baseBranch) throw new Error(`${basename(w.repoPath)} is on ${current}; switch it to ${r.baseBranch} to merge`);
		try {
			await g.git(w.repoPath, ["merge", "--no-ff", "-q", "-m", `Merge "${r.label}" (worktree ${r.id})`, r.branch]);
		} catch (err) {
			await g.git(w.repoPath, ["merge", "--abort"]).catch(() => {});
			throw new Error(`Merge failed, nothing was changed: ${(err as Error).message}`);
		}
		await this.close(w, "merged");
		await this.deleteMergedBranch(w);
	}

	/** A merged worktree's branch is history main already has: delete it (`-d` refuses anything not merged). */
	private async deleteMergedBranch(w: Worktree): Promise<boolean> {
		const r = w.record;
		if (r.status !== "merged" || !(await g.branchExists(w.repoPath, r.branch))) return false;
		if (!(await g.isAncestor(w.repoPath, r.branch, r.baseBranch))) return false;
		return g.git(w.repoPath, ["branch", "-d", "-q", r.branch]).then(
			() => true,
			() => false,
		);
	}

	/** Deletes the branches of worktrees merged before branches were deleted on merge; returns how many. */
	async deleteMergedBranches(): Promise<number> {
		let n = 0;
		for (const w of this.all()) if (await this.deleteMergedBranch(w)) n++;
		return n;
	}

	/**
	 * Why an open worktree's checkout can't be removed to free space, or null if it can: nothing may exist only in the
	 * folder (unsaved or untracked files, an update in progress, edits in a submodule such as engine/). Ignored build
	 * output doesn't count: it's rebuilt. (Sessions and generation jobs are checked by the callers.)
	 */
	async unloadBlocker(w: Worktree): Promise<string | null> {
		if (!this.hasCheckout(w)) return "already unloaded";
		const dir = this.path(w);
		if (await g.git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false)) return "it's being updated from main";
		const own = (await g.git(dir, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])).trim();
		if (own) return `it has unsaved changes (${own.split("\n").length} file${own.split("\n").length > 1 ? "s" : ""})`;
		const subs = existsSync(join(dir, ".gitmodules"))
			? (await g.git(dir, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]).catch(() => "")).split("\n").map((l) => l.split(" ")[1]).filter(Boolean)
			: [];
		for (const s of subs) {
			if (!existsSync(join(dir, s))) continue;
			const inside = (await g.git(join(dir, s), ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]).catch(() => "?")).trim();
			if (inside) return `${s}/ has changes of its own`;
		}
		return null;
	}

	/** Removes an open worktree's checkout to free space; it stays open, and loading it again rebuilds it from the branch. */
	async unload(w: Worktree): Promise<void> {
		const blocker = await this.unloadBlocker(w);
		if (blocker) throw new Error(`Can't free “${w.record.label}”: ${blocker}`);
		// --force only because git refuses any worktree holding a submodule; unloadBlocker has just checked it all.
		await g.worktreeRemove(w.repoPath, this.path(w));
		w.record.checkout = "removed";
		this.save(w);
	}

	/** Removes the checkout and keeps the branch, so the work can be reopened. */
	async discard(w: Worktree): Promise<void> {
		await this.close(w, "discarded");
	}

	private async close(w: Worktree, status: "merged" | "discarded"): Promise<void> {
		if (this.hasCheckout(w)) await g.worktreeRemove(w.repoPath, this.path(w));
		w.record.status = status;
		w.record.checkout = "removed";
		this.save(w);
	}
}
