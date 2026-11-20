// The worktree selector in the sidebar: which checkout the studio's sections show and edit ("main", or a
// labelled worktree that isn't merged yet), and the worktree's Merge, Rename and Discard.
import { useEffect, useState } from "react";
import type { WorktreeSummary } from "../../shared/types";
import { call } from "../api";
import { isOpenProjectWorktree, useStudio } from "../store";

const otherFiles = <T extends { path: string }>(files: T[]) => files.filter((f) => !f.path.startsWith(".studio/"));

export function WorktreePicker() {
	const { project, worktree, worktrees, sessions, assetsVersion, selectWorktree, refreshWorktrees, showError } = useStudio();
	const [open, setOpen] = useState(false);
	const [naming, setNaming] = useState<"new" | "rename" | null>(null);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [changed, setChanged] = useState<string[]>([]);
	const list = worktrees.filter(isOpenProjectWorktree);
	const current = list.find((w) => w.id === worktree);
	const working = (w: WorktreeSummary) => sessions.some((s) => s.worktreeId === w.id && (s.status === "in_progress" || s.status === "starting"));

	useEffect(() => {
		if (!current) {
			setChanged([]);
			useStudio.setState({ worktreeChanges: [] });
			return;
		}
		let live = true;
		call("worktrees.changedFiles", current.id).then((f) => {
			if (!live) return;
			setChanged(otherFiles(f).map((x) => x.path));
			useStudio.setState({ worktreeChanges: otherFiles(f) });
		}, () => {});
		return () => {
			live = false;
		};
	}, [current?.id, current?.updatedAt, assetsVersion]);

	if (!project) return null;

	const act = async (what: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await what();
			await refreshWorktrees();
			useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};
	const submitLabel = () => {
		const text = label.trim();
		if (!text) return;
		const mode = naming;
		setNaming(null);
		setLabel("");
		void act(async () => {
			if (mode === "rename" && current) await call("worktrees.rename", current.id, text);
			else {
				const w = await call("worktrees.create", text);
				await refreshWorktrees();
				selectWorktree(w.id);
			}
		});
	};
	const merge = () => {
		if (!current) return;
		const files = changed.length ? `\n\n${changed.length} changed file${changed.length > 1 ? "s" : ""}:\n${changed.slice(0, 15).join("\n")}${changed.length > 15 ? "\n…" : ""}` : "\n\nIt has no changes.";
		if (window.confirm(`Merge worktree “${current.label}” into the game?${files}`)) void act(() => call("worktrees.merge", current.id));
	};
	const discard = () => {
		if (current && window.confirm(`Discard worktree “${current.label}”? Its checkout is removed; the branch is kept, so its sessions can be resumed.`)) {
			void act(() => call("worktrees.discard", current.id));
		}
	};

	return (
		<div className="worktree-picker" data-testid="worktree-picker">
			<button
				className="nav-item worktree-current"
				title={current ? `Worktree: ${current.label}` : "Main: what's in the game"}
				aria-label="Worktree"
				onClick={() => setOpen(!open)}
				data-testid="worktree-current"
			>
				<span className="nav-icon">⎇</span>
				<span className="nav-label grow ellipsis">{current?.label ?? "main"}</span>
				{current && working(current) && <span className="count">●</span>}
				<span className="nav-label muted">▾</span>
			</button>
			{current && (
				<div className="worktree-actions row nav-label">
					<span className="muted small grow ellipsis" title={changed.join("\n")}>
						{changed.length} change{changed.length === 1 ? "" : "s"}
					</span>
					<button className="small" disabled={busy || working(current)} onClick={merge} data-testid="worktree-merge" title="Merge everything this worktree changed into main">
						Merge
					</button>
					<button className="small icon" disabled={busy} onClick={() => (setNaming("rename"), setLabel(current.label))} title="Rename">
						✎
					</button>
					<button className="small icon" disabled={busy || working(current)} onClick={discard} title="Discard this worktree">
						✕
					</button>
				</div>
			)}
			{naming && (
				<div className="worktree-naming">
					<input
						autoFocus
						value={label}
						placeholder="What's the work? e.g. Dungeon level 5 re-texturing"
						onChange={(e) => setLabel(e.target.value)}
						onKeyDown={(e) => (e.key === "Enter" ? submitLabel() : e.key === "Escape" && setNaming(null))}
						onBlur={() => !label.trim() && setNaming(null)}
						data-testid="worktree-label"
					/>
				</div>
			)}
			{open && (
				<div className="card worktree-menu" data-testid="worktree-menu" onMouseLeave={() => setOpen(false)}>
					<button className={`ghost nav-item ${!current ? "active" : ""}`} onClick={() => (selectWorktree(null), setOpen(false))}>
						<span className="grow">main</span>
						<span className="muted small">in the game</span>
					</button>
					{list.map((w) => (
						<button key={w.id} className={`ghost nav-item ${w.id === current?.id ? "active" : ""}`} onClick={() => (selectWorktree(w.id), setOpen(false))} data-testid="worktree-option">
							<span className="grow ellipsis" title={w.label}>
								{w.label}
							</span>
							{working(w) && <span className="count">●</span>}
							<span className="muted small">
								{w.sessionIds.length} session{w.sessionIds.length === 1 ? "" : "s"}
							</span>
						</button>
					))}
					<button className="ghost nav-item" onClick={() => (setOpen(false), setNaming("new"), setLabel(""))} data-testid="worktree-new">
						+ New worktree…
					</button>
				</div>
			)}
		</div>
	);
}
