import { useState } from "react";
import type { SessionStatus, SessionSummary, Target } from "../../shared/types";
import { findAgentType } from "../../shared/agents";
import { relativeTime } from "../api";
import { useStudio } from "../store";
import { SessionDetail } from "./SessionDetail";

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
	const { sessions, agentTypes, selectedSession, selectSession, openNewSession } = useStudio();
	const [statuses, setStatuses] = useState<Set<StatusFilter>>(new Set(["in_progress", "idle"]));
	const [target, setTarget] = useState<Target | "all">("all");
	const [search, setSearch] = useState("");

	const toggle = (f: StatusFilter) => {
		const next = new Set(statuses);
		if (next.has(f)) next.delete(f);
		else next.add(f);
		setStatuses(next);
	};
	const typeName = (id: string) => findAgentType(agentTypes, id)?.name ?? id;
	const matches = (s: SessionSummary) =>
		statuses.has(STATUS_GROUP[s.status]) &&
		(target === "all" || s.target === target) &&
		(!search || `${s.title} ${s.agentType}`.toLowerCase().includes(search.toLowerCase()));
	// The tree: sessions a person started at the top, each over the sub-agents it delegated to (in the order it
	// started them). A session shows if it matches the filters or anything below it does.
	const ids = new Set(sessions.map((s) => s.id));
	const children = new Map<string, SessionSummary[]>();
	for (const s of [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
		if (s.parentId && ids.has(s.parentId)) children.set(s.parentId, [...(children.get(s.parentId) ?? []), s]);
	}
	const shown = (s: SessionSummary): boolean => matches(s) || (children.get(s.id) ?? []).some(shown);
	const roots = sessions.filter((s) => !(s.parentId && ids.has(s.parentId)) && shown(s));
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const toggleNode = (id: string) => setCollapsed((c) => (c.has(id) ? new Set([...c].filter((x) => x !== id)) : new Set([...c, id])));
	const selected = sessions.find((s) => s.id === selectedSession);
	const running = (s: SessionSummary) => s.status === "in_progress" || s.status === "starting";

	const node = (s: SessionSummary, depth: number) => {
		const kids = (children.get(s.id) ?? []).filter(shown);
		const open = !collapsed.has(s.id);
		const working = kids.filter(running).length;
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
								onClick={(e) => (e.stopPropagation(), toggleNode(s.id))}
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
					<div className="row">
						<StatusBadge s={s} />
						<TargetBadge target={s.target} />
						{s.target === "project" && !depth && (
							<span className="muted ellipsis small" title={`Worktree: ${s.worktreeLabel}`}>
								⎇ {s.worktreeLabel}
							</span>
						)}
						<span className="muted ellipsis" style={{ fontSize: 12 }}>
							{typeName(s.agentType)}
						</span>
						{kids.length > 0 && (
							<span className="badge" title="Sub-agents it delegated to">
								{working ? `waiting on ${working} of ${kids.length}` : `${kids.length} sub-agent${kids.length > 1 ? "s" : ""}`}
							</span>
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
						</div>
						<select value={target} onChange={(e) => setTarget(e.target.value as Target | "all")}>
							<option value="all">All targets</option>
							<option value="project">Project</option>
							<option value="engine">Engine</option>
							<option value="studio">Studio</option>
						</select>
					</div>
				</div>
				<div className="session-items">
					{roots.length === 0 && <div className="empty">No sessions match. Start one with “New session”.</div>}
					{roots.map((s) => node(s, 0))}
				</div>
			</div>
			{selected ? <SessionDetail key={selected.id} session={selected} /> : <div className="empty">Select a session, or start a new one.</div>}
		</div>
	);
}
