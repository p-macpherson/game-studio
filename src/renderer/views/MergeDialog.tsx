// Merging a worktree into the game: what it changed (by section, and its commits), the person's unsaved edits
// (saved as part of the merge), and every session in it. A session still working blocks the merge; idle ones
// (waiting for an answer, or interrupted) are a warning, since merging ends them.
import { useEffect, useState } from "react";
import type { HistoryStep } from "../../shared/history";
import type { ModuleInfo } from "../../shared/modules";
import type { GitCommit, SessionSummary } from "../../shared/types";
import { findAgentType } from "../../shared/agents";
import { call } from "../api";
import { useStudio } from "../store";
import { saveMessage } from "../workspace";
import { ChangeCountsLabel } from "./AssetBrowser";
import { StatusBadge } from "./Sessions";

type Change = { path: string; change: "added" | "modified" | "deleted" };
const LABEL = { added: "New", modified: "Modified", deleted: "Removed" } as const;
const WORKING = new Set(["starting", "in_progress"]);
const WAITING = new Set(["idle", "interrupted"]);

export function MergeDialog({ worktreeId }: { worktreeId: string }) {
	const { worktrees, sessions, modules, agentTypes, openMerge, showError, refreshWorktrees, refreshHistory, selectWorktree, worktree: selected } = useStudio();
	const w = worktrees.find((x) => x.id === worktreeId);
	const [data, setData] = useState<{ files: Change[]; commits: GitCommit[]; steps: HistoryStep[]; unsaved: string[] } | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let live = true;
		Promise.all([call("worktrees.changedFiles", worktreeId), call("worktrees.commits", worktreeId), call("history.get", worktreeId)]).then(
			([files, commits, h]) => live && setData({ files: files.filter((f) => !f.path.startsWith(".studio/")), commits, ...h }),
			(err) => live && showError(err),
		);
		return () => {
			live = false;
		};
	}, [worktreeId, showError]);

	if (!w) return null;
	const close = () => openMerge(null);
	const mine = sessions.filter((s) => s.worktreeId === worktreeId);
	const working = mine.filter((s) => WORKING.has(s.status));
	const waiting = mine.filter((s) => WAITING.has(s.status));
	const steps = data?.steps.filter((s) => s.done).map((s) => s.label) ?? [];
	const unsaved = data?.unsaved ?? [];

	const merge = async () => {
		setBusy(true);
		try {
			if (unsaved.length) await call("worktrees.save", worktreeId, saveMessage(steps, unsaved));
			await call("worktrees.merge", worktreeId);
			if (selected === worktreeId) selectWorktree(null);
			await refreshWorktrees();
			await refreshHistory();
			useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
			close();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" onClick={close}>
			<div className="modal col merge-dialog" style={{ width: 640 }} onClick={(e) => e.stopPropagation()} data-testid="merge-dialog">
				<h3>
					Merge “{w.label}” into {w.baseBranch}
				</h3>
				{!data ? (
					<div className="muted">Loading…</div>
				) : (
					<div className="col merge-body">
						<section className="col">
							<h4>
								Changes <span className="muted">{data.files.length} file{data.files.length === 1 ? "" : "s"}</span>
							</h4>
							{data.files.length === 0 && <span className="muted small">Nothing changed: merging only ends its sessions.</span>}
							{groupBySection(data.files, modules).map((g) => (
								<details key={g.name} className="merge-group" data-testid="merge-group">
									<summary className="row">
										<span className="grow">{g.name}</span>
										<ChangeCountsLabel {...count(g.files)} />
									</summary>
									{g.files.map((f) => (
										<div key={f.path} className="row merge-file">
											<code className="grow ellipsis">{f.path}</code>
											<span className={`change-label change-${f.change}`}>{LABEL[f.change]}</span>
										</div>
									))}
								</details>
							))}
							{data.commits.length > 0 && (
								<details className="merge-group">
									<summary className="row">
										<span className="grow">Commits</span>
										<span className="muted small">{data.commits.length}</span>
									</summary>
									{data.commits.map((c) => (
										<div key={c.hash} className="row merge-file">
											<code className="muted">{c.hash.slice(0, 7)}</code>
											<span className="grow ellipsis" title={c.subject}>
												{c.subject}
											</span>
										</div>
									))}
								</details>
							)}
						</section>
						{unsaved.length > 0 && (
							<section className="col" data-testid="merge-unsaved">
								<h4>Your unsaved edits</h4>
								<span className="muted small">Saved (committed) as part of the merge:</span>
								{(steps.length ? steps : unsaved).map((s) => (
									<div key={s} className="merge-file ellipsis">
										{s}
									</div>
								))}
							</section>
						)}
						<section className="col">
							<h4>
								Sessions <span className="muted">{mine.length}</span>
							</h4>
							{mine.length === 0 && <span className="muted small">None: only edits made in the sections.</span>}
							{mine.map((s) => (
								<SessionRow key={s.id} s={s} typeName={findAgentType(agentTypes, s.agentType)?.name ?? s.agentType} />
							))}
						</section>
						{working.length > 0 && (
							<div className="merge-alert error" data-testid="merge-blocked">
								{working.length === 1 ? `“${working[0].title}” is still working` : `${working.length} sessions are still working`}: wait for {working.length === 1 ? "it" : "them"} to
								finish, or stop {working.length === 1 ? "it" : "them"}, before merging.
							</div>
						)}
						{working.length === 0 && waiting.length > 0 && (
							<div className="merge-alert warning" data-testid="merge-warning">
								{waiting.length === 1 ? `“${waiting[0].title}” is` : `${waiting.length} sessions are`} idle, not finished: merging ends{" "}
								{waiting.length === 1 ? "it" : "them"}, so check {waiting.length === 1 ? "its" : "their"} last message for anything left to do.
							</div>
						)}
					</div>
				)}
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={close}>Cancel</button>
					<button className="primary" disabled={!data || busy || working.length > 0} onClick={() => void merge()} data-testid="merge-confirm">
						{busy ? "Merging…" : unsaved.length ? "Save and merge" : "Merge"}
					</button>
				</div>
			</div>
		</div>
	);
}

function SessionRow({ s, typeName }: { s: SessionSummary; typeName: string }) {
	const { selectSession, openMerge } = useStudio();
	return (
		<div className="row merge-file" data-testid="merge-session">
			<button className="ghost grow ellipsis link-like" title="Open the session" onClick={() => (openMerge(null), selectSession(s.id))}>
				{s.parentId ? "↳ " : ""}
				{s.title}
			</button>
			<span className="muted small">{typeName}</span>
			<StatusBadge s={s} />
		</div>
	);
}

/** The changed files by section (Scenes, 3D Models…), sections in the sidebar's order, then the rest. */
function groupBySection(files: Change[], modules: ModuleInfo[]): { name: string; files: Change[] }[] {
	const of = (path: string) => modules.find((m) => m.roots.some((r) => path.startsWith(`${r}/`)));
	const groups = modules.map((m) => ({ name: m.name, files: files.filter((f) => of(f.path)?.id === m.id) }));
	groups.push({ name: "Other files", files: files.filter((f) => !of(f.path)) });
	return groups.filter((g) => g.files.length > 0);
}

function count(files: Change[]) {
	return {
		added: files.filter((f) => f.change === "added").length,
		modified: files.filter((f) => f.change === "modified").length,
		deleted: files.filter((f) => f.change === "deleted").length,
	};
}
