// The worktree selector in the sidebar: which checkout the studio's sections show and edit ("main", or a
// labelled worktree that isn't merged yet), and the worktree's Merge, Rename and Discard.
import { useEffect, useState } from "react";
import type { WorktreeSummary } from "../../shared/types";
import { call } from "../api";
import { isOpenProjectWorktree, useStudio } from "../store";
import { confirmDiscard, saveMessage } from "../workspace";

const otherFiles = <T extends { path: string }>(files: T[]) => files.filter((f) => !f.path.startsWith(".studio/"));
const megabytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

export function WorktreePicker() {
	const { project, worktree, worktrees, sessions, assetsVersion, selectWorktree, refreshWorktrees, showError, history, refreshHistory, undo, redo } = useStudio();
	const [showSteps, setShowSteps] = useState(false);
	const [saving, setSaving] = useState<string | null>(null);
	// How far main has moved on, and an update's conflicts.
	const [status, setStatus] = useState<{ behind: number; conflicts: string[] | null } | null>(null);
	const [open, setOpen] = useState(false);
	// The menu's disk use per worktree, and why each can't be freed (fetched when it opens).
	const [space, setSpace] = useState<{ id: string; bytes: number | null; blocker: string | null }[] | null>(null);
	useEffect(() => {
		if (!open) return;
		let live = true;
		setSpace(null); // not the last opening's numbers (worktrees come and go)
		call("worktrees.space").then((s) => live && setSpace(s), () => {});
		return () => {
			live = false;
		};
	}, [open, worktrees]);
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
		call("worktrees.status", current.id).then((s) => live && setStatus(s), () => live && setStatus(null));
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
	const merge = () => current && useStudio.getState().openMerge(current.id);
	const resolve = () =>
		current &&
		void act(async () => {
			const s = await call("worktrees.resolveConflicts", current.id);
			useStudio.getState().selectSession(s.id);
		});
	const update = () => {
		if (!current) return;
		void act(async () => {
			if (unsaved.length) {
				if (!window.confirm(`“${current.label}” has unsaved edits. Save them, then update from main?`)) return;
				await call("worktrees.save", current.id, saveMessage(done.map((s) => s.label), unsaved));
			}
			const r = await call("worktrees.update", current.id);
			if (!r.conflicts.length) return useStudio.getState().notify(`Updated “${current.label}” from main (${r.commits} commit${r.commits === 1 ? "" : "s"})`);
			const list = r.conflicts.slice(0, 12).map((f) => `- ${f}`).join("\n");
			if (window.confirm(`${r.conflicts.length} file${r.conflicts.length > 1 ? "s" : ""} conflict with main:\n${list}\n\nStart the Conflict Resolver to merge them? (Cancel leaves the update open: resolve or abort it from the sidebar.)`)) {
				const s = await call("worktrees.resolveConflicts", current.id);
				useStudio.getState().selectSession(s.id);
			}
		});
	};
	const unload = (w: WorktreeSummary, bytes: number | null) => {
		if (!window.confirm(`Free up space by removing the folder of “${w.label}”${bytes ? ` (${megabytes(bytes)})` : ""}?\n\nNothing is lost: its work is committed on its branch, and its sessions stay. Selecting it (or resuming one of its sessions) brings the folder back.`)) return;
		void act(async () => {
			await call("worktrees.unload", w.id);
			setSpace(await call("worktrees.space"));
			useStudio.getState().notify(`Freed “${w.label}”`);
		});
	};
	const abortUpdate = () =>
		current && window.confirm(`Abort the update of “${current.label}” from main? Its files go back to before the update.`) && void act(() => call("worktrees.abortUpdate", current.id));
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
					<button className="small" disabled={busy} onClick={merge} data-testid="worktree-merge" title="Merge everything this worktree changed into main (shows what it changed and its sessions first)">
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
			{current && status?.conflicts && (
				<div className="worktree-status conflict row nav-label" data-testid="worktree-conflicts">
					<span className="grow ellipsis" title={`Updating from main, these files conflict:\n${status.conflicts.join("\n")}`}>
						⚠ {status.conflicts.length} conflict{status.conflicts.length === 1 ? "" : "s"}
					</span>
					<button className="small" disabled={busy || working(current)} onClick={resolve} title="Start the Conflict Resolver, briefed with this worktree's sessions" data-testid="worktree-resolve">
						Resolve
					</button>
					<button className="small icon" disabled={busy || working(current)} onClick={abortUpdate} title="Abort the update" data-testid="worktree-abort-update">
						✕
					</button>
				</div>
			)}
			{current && !status?.conflicts && (status?.behind ?? 0) > 0 && (
				<div className="worktree-status row nav-label" data-testid="worktree-behind">
					<span className="grow ellipsis muted small">
						main has {status!.behind} new commit{status!.behind === 1 ? "" : "s"}
					</span>
					<button className="small" disabled={busy || working(current)} onClick={update} title={working(current) ? "Wait for the agents to finish" : "Merge latest main into this worktree"} data-testid="worktree-update">
						Update
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
					{list.map((w) => {
						const sp = space?.find((x) => x.id === w.id);
						const blocker = w.id === current?.id ? "it's selected: switch to another worktree first" : sp?.blocker;
						return (
							<div key={w.id} className="row worktree-option-row">
								<button className={`ghost nav-item grow ${w.id === current?.id ? "active" : ""}`} onClick={() => (selectWorktree(w.id), setOpen(false))} data-testid="worktree-option">
									<span className="grow ellipsis" title={w.label}>
										{w.label}
									</span>
									{working(w) && <span className="count">●</span>}
									<span className="muted small" data-testid="worktree-size">
										{w.checkout === "removed" ? "unloaded" : sp?.bytes ? megabytes(sp.bytes) : ""} · {w.sessionIds.length} session{w.sessionIds.length === 1 ? "" : "s"}
									</span>
								</button>
								{w.checkout !== "removed" && (
									<button
										className="small icon"
										disabled={busy || !sp || !!blocker}
										title={blocker ? `Can't free its space: ${blocker}` : `Free up space: remove its folder${sp?.bytes ? ` (${megabytes(sp.bytes)})` : ""}. Its work is on its branch; selecting it brings the folder back.`}
										onClick={() => unload(w, sp?.bytes ?? null)}
										data-testid="worktree-unload"
									>
										⏏
									</button>
								)}
							</div>
						);
					})}
					{!!space?.length && (
						<span className="muted small worktree-space-total" data-testid="worktree-space-total">
							Open worktrees use {megabytes(space.reduce((n, s) => n + (s.bytes ?? 0), 0))} on disk
						</span>
					)}
					<button className="ghost nav-item" onClick={() => (setOpen(false), setNaming("new"), setLabel(""))} data-testid="worktree-new">
						+ New worktree…
					</button>
				</div>
			)}
		</div>
	);
}
