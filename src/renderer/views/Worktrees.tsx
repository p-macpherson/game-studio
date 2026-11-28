// The worktree panel in the sidebar, under the project: which checkout the studio's sections show and edit ("main",
// or a labelled worktree that isn't merged yet), how it stands against main (changes, Update, conflicts), a person's
// unsaved edits (undo, redo, Save), Merge, and Rename and Discard under ⋯. Every open worktree, with its size, sessions
// and reviews, is on the Worktrees page ("Manage worktrees…" in the selector's menu; WorktreeList.tsx). Until
// 2026-11-28 this was a bar along the bottom of the window.
import { useEffect, useRef, useState } from "react";
import type { WorktreeSummary } from "../../shared/types";
import { call } from "../api";
import type { Target } from "../../shared/types";
import { isOpenWorktree, useStudio } from "../store";
import { confirmDiscard, saveMessage } from "../workspace";
import { useShallow } from "zustand/react/shallow";

export const otherFiles = <T extends { path: string }>(files: T[]) => files.filter((f) => !f.path.startsWith(".studio/"));
/** The selector's groups: the game's worktrees, then the engine's and the studio's (shown when there are any). */
export const GROUPS: { target: Target; label: string }[] = [
	{ target: "project", label: "Game" },
	{ target: "engine", label: "Engine" },
	{ target: "studio", label: "Studio" },
];
export const megabytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

export function WorktreePicker({ collapsed = false }: { collapsed?: boolean }) {
	const { project, selected, worktrees, sessions, assetsVersion, selectWorktree, refreshWorktrees, showError, history, refreshHistory, undo, redo } = useStudio(
		useShallow((s) => ({
			project: s.project,
			selected: s.selected,
			worktrees: s.worktrees,
			sessions: s.sessions,
			assetsVersion: s.assetsVersion,
			selectWorktree: s.selectWorktree,
			refreshWorktrees: s.refreshWorktrees,
			showError: s.showError,
			history: s.history,
			refreshHistory: s.refreshHistory,
			undo: s.undo,
			redo: s.redo,
		})),
	);
	const [showSteps, setShowSteps] = useState(false);
	const [saving, setSaving] = useState<string | null>(null);
	// How far main has moved on, and an update's conflicts.
	const [status, setStatus] = useState<{ behind: number; conflicts: string[] | null } | null>(null);
	const [open, setOpen] = useState(false);
	const [more, setMore] = useState(false);
	// The menu is wider than the sidebar (which clips what overflows it), so it is placed against the window.
	const button = useRef<HTMLButtonElement>(null);
	const [at, setAt] = useState({ left: 0, top: 0 });
	const toggleMenu = () => {
		const r = button.current?.getBoundingClientRect();
		if (r) setAt({ left: r.left, top: r.bottom + 4 });
		setOpen(!open);
	};
	// The selector's menu closes on a click anywhere else, and on Escape.
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(".worktree-select, .worktree-menu") && setOpen(false);
		const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", key);
		};
	}, [open]);
	const [naming, setNaming] = useState<"new" | "rename" | null>(null);
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [changed, setChanged] = useState<string[]>([]);
	const list = worktrees.filter(isOpenWorktree);
	const current = list.find((w) => w.id === selected);
	// Engine and studio worktrees have no sections: no per-section counts or manual edits.
	const game = current?.target === "project";
	// Open worktrees with a session waiting for the person's review (the queue is on the Worktrees page).
	const toReview = new Set(sessions.filter((x) => x.reviewRequested && x.status !== "done" && list.some((w) => w.id === x.worktreeId)).map((x) => x.worktreeId)).size;
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
			useStudio.setState({ worktreeChanges: current.target === "project" ? otherFiles(f) : [] });
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
	const abortUpdate = () =>
		current && window.confirm(`Abort the update of “${current.label}” from main? Its files go back to before the update.`) && void act(() => call("worktrees.abortUpdate", current.id));
	const discard = () => {
		if (!current) return;
		void act(async () => {
			if (await confirmDiscard(current.id, current.label)) await call("worktrees.discard", current.id);
		});
	};
	const mine = history && current && game && history.worktree === current.id ? history : null;
	const steps = mine?.steps ?? [];
	const unsaved = mine?.unsaved ?? [];
	const done = steps.filter((s) => s.done);
	const undone = steps.filter((s) => !s.done);

	/** A worktree's row in the menu: select it. (Sizes, sessions and the rest are on the Worktrees page.) */
	const option = (w: WorktreeSummary) => (
		<button
			key={w.id}
			className={`ghost nav-item worktree-option ${w.id === current?.id ? "active" : ""}`}
			aria-current={w.id === current?.id}
			onClick={() => (selectWorktree(w.id), setOpen(false))}
			data-testid="worktree-option"
			data-target={w.target}
		>
			<span className="worktree-glyph" aria-hidden>
				⎇
			</span>
			<span className="grow ellipsis" title={w.label}>
				{w.label}
			</span>
			{working(w) && (
				<span className="worktree-working" title="An agent is working here">
					<span className="worktree-working-dot" aria-hidden />
					working
				</span>
			)}
			{w.checkout === "removed" && <span className="muted small">unloaded</span>}
			{w.id === current?.id && (
				<span className="worktree-check" aria-hidden>
					✓
				</span>
			)}
		</button>
	);


	const repo = current ? (current.target === "project" ? "Game" : current.target === "engine" ? "Engine" : "Studio") : null;
	const manage = () => (setOpen(false), useStudio.getState().setView("worktrees"));
	const menu = open && (
		<div className="card worktree-menu" style={at} data-testid="worktree-menu">
			<button className={`ghost nav-item worktree-option ${!current ? "active" : ""}`} aria-current={!current} onClick={() => (selectWorktree(null), setOpen(false))}>
				<span className="worktree-glyph" aria-hidden>
					◆
				</span>
				<span className="grow">main</span>
				<span className="muted small">in the game</span>
				{!current && (
					<span className="worktree-check" aria-hidden>
						✓
					</span>
				)}
			</button>
			{GROUPS.map(({ target, label }) => {
				const group = list.filter((w) => w.target === target);
				if (!group.length && target !== "project") return null;
				return (
					<div key={target} className="worktree-group" data-testid={`worktree-group-${target}`}>
						<div className="worktree-group-label" role="presentation">
							<span>{label}</span>
							{group.length > 0 && <span className="worktree-group-count">{group.length}</span>}
						</div>
						{group.map((w) => option(w))}
						{!group.length && <span className="muted small worktree-group-empty">No open worktrees</span>}
					</div>
				);
			})}
			<div className="worktree-menu-actions">
				<button className="ghost nav-item" onClick={() => (setOpen(false), setNaming("new"), setLabel(""))} data-testid="worktree-new">
					<span className="worktree-glyph" aria-hidden>
						+
					</span>
					New game worktree…
				</button>
				<button className="ghost nav-item" onClick={manage} data-testid="worktree-manage">
					<span className="worktree-glyph" aria-hidden>
						☰
					</span>
					<span className="grow">Manage worktrees…</span>
					{toReview > 0 && <span className="count review-count">● {toReview} to review</span>}
				</button>
			</div>
		</div>
	);
	const selector = (
		<div className="worktree-select">
			<button
				ref={button}
				className={`worktree-current ${open ? "open" : ""} ${collapsed ? "nav-item" : ""}`}
				title={`${current ? `${repo} worktree: ${current.label}` : "Main: what's in the game"}\nClick to switch worktree${toReview ? `\n${toReview} waiting for your review` : ""}`}
				aria-label="Worktree"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={toggleMenu}
				data-testid="worktree-current"
			>
				<span className="worktree-glyph">⎇</span>
				{!collapsed && <span className="ellipsis grow">{current?.label ?? "main"}</span>}
				{!collapsed && current && !game && (
					<span className={`badge target-${current.target}`} data-testid="worktree-repo">
						{current.target}
					</span>
				)}
				{current && working(current) && <span className="count working-dot" title="An agent is working here">●</span>}
				{toReview > 0 && (
					<span className="count review-count" title={`${toReview} waiting for your review: Manage worktrees…`} data-testid="review-count">
						{collapsed ? toReview : `● ${toReview}`}
					</span>
				)}
				{!collapsed && <span className="muted">▾</span>}
			</button>
		</div>
	);
	// The icon rail (a collapsed sidebar) has room for the selector only.
	if (collapsed)
		return (
			<div className="worktree-panel collapsed" data-testid="worktree-picker">
				{selector}
				{menu}
			</div>
		);
	return (
		<div className={`worktree-panel ${current ? "on" : ""}`} data-testid="worktree-picker">
			{selector}
			{menu}
			{naming && (
				<input
					className="worktree-naming"
					autoFocus
					value={label}
					placeholder={naming === "rename" ? "A new name for this worktree" : "What's the work? e.g. Dungeon level 5"}
					onChange={(e) => setLabel(e.target.value)}
					onKeyDown={(e) => (e.key === "Enter" ? submitLabel() : e.key === "Escape" && setNaming(null))}
					onBlur={() => !label.trim() && setNaming(null)}
					data-testid="worktree-label"
				/>
			)}
			{current && (
				<div className="wt-line">
					<button className="link muted small worktree-fact" title={`Read what this worktree changed${changed.length ? `:\n${changed.join("\n")}` : ""}`} onClick={() => useStudio.getState().openChanges(current.id)} data-testid="worktree-changes-link">
						{changed.length} change{changed.length === 1 ? "" : "s"}
					</button>
					<span className="grow" />
					<button className={`small icon ${more ? "on" : ""}`} aria-label="More worktree actions" aria-expanded={more} title="Rename or discard this worktree" onClick={() => setMore(!more)} data-testid="worktree-more">
						⋯
					</button>
				</div>
			)}
			{current && more && (
				<div className="wt-line wt-more">
					<button className="small" disabled={busy} onClick={() => (setMore(false), setNaming("rename"), setLabel(current.label))} data-testid="worktree-rename">
						Rename…
					</button>
					<button
						className="small danger-text"
						disabled={busy || working(current)}
						title={working(current) ? "Wait for the agents to finish" : "Throw away this worktree and everything it changed"}
						onClick={() => (setMore(false), discard())}
						data-testid="worktree-discard"
					>
						Discard…
					</button>
				</div>
			)}
			{current && status?.conflicts && (
				<div className="worktree-status conflict" data-testid="worktree-conflicts">
					<span title={`Updating from main, these files conflict:\n${status.conflicts.join("\n")}`}>
						⚠ {status.conflicts.length} conflict{status.conflicts.length === 1 ? "" : "s"} with main
					</span>
					<div className="wt-line">
						<button className="small" disabled={busy || working(current)} onClick={resolve} title="Start the Conflict Resolver, briefed with this worktree's sessions" data-testid="worktree-resolve">
							Resolve
						</button>
						<button className="small" disabled={busy || working(current)} onClick={abortUpdate} title="Put the files back to before the update" data-testid="worktree-abort-update">
							Abort update
						</button>
					</div>
				</div>
			)}
			{current && !status?.conflicts && (status?.behind ?? 0) > 0 && (
				<div className="wt-line worktree-status" data-testid="worktree-behind">
					<span className="muted small grow">
						main has {status!.behind} new commit{status!.behind === 1 ? "" : "s"}
					</span>
					<button className="small" disabled={busy || working(current)} onClick={update} title={working(current) ? "Wait for the agents to finish" : "Merge latest main into this worktree"} data-testid="worktree-update">
						Update
					</button>
				</div>
			)}
			{current && !game && (
				<span className="muted small worktree-fact" data-testid="worktree-repo-note" title={`${repo === "Engine" ? "An engine" : "A studio"} worktree: the sections show the game's main.`}>
					The sections show the game's main
				</span>
			)}
			{current && (steps.length > 0 || unsaved.length > 0) && (
				<div className="wt-line worktree-unsaved" data-testid="worktree-unsaved">
					<button className="small icon" disabled={!done.length} onClick={() => void undo()} title={done.length ? `Undo: ${done.at(-1)!.label} (Ctrl+Z)` : "Nothing to undo"} data-testid="undo">
						↶
					</button>
					<button className="small icon" disabled={!undone.length} onClick={() => void redo()} title={undone.length ? `Redo: ${undone[0].label} (Ctrl+Shift+Z)` : "Nothing to redo"} data-testid="redo">
						↷
					</button>
					<button
						className={`ghost small unsaved-count grow ${unsaved.length ? "" : "saved"}`}
						onClick={() => setShowSteps(!showSteps)}
						title="Your edits in the sections that aren't saved (committed) yet: click for the list"
						data-testid="unsaved-count"
					>
						{unsaved.length ? `${done.length || unsaved.length} unsaved` : "All saved"} {showSteps ? "▴" : "▾"}
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
				<div className="history-list" data-testid="history-list">
					{[...steps].reverse().map((s, i) => (
						<div key={i} className={`history-step ellipsis ${s.done ? "" : "undone"}`} title={`${s.label}\n${s.files.join("\n")}`}>
							{s.label}
						</div>
					))}
					{!steps.length &&
						unsaved.map((f) => (
							<div key={f} className="history-step ellipsis muted" title={f}>
								{f}
							</div>
						))}
					{unsaved.length > 0 && (
						<button
							className="small danger"
							disabled={busy || working(current)}
							onClick={() => window.confirm(`Revert every unsaved change in “${current.label}” to its last save? This can't be undone.`) && void act(() => call("worktrees.revert", current.id))}
							data-testid="worktree-revert"
						>
							Revert all
						</button>
					)}
				</div>
			)}
			{current && (
				<button className="small primary worktree-merge" disabled={busy} onClick={merge} data-testid="worktree-merge" title="Merge everything this worktree changed into main (shows what it changed and its sessions first)">
					Merge into main…
				</button>
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
		</div>
	);
}
