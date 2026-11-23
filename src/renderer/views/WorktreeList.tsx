// The Worktrees page: every open worktree (the game's, the engine's and the studio's) with how it stands against
// main, its sessions and its disk use, and what can be done with each without selecting it first: switch to it, merge,
// update, rename, free up its space, discard. The worktree bar (Worktrees.tsx) is the quick view of the selected one.
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { WorktreeSummary } from "../../shared/types";
import { call } from "../api";
import { isOpenWorktree, useStudio } from "../store";
import { confirmDiscard, unsavedOf } from "../workspace";
import { GROUPS, megabytes, otherFiles } from "./Worktrees";
import { WorktreeChanges } from "./WorktreeChanges";
import { Review } from "./Review";

interface Facts {
	changes: number;
	behind: number;
	conflicts: string[] | null;
}
type Space = { id: string; bytes: number | null; blocker: string | null };
/** How far a checkout's engine pin is behind the engine's main ("main": the game's main checkout). */
type EnginePins = Record<string, { behind: number; latest: string }>;

const ago = (iso: string) => {
	const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
	return `${Math.round(m / 60 / 24)} d ago`;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function WorktreesView() {
	const changesOf = useStudio((s) => s.changesOf);
	const reviewOf = useStudio((s) => s.reviewOf);
	// Reading the changes from a review comes back to the review.
	if (changesOf) return <WorktreeChanges key={changesOf} worktreeId={changesOf} />;
	return reviewOf ? <Review key={reviewOf} worktreeId={reviewOf} /> : <WorktreeList />;
}

function WorktreeList() {
	const { project, selected, worktrees, sessions, assetsVersion, selectWorktree, refreshWorktrees, showError, setView } = useStudio(
		useShallow((s) => ({
			project: s.project,
			selected: s.selected,
			worktrees: s.worktrees,
			sessions: s.sessions,
			assetsVersion: s.assetsVersion,
			selectWorktree: s.selectWorktree,
			refreshWorktrees: s.refreshWorktrees,
			showError: s.showError,
			setView: s.setView,
		})),
	);
	const list = worktrees.filter(isOpenWorktree);
	const [facts, setFacts] = useState<Record<string, Facts>>({});
	const [space, setSpace] = useState<Space[] | null>(null);
	const [engine, setEngine] = useState<EnginePins>({});
	const [busy, setBusy] = useState(false);
	// The row being renamed ("new": the New worktree box), and its text.
	const [naming, setNaming] = useState<string | null>(null);
	const [label, setLabel] = useState("");

	// Each loaded worktree's changes and standing against main, and everyone's disk use.
	useEffect(() => {
		let live = true;
		call("worktrees.space").then((s) => live && setSpace(s), () => {});
		const pin = (key: string, checkout: string | null) =>
			call("git.engineInfo", checkout).then((e) => live && setEngine((all) => ({ ...all, [key]: { behind: e?.behind ?? 0, latest: e?.latest ?? "" } })), () => {});
		if (project) void pin("main", null);
		for (const w of worktrees.filter(isOpenWorktree)) {
			if (w.checkout === "removed") continue;
			if (w.target === "project") void pin(w.id, w.id);
			Promise.all([call("worktrees.status", w.id), call("worktrees.changedFiles", w.id)]).then(
				([s, f]) => live && setFacts((all) => ({ ...all, [w.id]: { changes: otherFiles(f).length, behind: s.behind, conflicts: s.conflicts } })),
				() => {},
			);
		}
		return () => {
			live = false;
		};
	}, [worktrees, assetsVersion, project]);

	const working = (w: WorktreeSummary) => sessions.some((s) => s.worktreeId === w.id && (s.status === "in_progress" || s.status === "starting"));
	/** The sessions in a worktree that asked for review and still wait for it, oldest request first. */
	const asking = (w: WorktreeSummary) => sessions.filter((s) => s.worktreeId === w.id && s.reviewRequested && s.status !== "done").sort((a, b) => (a.reviewRequestedAt ?? "").localeCompare(b.reviewRequestedAt ?? ""));
	const queue = list
		.map((w) => ({ w, asks: asking(w) }))
		.filter((q) => q.asks.length)
		.sort((a, b) => (a.asks[0].reviewRequestedAt ?? "").localeCompare(b.asks[0].reviewRequestedAt ?? ""));
	const act = async (what: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await what();
			await refreshWorktrees();
			await useStudio.getState().refreshHistory();
			useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};
	const submitLabel = () => {
		const text = label.trim();
		const id = naming;
		setNaming(null);
		setLabel("");
		if (!text || !id) return;
		void act(async () => {
			if (id !== "new") return call("worktrees.rename", id, text);
			const w = await call("worktrees.create", text);
			await refreshWorktrees();
			selectWorktree(w.id);
		});
	};
	const labelBox = (placeholder: string) => (
		<input
			className="grow"
			autoFocus
			value={label}
			placeholder={placeholder}
			onChange={(e) => setLabel(e.target.value)}
			onKeyDown={(e) => (e.key === "Enter" ? submitLabel() : e.key === "Escape" && setNaming(null))}
			onBlur={() => !label.trim() && setNaming(null)}
			data-testid="worktrees-label"
		/>
	);
	/** Merges latest main into a worktree (saving its unsaved edits first, if the person agrees); null: they declined. */
	const updateOne = async (w: WorktreeSummary) => {
		const u = await unsavedOf(w.id);
		if (u.count) {
			if (!window.confirm(`“${w.label}” has unsaved edits. Save them, then update from main?`)) return null;
			await call("worktrees.save", w.id, u.message);
		}
		return call("worktrees.update", w.id);
	};
	// Update all: every worktree that's behind main, one after the other. One that conflicts is left with its update
	// open (its row offers Resolve and Abort update); one that fails doesn't stop the rest.
	const [updatingAll, setUpdatingAll] = useState<string | null>(null);
	const behind = list.filter((w) => facts[w.id] && !facts[w.id].conflicts && facts[w.id].behind > 0 && !working(w));
	const updateAll = () =>
		void act(async () => {
			let updated = 0;
			const conflicted: string[] = [];
			const failed: string[] = [];
			try {
				for (const [i, w] of behind.entries()) {
					setUpdatingAll(`Updating ${i + 1} of ${behind.length}…`);
					try {
						const r = await updateOne(w);
						if (!r) continue;
						if (r.conflicts.length) conflicted.push(w.label);
						else updated++;
					} catch (err) {
						failed.push(`${w.label}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			} finally {
				setUpdatingAll(null);
			}
			const parts = [`Updated ${plural(updated, "worktree")} from main`];
			if (conflicted.length) parts.push(`${conflicted.length} with conflicts (Resolve or Abort update on ${conflicted.length === 1 ? "its row" : "their rows"})`);
			useStudio.getState().notify(parts.join("; "));
			if (failed.length) throw new Error(`Couldn't update:\n${failed.join("\n")}`);
		});
	const update = (w: WorktreeSummary) =>
		void act(async () => {
			const r = await updateOne(w);
			if (!r) return;
			if (!r.conflicts.length) return useStudio.getState().notify(`Updated “${w.label}” from main (${plural(r.commits, "commit")})`);
			const files = r.conflicts.slice(0, 12).map((f) => `- ${f}`).join("\n");
			if (window.confirm(`${plural(r.conflicts.length, "file")} conflict with main:\n${files}\n\nStart the Conflict Resolver to merge them? (Cancel leaves the update open: resolve or abort it from here.)`)) {
				const s = await call("worktrees.resolveConflicts", w.id);
				useStudio.getState().selectSession(s.id);
			}
		});
	/** Moves the engine pin of a worktree (null: the game's main) to the engine's latest, as a commit there. */
	const updateEngine = (w: WorktreeSummary | null) => {
		const e = engine[w?.id ?? "main"];
		const where = w ? `“${w.label}”` : "main";
		if (!e || !window.confirm(`Update the engine in ${where} to its latest (${e.latest.slice(0, 7)}, ${plural(e.behind, "commit")} newer) and commit that${w ? " in the worktree" : " on main"}?`)) return;
		void act(async () => {
			await call("git.updateEngine", w?.id ?? null);
			useStudio.getState().notify(`Updated the engine in ${where} to ${e.latest.slice(0, 7)}`);
		});
	};
	const engineButton = (w: WorktreeSummary | null, disabled: boolean) => {
		const e = engine[w?.id ?? "main"];
		if (!e || e.behind <= 0) return null;
		return (
			<button className="small" disabled={disabled} onClick={() => updateEngine(w)} title={`Pin the engine's latest commit (${e.latest.slice(0, 7)}) here, as a commit${w ? " in this worktree" : " on main"}`} data-testid="worktrees-update-engine">
				Update engine
			</button>
		);
	};
	const engineFact = (id: string) => (engine[id]?.behind > 0 ? <span title="Its pinned engine against the engine's main">engine {plural(engine[id].behind, "commit")} behind</span> : null);
	const resolve = (w: WorktreeSummary) =>
		void act(async () => {
			const s = await call("worktrees.resolveConflicts", w.id);
			useStudio.getState().selectSession(s.id);
		});
	const abortUpdate = (w: WorktreeSummary) =>
		window.confirm(`Abort the update of “${w.label}” from main? Its files go back to before the update.`) && void act(() => call("worktrees.abortUpdate", w.id));
	const unload = (w: WorktreeSummary, bytes: number | null) => {
		if (!window.confirm(`Free up space by removing the folder of “${w.label}”${bytes ? ` (${megabytes(bytes)})` : ""}?\n\nNothing is lost: its work is committed on its branch, and its sessions stay. Switching to it (or resuming one of its sessions) brings the folder back.`)) return;
		void act(async () => {
			await call("worktrees.unload", w.id);
			useStudio.getState().notify(`Freed “${w.label}”`);
		});
	};
	const discard = (w: WorktreeSummary) =>
		void act(async () => {
			if (await confirmDiscard(w.id, w.label)) await call("worktrees.discard", w.id);
		});
	const showSessions = (w: WorktreeSummary) => {
		selectWorktree(w.id);
		setView("sessions");
	};

	const row = (w: WorktreeSummary) => {
		const f = facts[w.id];
		const sp = space?.find((x) => x.id === w.id);
		const current = w.id === selected;
		const busyHere = busy || working(w);
		const unloaded = w.checkout === "removed";
		const blocker = current ? "it's the current worktree: switch to another first" : sp?.blocker;
		return (
			<div key={w.id} className={`worktree-row ${current ? "current" : ""}`} data-testid="worktrees-row" data-target={w.target}>
				<div className="worktree-row-main">
					<div className="row">
						{naming === w.id ? (
							labelBox("A new name for this worktree")
						) : (
							<span className="worktree-row-label ellipsis" title={w.label}>
								{w.label}
							</span>
						)}
						{current && (
							<span className="badge current" data-testid="worktrees-current">
								current
							</span>
						)}
						{working(w) && (
							<span className="badge status-in_progress">
								<span className="dot" />
								working
							</span>
						)}
						{unloaded && <span className="badge">unloaded</span>}
						{asking(w).length > 0 && <span className="badge review">Ready for review</span>}
					</div>
					<div className="row muted small worktree-row-facts">
						{f && <span title="Files it changed against main">{plural(f.changes, "change")}</span>}
						{f?.conflicts && <span className="conflict">⚠ {plural(f.conflicts.length, "conflict")} with main</span>}
						{f && !f.conflicts && f.behind > 0 && <span>main has {plural(f.behind, "new commit")}</span>}
						{engineFact(w.id)}
						<button className="link" onClick={() => showSessions(w)} title="Switch to it and show its sessions" data-testid="worktrees-sessions">
							{plural(w.sessionIds.length, "session")}
						</button>
						<span data-testid="worktrees-size">{unloaded ? "no folder on disk" : sp?.bytes ? megabytes(sp.bytes) : "…"}</span>
						<span title={new Date(w.updatedAt).toLocaleString()}>changed {ago(w.updatedAt)}</span>
					</div>
				</div>
				<div className="row worktree-row-actions">
					{f?.conflicts && (
						<>
							<button className="small" disabled={busyHere} onClick={() => resolve(w)} title="Start the Conflict Resolver, briefed with this worktree's sessions" data-testid="worktrees-resolve">
								Resolve
							</button>
							<button className="small" disabled={busyHere} onClick={() => abortUpdate(w)} title="Put the files back to before the update">
								Abort update
							</button>
						</>
					)}
					{f && !f.conflicts && f.behind > 0 && (
						<button className="small" disabled={busyHere} onClick={() => update(w)} title={working(w) ? "Wait for the agents to finish" : "Merge latest main into this worktree"} data-testid="worktrees-update">
							Update
						</button>
					)}
					{!f?.conflicts && engineButton(w, busyHere)}
					<button className={`small ${asking(w).length ? "primary" : ""}`} disabled={unloaded || !f || f.changes === 0} onClick={() => useStudio.getState().openReview(w.id)} title={unloaded ? "Switch to it first: its folder isn't on disk" : "Look at what it changed beside main's version, mark what needs work, and send your notes to its agents"} data-testid="worktrees-review">
						Review
					</button>
					<button className="small" disabled={unloaded || !f || f.changes === 0} onClick={() => useStudio.getState().openChanges(w.id)} title={unloaded ? "Switch to it first: its folder isn't on disk" : "Read everything this worktree changed, file by file"} data-testid="worktrees-changes">
						View changes
					</button>
					{!current && (
						<button className="small" disabled={busy} onClick={() => selectWorktree(w.id)} title={unloaded ? "Bring its folder back and show it in the studio" : "Show this worktree in the studio"} data-testid="worktrees-switch">
							Switch to
						</button>
					)}
					<button className={`small ${current ? "primary" : ""}`} disabled={busy} onClick={() => useStudio.getState().openMerge(w.id)} title="Merge everything this worktree changed into main (shows what it changed and its sessions first)" data-testid="worktrees-merge">
						Merge…
					</button>
					<button className="small icon" disabled={busy} onClick={() => (setNaming(w.id), setLabel(w.label))} title="Rename" aria-label="Rename" data-testid="worktrees-rename">
						✎
					</button>
					<button
						className="small icon"
						disabled={busy || unloaded || !sp || !!blocker}
						title={unloaded ? "Its folder is already removed" : blocker ? `Can't free its space: ${blocker}` : `Free up space: remove its folder${sp?.bytes ? ` (${megabytes(sp.bytes)})` : ""}. Its work is on its branch; switching to it brings the folder back.`}
						aria-label="Free up space"
						onClick={() => unload(w, sp?.bytes ?? null)}
						data-testid="worktrees-unload"
					>
						⏏
					</button>
					<button className="small icon danger-text" disabled={busyHere} onClick={() => discard(w)} title={working(w) ? "Wait for the agents to finish" : "Discard: throw away this worktree and everything it changed"} aria-label="Discard" data-testid="worktrees-discard">
						🗑
					</button>
				</div>
			</div>
		);
	};

	const total = space?.reduce((n, s) => n + (s.bytes ?? 0), 0) ?? 0;
	return (
		<div className="page worktrees-page" data-testid="worktrees-page">
			<div className="row">
				<div className="col grow" style={{ gap: 2 }}>
					<h2>Worktrees</h2>
					<span className="muted small">Work that isn't in main yet. Each worktree is its own copy of the files, with its own sessions, until it's merged or discarded.</span>
				</div>
				{total > 0 && (
					<span className="muted small" data-testid="worktrees-space-total">
						{megabytes(total)} on disk
					</span>
				)}
				{(behind.length > 0 || updatingAll) && (
					<button disabled={busy} onClick={updateAll} title={`Merge latest main into each of the ${plural(behind.length, "worktree")} that main has moved past, one by one. Worktrees an agent is working in are skipped.`} data-testid="worktrees-update-all">
						{updatingAll ?? `Update all (${behind.length})`}
					</button>
				)}
				{project && (
					<button className="primary" disabled={busy} onClick={() => (setNaming("new"), setLabel(""))} data-testid="worktrees-new">
						+ New worktree
					</button>
				)}
			</div>
			{naming === "new" && (
				<div className="card">
					<div className="row">
						{labelBox("What's the work? e.g. Dungeon level 5 re-texturing")}
						<button className="primary" disabled={!label.trim()} onMouseDown={(e) => e.preventDefault()} onClick={submitLabel}>
							Create
						</button>
					</div>
				</div>
			)}
			{queue.length > 0 && (
				<div className="col" style={{ gap: 6 }} data-testid="review-queue">
					<h3>
						Waiting for your review <span className="muted">{queue.length}</span>
					</h3>
					<div className="card worktree-rows">
						{queue.map(({ w, asks }) => (
							<div key={w.id} className="worktree-row" data-testid="review-queue-row">
								<div className="worktree-row-main">
									<div className="row">
										<span className="worktree-row-label ellipsis" title={w.label}>
											{w.label}
										</span>
										<span className="badge">{GROUPS.find((g) => g.target === w.target)?.label ?? w.target}</span>
										{working(w) && (
											<span className="badge status-in_progress">
												<span className="dot" />
												still working
											</span>
										)}
									</div>
									<div className="muted small ellipsis" title={asks.map((s) => s.reviewSummary).filter(Boolean).join("\n\n")}>
										{asks[0].reviewRequestedAt ? `Asked ${ago(asks[0].reviewRequestedAt)}` : "Asked"}
										{facts[w.id] ? ` · ${plural(facts[w.id].changes, "change")}` : ""}
										{asks[0].reviewSummary ? ` · ${asks[0].reviewSummary}` : ""}
									</div>
								</div>
								<button className="primary small" disabled={w.checkout === "removed"} onClick={() => useStudio.getState().openReview(w.id)} data-testid="review-queue-open">
									Review
								</button>
							</div>
						))}
					</div>
				</div>
			)}
			{project && (
				<div className="card worktree-rows">
					<div className={`worktree-row ${selected ? "" : "current"}`} data-testid="worktrees-main">
						<div className="worktree-row-main">
							<div className="row">
								<span className="worktree-row-label">main</span>
								{!selected && <span className="badge current">current</span>}
							</div>
							<div className="row muted small worktree-row-facts">
								<span>What's in the game. Edits and sessions start a worktree of their own.</span>
								{engineFact("main")}
							</div>
						</div>
						{engineButton(null, busy)}
						{selected && (
							<button className="small" onClick={() => selectWorktree(null)} data-testid="worktrees-switch-main">
								Switch to
							</button>
						)}
					</div>
				</div>
			)}
			{GROUPS.map(({ target, label: name }) => {
				const group = list.filter((w) => w.target === target);
				if (!group.length && (target !== "project" || !project)) return null;
				return (
					<div key={target} className="col" style={{ gap: 6 }} data-testid={`worktrees-group-${target}`}>
						<h3>
							{name} <span className="muted">{group.length || ""}</span>
						</h3>
						<div className="card worktree-rows">
							{group.map(row)}
							{!group.length && <span className="muted small">No open worktrees. Starting a session or editing in a section starts one.</span>}
						</div>
					</div>
				);
			})}
		</div>
	);
}
