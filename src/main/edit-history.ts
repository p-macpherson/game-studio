// Undo/redo for a person's manual edits in a worktree (Settings-free, in memory: one timeline per worktree). Each
// edit is a named step holding the before and after contents of the files it changed (whole-file snapshots, kept in a
// content-addressed folder: a scene edit, a re-render that replaced OGGs and a move that rewrote references all undo
// the same way). Undo puts the "before" side back only if every file still has the step's "after" content, so a
// change an agent made since is never overwritten. Saving (a commit) is the worktree's; it clears the timeline.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HistoryStep } from "../shared/history";
import { safeJoin } from "./assets";

/** Files a step may change: a file or a folder (everything under it, or only what `only` matches). */
export interface Scope {
	path: string;
	only?: RegExp;
}
interface FileChange {
	path: string;
	/** Content hashes; null when the file doesn't exist. */
	before: string | null;
	after: string | null;
}
interface Step {
	label: string;
	at: string;
	files: FileChange[];
}

export class EditHistory {
	private readonly timelines = new Map<string, { steps: Step[]; cursor: number }>();
	/** path → what its content hashed to at a given size and time, so unchanged files aren't read again. */
	private readonly hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

	constructor(private readonly store: string) {
		rmSync(store, { recursive: true, force: true });
		mkdirSync(store, { recursive: true });
	}

	/** Runs `run`, a manual edit in the worktree checked out at `root`, and records what it changed as one step. */
	async record<T>(id: string, root: string, label: string, scopes: Scope[], run: () => Promise<T>): Promise<T> {
		const before = this.snapshot(root, scopes);
		const result = await run();
		const after = this.snapshot(root, scopes);
		const files = [...new Set([...before.keys(), ...after.keys()])]
			.filter((p) => (before.get(p) ?? null) !== (after.get(p) ?? null))
			.sort()
			.map((path) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
		if (files.length) {
			const t = this.timeline(id);
			t.steps.splice(t.cursor, Infinity, { label, at: new Date().toISOString(), files });
			t.cursor = t.steps.length;
		}
		return result;
	}

	/** Undoes the latest done step; returns its name. */
	undo(id: string, root: string): string {
		const t = this.timeline(id);
		const step = t.steps[t.cursor - 1];
		if (!step) throw new Error("Nothing to undo");
		this.apply(root, step, "after", "before", "undo");
		t.cursor--;
		return step.label;
	}

	/** Redoes the latest undone step; returns its name. */
	redo(id: string, root: string): string {
		const t = this.timeline(id);
		const step = t.steps[t.cursor];
		if (!step) throw new Error("Nothing to redo");
		this.apply(root, step, "before", "after", "redo");
		t.cursor++;
		return step.label;
	}

	/** The worktree's steps, oldest first. */
	steps(id: string): HistoryStep[] {
		const t = this.timeline(id);
		return t.steps.map((s, i) => ({ label: s.label, at: s.at, done: i < t.cursor, files: s.files.map((f) => f.path) }));
	}

	/** Forgets a worktree's timeline (after a save, a revert, a merge or a discard). */
	clear(id: string): void {
		this.timelines.delete(id);
	}

	private timeline(id: string) {
		let t = this.timelines.get(id);
		if (!t) this.timelines.set(id, (t = { steps: [], cursor: 0 }));
		return t;
	}

	/** Puts every file of `step` from its `from` side to its `to` side, if all of them still are as `from` says. */
	private apply(root: string, step: Step, from: "before" | "after", to: "before" | "after", what: string): void {
		const moved = step.files.filter((f) => this.hash(safeJoin(root, f.path)) !== f[from]);
		if (moved.length) {
			throw new Error(`Can't ${what} "${step.label}": ${moved.map((f) => f.path).join(", ")} changed since (an agent may have edited ${moved.length > 1 ? "them" : "it"})`);
		}
		for (const f of step.files) {
			const full = safeJoin(root, f.path);
			const content = f[to];
			if (content === null) rmSync(full, { force: true });
			else {
				mkdirSync(dirname(full), { recursive: true });
				copyFileSync(join(this.store, content), full);
			}
			this.hashes.delete(full);
		}
	}

	private snapshot(root: string, scopes: Scope[]): Map<string, string> {
		const out = new Map<string, string>();
		for (const scope of scopes) {
			const full = safeJoin(root, scope.path);
			if (!existsSync(full)) continue;
			const files = statSync(full).isDirectory() ? walk(full).map((f) => `${scope.path}/${f}`) : [scope.path];
			for (const path of files) {
				if (scope.only && !scope.only.test(path)) continue;
				const hash = this.hash(safeJoin(root, path), true);
				if (hash) out.set(path, hash);
			}
		}
		return out;
	}

	/** A file's content hash (null if it doesn't exist); with `keep`, its content is stored for undo. */
	private hash(full: string, keep = false): string | null {
		if (!existsSync(full)) return null;
		const st = statSync(full);
		const known = this.hashes.get(full);
		if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && (!keep || existsSync(join(this.store, known.hash)))) return known.hash;
		const hash = createHash("sha1").update(readFileSync(full)).digest("hex");
		if (keep && !existsSync(join(this.store, hash))) copyFileSync(full, join(this.store, hash));
		this.hashes.set(full, { size: st.size, mtimeMs: st.mtimeMs, hash });
		return hash;
	}
}

function walk(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.name === ".git" ? [] : e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
	);
}
