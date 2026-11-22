// What a worktree changed, to read before merging it: the files by section (Scenes, Code…), each marked new,
// changed, moved or removed with its lines added and removed; and the picked file's changes as numbered lines, the
// removed ones in red and the added ones in green. Opened from the Worktrees page and the worktree bar.
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type DiffFile, parseDiff } from "../../shared/diff";
import { call } from "../api";
import { useStudio } from "../store";

const LABEL: Record<DiffFile["change"], string> = { added: "New", modified: "Changed", deleted: "Removed", renamed: "Moved" };
const TONE: Record<DiffFile["change"], string> = { added: "added", modified: "modified", deleted: "deleted", renamed: "modified" };
const bytes = (n: number) => (n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Lines of one file drawn at first; the rest on request (a generated file can run to tens of thousands). */
const LINE_LIMIT = 1500;

export function WorktreeChanges({ worktreeId }: { worktreeId: string }) {
	const { worktree, modules, assetsVersion, openChanges, showAsset } = useStudio(
		useShallow((s) => ({
			worktree: s.worktrees.find((w) => w.id === worktreeId),
			modules: s.modules,
			assetsVersion: s.assetsVersion,
			openChanges: s.openChanges,
			showAsset: s.showAsset,
		})),
	);
	const [files, setFiles] = useState<DiffFile[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [showRecords, setShowRecords] = useState(false);
	const [whole, setWhole] = useState(false);
	useEffect(() => {
		let live = true;
		call("worktrees.diff", worktreeId).then(
			(d) => live && (setFiles(parseDiff(d)), setError(null)),
			(e) => live && setError((e as Error).message),
		);
		return () => {
			live = false;
		};
	}, [worktreeId, worktree?.updatedAt, assetsVersion]);

	// The studio's own records (.studio/: session and worktree files) aren't the game's changes: off unless asked for.
	const records = files?.filter((f) => f.path.startsWith(".studio/")) ?? [];
	const shown = useMemo(() => (files ?? []).filter((f) => showRecords || !f.path.startsWith(".studio/")), [files, showRecords]);
	const groups = useMemo(() => {
		const game = worktree?.target === "project";
		const of = (path: string) => (game ? modules.find((m) => m.roots.some((r) => path.startsWith(`${r}/`))) : undefined);
		const out = (game ? modules : []).map((m) => ({ name: m.name, icon: m.icon, files: shown.filter((f) => of(f.path)?.id === m.id) }));
		out.push({ name: game ? "Other files" : "Files", icon: "📄", files: shown.filter((f) => !of(f.path)) });
		return out.filter((g) => g.files.length);
	}, [shown, modules, worktree?.target]);
	const current = shown.find((f) => f.path === picked) ?? groups[0]?.files[0];
	useEffect(() => setWhole(false), [current?.path]);

	const total = (k: DiffFile["change"]) => shown.filter((f) => f.change === k).length;
	const lines = shown.reduce((n, f) => ({ added: n.added + f.added, removed: n.removed + f.removed }), { added: 0, removed: 0 });
	const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);
	const dir = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

	let budget = whole ? Infinity : LINE_LIMIT;
	const cut = !!current && !whole && current.hunks.reduce((n, h) => n + h.lines.length, 0) > LINE_LIMIT;
	return (
		<div className="changes" data-testid="worktree-changes">
			<div className="changes-head">
				<button onClick={() => openChanges(null)} data-testid="changes-back">
					← Worktrees
				</button>
				<div className="col grow" style={{ gap: 2, minWidth: 0 }}>
					<h2 className="ellipsis">Changes in “{worktree?.label ?? worktreeId}”</h2>
					<span className="muted small" data-testid="changes-summary">
						{files === null
							? "Loading…"
							: shown.length === 0
								? "Nothing changed against main."
								: [
										plural(shown.length, "file"),
										[total("added") && `${total("added")} new`, total("modified") && `${total("modified")} changed`, total("renamed") && `${total("renamed")} moved`, total("deleted") && `${total("deleted")} removed`].filter(Boolean).join(", "),
										`${lines.added} line${lines.added === 1 ? "" : "s"} added, ${lines.removed} removed`,
									].join(" · ")}
					</span>
				</div>
				{records.length > 0 && (
					<label className="row small muted" style={{ gap: 6 }} title="Session and worktree records under .studio/, which the studio writes itself">
						<input type="checkbox" checked={showRecords} onChange={() => setShowRecords(!showRecords)} />
						Studio records ({records.length})
					</label>
				)}
				{worktree?.status === "active" && (
					<button className="primary" onClick={() => useStudio.getState().openMerge(worktreeId)}>
						Merge…
					</button>
				)}
			</div>
			{error && <div className="msg error" style={{ padding: 16 }}>Could not load the changes: {error}</div>}
			<div className="changes-body">
				<div className="changes-files" data-testid="changes-files">
					{groups.map((g) => (
						<div key={g.name} className="col" style={{ gap: 1 }}>
							<h3 className="changes-group">
								{g.icon} {g.name} <span className="muted">{g.files.length}</span>
							</h3>
							{g.files.map((f) => (
								<button key={f.path} className={`changes-file ${f.path === current?.path ? "selected" : ""}`} onClick={() => setPicked(f.path)} title={f.from ? `${f.from} → ${f.path}` : f.path} data-testid="changes-file">
									<span className={`change-label change-${TONE[f.change]}`}>{LABEL[f.change]}</span>
									<span className="grow ellipsis">
										{name(f.path)} <span className="muted small">{dir(f.path)}</span>
									</span>
									{f.binary ? (
										<span className="muted small">{f.size != null ? bytes(f.size) : "binary"}</span>
									) : (
										<span className="small changes-counts">
											{f.added > 0 && <span className="change-added">+{f.added}</span>}
											{f.removed > 0 && <span className="change-deleted">−{f.removed}</span>}
										</span>
									)}
								</button>
							))}
						</div>
					))}
				</div>
				<div className="changes-file-view" data-testid="changes-view">
					{!current && files !== null && <div className="empty">Nothing changed against main.</div>}
					{current && (
						<>
							<div className="row changes-file-head">
								<span className={`change-label change-${TONE[current.change]}`}>{LABEL[current.change]}</span>
								<code className="grow ellipsis">{current.from ? `${current.from} → ${current.path}` : current.path}</code>
								{worktree?.target === "project" && current.change !== "deleted" && (
									<button className="small" onClick={() => showAsset({ path: current.path, checkout: worktreeId })} title="Show this file in its section, in this worktree">
										Open in its section
									</button>
								)}
							</div>
							{current.binary && <div className="empty">Not a text file (an image, a model, audio…): it was {LABEL[current.change].toLowerCase()}, with no lines to compare{current.size != null ? ` (${bytes(current.size)} now)` : ""}.</div>}
							{!current.binary && current.hunks.length === 0 && <div className="empty">{current.change === "renamed" ? "Moved, with its contents unchanged." : "No line changes (an empty file, or only its permissions changed)."}</div>}
							{current.hunks.map((h, i) => {
								if (budget <= 0) return null;
								const part = h.lines.slice(0, budget);
								budget -= part.length;
								return (
									<div key={i} className="hunk">
										<div className="hunk-head">
											{i > 0 || (part[0]?.old ?? part[0]?.new ?? 1) > 1 ? "⋯ " : ""}
											{h.context || (i === 0 && (part[0]?.old ?? part[0]?.new ?? 1) <= 1 ? "Start of the file" : `From line ${part[0]?.new ?? part[0]?.old ?? ""}`)}
										</div>
										{part.map((l, j) => (
											<div key={j} className={`diff-line ${l.kind}`}>
												<span className="line-no">{l.old ?? ""}</span>
												<span className="line-no">{l.new ?? ""}</span>
												<span className="line-mark">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
												<span className="line-text">{l.text || " "}</span>
											</div>
										))}
									</div>
								);
							})}
							{cut && (
								<button className="changes-more" onClick={() => setWhole(true)}>
									Show all {current.added + current.removed} changed lines
								</button>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
