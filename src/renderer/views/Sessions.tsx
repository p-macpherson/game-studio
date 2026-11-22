import { useEffect, useState } from "react";
import type { SessionStatus, SessionSummary, Target } from "../../shared/types";
import { findAgentType } from "../../shared/agents";
import { call, relativeTime } from "../api";
import { isOpenWorktree, useStudio } from "../store";
import { SessionDetail } from "./SessionDetail";
import { useShallow } from "zustand/react/shallow";

type StatusFilter = "in_progress" | "idle" | "done";
const STATUS_GROUP: Record<SessionStatus, StatusFilter> = {
	starting: "in_progress",
	in_progress: "in_progress",
	idle: "idle",
	interrupted: "idle",
	done: "done",
};
const STATUS_LABEL: Record<SessionStatus, string> = {
	starting: "Starting",
	in_progress: "In progress",
	idle: "Idle",
	interrupted: "Interrupted",
	done: "Done",
};

export function StatusBadge({ s }: { s: SessionSummary }) {
	const label = s.status === "done" && s.outcome ? `Done · ${s.outcome}` : STATUS_LABEL[s.status];
	return (
		<span className={`badge status-${s.status}`}>
			<span className="dot" />
			{label}
		</span>
	);
}

export function TargetBadge({ target }: { target: Target }) {
	return <span className={`badge target-${target}`}>{target}</span>;
}

export function Sessions() {
	const { sessions, agentTypes, selectedSession, selectSession, openNewSession, selected: picked, worktrees, showError, refreshSessions, selectWorktree } = useStudio(
		useShallow((s) => ({
			sessions: s.sessions,
			agentTypes: s.agentTypes,
			selectedSession: s.selectedSession,
			selectSession: s.selectSession,
			openNewSession: s.openNewSession,
			selected: s.selected,
			worktrees: s.worktrees,
			showError: s.showError,
			refreshSessions: s.refreshSessions,
			selectWorktree: s.selectWorktree,
		})),
	);
	// Which sessions: the selected worktree's (game, engine or studio); with main selected, those in no open worktree
	// (finished, merged or discarded work).
	const current = worktrees.find((w) => w.id === picked && isOpenWorktree(w));
	const open = new Set(worktrees.filter(isOpenWorktree).map((w) => w.id));
	// Or, with "All worktrees" on, every session, in a section per worktree.
	const [all, setAll] = useState(() => localStorage.getItem("sessions-all-worktrees") === "1");
	const toggleAll = () => {
		localStorage.setItem("sessions-all-worktrees", all ? "0" : "1");
		setAll(!all);
	};
	const inScope = (s: SessionSummary) => all || (current ? s.worktreeId === current.id : !open.has(s.worktreeId));
	const [statuses, setStatuses] = useState<Set<StatusFilter>>(new Set(["in_progress", "idle"]));
	const [target, setTarget] = useState<Target | "all">("all");
	const [search, setSearch] = useState("");
	// Work closed over a week ago lives in the project's archive folder (out of git) and is only read when asked for.
	const [archive, setArchive] = useState<SessionSummary[] | null>(null);
	const showArchive = archive !== null;
	useEffect(() => {
		if (showArchive) call("sessions.archived").then(setArchive, showError);
	}, [showArchive, sessions, showError]);
	const restore = async (id: string) => {
		try {
			await call("sessions.restore", id);
			await refreshSessions();
			setArchive(null);
			setStatuses(new Set(["in_progress", "idle", "done"]));
			selectSession(id);
		} catch (err) {
			showError(err);
		}
	};
	const archived = (archive ?? []).filter((s) => (target === "all" || s.target === target) && (!search || `${s.title} ${s.agentType}`.toLowerCase().includes(search.toLowerCase())));

	const toggle = (f: StatusFilter) => {
		const next = new Set(statuses);
		if (next.has(f)) next.delete(f);
		else next.add(f);
		setStatuses(next);
	};
	const typeName = (id: string) => findAgentType(agentTypes, id)?.name ?? id;
	const matches = (s: SessionSummary) =>
		inScope(s) &&
		statuses.has(STATUS_GROUP[s.status]) &&
		(target === "all" || s.target === target) &&
		(!search || `${s.title} ${s.agentType}`.toLowerCase().includes(search.toLowerCase()));
	// The tree: sessions a person started at the top, each over the sub-agents it delegated to (in the order it
	// started them). The filters apply to sub-agents too: a session shows if it matches or anything below it does, and
	// a row says how many of its sub-agents the filters hide ("2 hidden": click to show them anyway). A sub-agent is in
	// its parent's worktree; a session recorded under a parent of another worktree (older data) lists on its own.
	const byId = new Map(sessions.map((s) => [s.id, s]));
	const parentOf = (s: SessionSummary) => {
		const p = s.parentId ? byId.get(s.parentId) : undefined;
		return p && p.worktreeId === s.worktreeId ? p : undefined;
	};
	const children = new Map<string, SessionSummary[]>();
	for (const s of [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
		const p = parentOf(s);
		if (p) children.set(p.id, [...(children.get(p.id) ?? []), s]);
	}
	const shown = (s: SessionSummary): boolean => matches(s) || (children.get(s.id) ?? []).some(shown);
	const roots = sessions.filter((s) => !parentOf(s) && shown(s));
	// Folded or not, as the person chose; by default open while any sub-agent isn't done.
	const [folded, setFolded] = useState<Map<string, boolean>>(new Map());
	const toggleNode = (id: string, open: boolean) => setFolded((m) => new Map(m).set(id, open));
	// Rows whose filtered-out sub-agents are shown anyway.
	const [revealed, setRevealed] = useState<Set<string>>(new Set());
	const reveal = (id: string) => {
		setRevealed((r) => {
			const next = new Set(r);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
		if (!revealed.has(id)) toggleNode(id, false);
	};
	// "All worktrees": which worktree sections are folded.
	const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
	const toggleSection = (id: string) =>
		setClosedSections((c) => {
			const next = new Set(c);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	// Only a session of the shown worktree (or main's list): another worktree's stays selected for when you go back.
	const selected = sessions.find((s) => s.id === selectedSession && inScope(s));
	const running = (s: SessionSummary) => s.status === "in_progress" || s.status === "starting";

	// "All worktrees": a section per open worktree that has sessions to show (the selected one first, then the most
	// recently active), and one for the sessions in none (finished, merged or discarded work).
	const lastActive = (list: SessionSummary[]) => list.reduce((t, s) => (s.updatedAt > t ? s.updatedAt : t), "");
	const sections = [
		...worktrees
			.filter(isOpenWorktree)
			.map((w) => ({ id: w.id, label: w.label, worktree: w as (typeof worktrees)[number] | null, roots: roots.filter((s) => s.worktreeId === w.id) }))
			.sort((a, b) => Number(b.id === current?.id) - Number(a.id === current?.id) || lastActive(b.roots).localeCompare(lastActive(a.roots))),
		{ id: "", label: "Not in an open worktree (finished work)", worktree: null, roots: roots.filter((s) => !open.has(s.worktreeId)) },
	].filter((sec) => sec.roots.length);

	const node = (s: SessionSummary, depth: number) => {
		const allKids = children.get(s.id) ?? [];
		const matching = allKids.filter(shown);
		const hidden = allKids.length - matching.length;
		const kids = revealed.has(s.id) ? allKids : matching;
		const open = !(folded.get(s.id) ?? !kids.some((k) => k.status !== "done"));
		const working = allKids.filter(running).length;
		return (
			<div key={s.id} className="session-node">
				<div
					className={`session-item ${s.id === selectedSession ? "selected" : ""} ${depth ? "sub-agent" : ""}`}
					style={{ paddingLeft: 14 + depth * 18 }}
					onClick={() => selectSession(s.id)}
					data-testid="session-item"
					data-depth={depth}
				>
					<div className="row">
						{kids.length > 0 ? (
							<button
								className="tree-toggle"
								onClick={(e) => (e.stopPropagation(), toggleNode(s.id, open))}
								title={open ? "Hide its sub-agents" : "Show its sub-agents"}
								data-testid="tree-toggle"
							>
								{open ? "▾" : "▸"}
							</button>
						) : (
							depth > 0 && <span className="tree-toggle muted">·</span>
						)}
						<span className="title grow ellipsis">{s.title}</span>
						<span className="muted" style={{ fontSize: 11 }}>
							{relativeTime(s.updatedAt)}
						</span>
					</div>
					<div className="row session-item-facts">
						<StatusBadge s={s} />
						<TargetBadge target={s.target} />
						{!depth && !all && s.worktree === "active" && (
							<span className="muted ellipsis small" title={`Worktree: ${s.worktreeLabel}`}>
								⎇ {s.worktreeLabel}
							</span>
						)}
						<span className="muted ellipsis" style={{ fontSize: 12 }}>
							{typeName(s.agentType)}
						</span>
						{allKids.length > 0 && (
							<span className="badge" title="Sub-agents it delegated to">
								{working ? `waiting on ${working} of ${allKids.length}` : `${allKids.length} sub-agent${allKids.length > 1 ? "s" : ""}`}
							</span>
						)}
						{hidden > 0 && (
							<button
								className="badge hidden-count"
								onClick={(e) => (e.stopPropagation(), reveal(s.id))}
								title={revealed.has(s.id) ? "Hide the sub-agents the filters leave out" : "Sub-agents the filters leave out (e.g. done ones): click to show them"}
								data-testid="subagents-hidden"
							>
								{revealed.has(s.id) ? `hide ${hidden}` : `${hidden} hidden`}
							</button>
						)}
						{s.reviewRequested && <span className="badge review">Ready for review</span>}
						{s.pendingQuestion && <span className="badge review">Question</span>}
					</div>
				</div>
				{open && kids.map((k) => node(k, depth + 1))}
			</div>
		);
	};

	return (
		<div className="sessions">
			<div className="session-list">
				<div className="toolbar">
					<div className="row">
						<h2 className="grow">Sessions</h2>
						<button className="primary" onClick={() => openNewSession({})}>
							+ New session
						</button>
					</div>
					<input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
					<div className="row">
						<div className="chips grow">
							{(["in_progress", "idle", "done"] as const).map((f) => (
								<button key={f} className={`chip ${statuses.has(f) ? "on" : ""}`} onClick={() => toggle(f)}>
									{f === "in_progress" ? "In progress" : f === "idle" ? "Idle" : "Done"}
								</button>
							))}
							<button
								className={`chip ${showArchive ? "on" : ""}`}
								onClick={() => setArchive(showArchive ? null : [])}
								title="Sessions closed over a week ago: kept on this machine, out of git"
								data-testid="archived-chip"
							>
								Archived
							</button>
						</div>
						<select value={target} onChange={(e) => setTarget(e.target.value as Target | "all")}>
							<option value="all">All targets</option>
							<option value="project">Project</option>
							<option value="engine">Engine</option>
							<option value="studio">Studio</option>
						</select>
					</div>
				</div>
				<div className={`scope-banner ${current && !all ? "" : "scope-main"}`} data-testid="sessions-scope">
					<button className={`chip scope-all ${all ? "on" : ""}`} onClick={toggleAll} aria-pressed={all} title="List every session, in a section per worktree" data-testid="sessions-all">
						All worktrees
					</button>
					{all ? (
						<>
							<b>Every session</b>, by worktree. A new session {current ? <>joins <b>{current.label}</b> (the selected worktree)</> : <>starts <b>its own worktree</b></>}.
						</>
					) : current ? (
						<>
							⎇ <b>{current.label}</b>
							{current.target !== "project" && ` (${current.target})`}: its sessions. New {current.target === "project" ? "game" : current.target} sessions join this worktree.
						</>
					) : (
						<>
							<b>Main</b>: a new session starts <b>its own worktree</b>, named after its task. Listed here: finished work. Pick a worktree in the sidebar
							(game, engine or studio) to see its sessions.
						</>
					)}
				</div>
				<div className="session-items">
					{showArchive ? (
						<>
							{archived.length === 0 && <div className="empty">Nothing archived matches. Sessions move here a week after they are closed.</div>}
							{archived.map((s) => (
								<div key={s.id} className="session-item" style={{ paddingLeft: 14 }} data-testid="archived-item">
									<div className="row">
										<span className="title grow ellipsis">{s.title}</span>
										<span className="muted" style={{ fontSize: 11 }}>
											{relativeTime(s.closedAt ?? s.updatedAt)}
										</span>
									</div>
									<div className="row">
										<StatusBadge s={s} />
										<TargetBadge target={s.target} />
										<span className="muted ellipsis grow" style={{ fontSize: 12 }}>
											{typeName(s.agentType)}
											{s.worktreeLabel && ` · ⎇ ${s.worktreeLabel}`}
										</span>
										<button onClick={() => restore(s.id)} title="Bring it back, with the other sessions of its worktree">
											Restore
										</button>
									</div>
								</div>
							))}
						</>
					) : (
						<>
							{roots.length === 0 && <div className="empty">{current ? "No sessions in this worktree match." : "No sessions here match."} Start one with “New session”.</div>}
							{!all && roots.map((s) => node(s, 0))}
							{all &&
								sections.map((sec) => {
									const closed = closedSections.has(sec.id);
									return (
										<div key={sec.id} className="session-section" data-testid="session-section">
											<div className="session-section-head" onClick={() => toggleSection(sec.id)} title={closed ? "Show its sessions" : "Hide its sessions"}>
												<span className="tree-toggle">{closed ? "▸" : "▾"}</span>
												<span className="grow ellipsis" title={sec.label}>
													{sec.worktree ? "⎇ " : ""}
													{sec.label}
												</span>
												{sec.worktree && sec.worktree.target !== "project" && <TargetBadge target={sec.worktree.target} />}
												{sec.worktree?.id === current?.id && sec.worktree && <span className="badge current">current</span>}
												<span className="count">{sec.roots.length}</span>
												{sec.worktree && sec.worktree.id !== current?.id && (
													<button className="small" onClick={(e) => (e.stopPropagation(), selectWorktree(sec.worktree!.id))} title="Show this worktree in the studio" data-testid="section-switch">
														Switch to
													</button>
												)}
											</div>
											{!closed && sec.roots.map((s) => node(s, 0))}
										</div>
									);
								})}
						</>
					)}
				</div>
			</div>
			{selected ? <SessionDetail key={selected.id} session={selected} /> : <div className="empty">Select a session, or start a new one.</div>}
		</div>
	);
}
