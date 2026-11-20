// The worktree selector in the sidebar: which checkout the studio's sections show and edit ("main", or a
// labelled worktree that isn't merged yet), and the worktree's Merge, Rename and Discard.
import { useEffect, useState } from "react";
import type { WorktreeSummary } from "../../shared/types";
import { call } from "../api";
import { isOpenProjectWorktree, useStudio } from "../store";
import { confirmDiscard, confirmMerge, saveMessage } from "../workspace";

const otherFiles = <T extends { path: string }>(files: T[]) => files.filter((f) => !f.path.startsWith(".studio/"));

export function WorktreePicker() {
	const { project, worktree, worktrees, sessions, assetsVersion, selectWorktree, refreshWorktrees, showError, history, refreshHistory, undo, redo } = useStudio();
	const [showSteps, setShowSteps] = useState(false);
	const [saving, setSaving] = useState<string | null>(null);
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
		void refreshHistory();
		call("worktrees.changedFiles", current.id).then((f) => {
			if (!live) return;
			setChanged(otherFiles(f).map((x) => x.path));
			useStudio.setState({ worktreeChanges: otherFiles(f) });
		}, () => {});
		return () => {
			live = false;
		};
	}, [current?.id, current?.updatedAt, assetsVersion, refreshHistory]);

	if (!project) return null;

	const act = async (what: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await what();
			await refreshWorktrees();
			await refreshHistory();
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
		void act(async () => {
			if (await confirmMerge(current.id, current.label, files)) await call("worktrees.merge", current.id);
		});
	};
	const discard = () => {
		if (!current) return;
		void act(async () => {
			if (await confirmDiscard(current.id, current.label)) await call("worktrees.discard", current.id);
		});
	};
	const mine = history && current && history.worktree === current.id ? history : null;
	const steps = mine?.steps ?? [];
	const unsaved = mine?.unsaved ?? [];
	const done = steps.filter((s) => s.done);
	const undone = steps.filter((s) => !s.done);

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
			{current && (steps.length > 0 || unsaved.length > 0) && (
				<div className="worktree-unsaved row nav-label" data-testid="worktree-unsaved">
					<button
						className="ghost small grow ellipsis unsaved-count"
						onClick={() => setShowSteps(!showSteps)}
						title="Your edits in the sections that aren't saved (committed) yet: click for the list"
						data-testid="unsaved-count"
					>
						{unsaved.length ? `${done.length || unsaved.length} unsaved` : "All saved"}
					</button>
					<button className="small icon" disabled={!done.length} onClick={() => void undo()} title={done.length ? `Undo: ${done.at(-1)!.label} (Ctrl+Z)` : "Nothing to undo"} data-testid="undo">
						↶
					</button>
					<button className="small icon" disabled={!undone.length} onClick={() => void redo()} title={undone.length ? `Redo: ${undone[0].label} (Ctrl+Shift+Z)` : "Nothing to redo"} data-testid="redo">
						↷
					</button>
					<button
						className="small"
						disabled={busy || !unsaved.length || working(current)}
						onClick={() => setSaving(saveMessage(done.map((s) => s.label), unsaved))}
						title={working(current) ? "Wait for the agent to finish" : "Commit your unsaved edits in this worktree"}
						data-testid="worktree-save"
					>
						Save
					</button>
				</div>
			)}
			{current && showSteps && (steps.length > 0 || unsaved.length > 0) && (
				<div className="card history-list nav-label" data-testid="history-list">
					{[...steps].reverse().map((s, i) => (
						<div key={i} className={`history-step ellipsis ${s.done ? "" : "undone"}`} title={`${s.label}\n${s.files.join("\n")}`}>
							{s.label}
						</div>
					))}
					{!steps.length && unsaved.map((f) => (
						<div key={f} className="history-step ellipsis muted" title={f}>
							{f}
						</div>
					))}
					{unsaved.length > 0 && (
						<button
							className="small danger"
							disabled={busy || working(current)}
							onClick={() =>
								window.confirm(`Revert every unsaved change in “${current.label}” to its last save? This can't be undone.`) &&
								void act(() => call("worktrees.revert", current.id))
							}
							data-testid="worktree-revert"
						>
							Revert all
						</button>
					)}
				</div>
			)}
			{current && saving !== null && (
				<div className="modal-backdrop" onClick={() => setSaving(null)}>
					<div className="modal col" style={{ width: 520 }} onClick={(e) => e.stopPropagation()} data-testid="save-dialog">
						<h3>Save “{current.label}”</h3>
						<span className="muted small">Commits your unsaved edits in this worktree. They reach the game when it's merged.</span>
						<textarea rows={8} value={saving} onChange={(e) => setSaving(e.target.value)} data-testid="save-message" />
						<div className="row" style={{ justifyContent: "flex-end" }}>
							<button onClick={() => setSaving(null)}>Cancel</button>
							<button
								className="primary"
								disabled={!saving.trim()}
								onClick={() => {
									const message = saving;
									setSaving(null);
									void act(() => call("worktrees.save", current.id, message));
								}}
								data-testid="save-ok"
							>
								Save
							</button>
						</div>
					</div>
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
