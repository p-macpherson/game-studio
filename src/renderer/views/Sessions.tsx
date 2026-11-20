import { useState } from "react";
import type { SessionStatus, SessionSummary, Target } from "../../shared/types";
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
	const typeName = (id: string) => agentTypes.find((t) => t.id === id)?.name ?? id;
	const visible = sessions.filter(
		(s) =>
			statuses.has(STATUS_GROUP[s.status]) &&
			(target === "all" || s.target === target) &&
			(!search || `${s.title} ${s.agentType}`.toLowerCase().includes(search.toLowerCase())),
	);
	const selected = sessions.find((s) => s.id === selectedSession);

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
					{visible.length === 0 && <div className="empty">No sessions match. Start one with “New session”.</div>}
					{visible.map((s) => (
						<div
							key={s.id}
							className={`session-item ${s.id === selectedSession ? "selected" : ""}`}
							onClick={() => selectSession(s.id)}
							data-testid="session-item"
						>
							<div className="row">
								<span className="title grow ellipsis">{s.title}</span>
								<span className="muted" style={{ fontSize: 11 }}>
									{relativeTime(s.updatedAt)}
								</span>
							</div>
							<div className="row">
								<StatusBadge s={s} />
								<TargetBadge target={s.target} />
								{s.target === "project" && (
									<span className="muted ellipsis small" title={`Worktree: ${s.worktreeLabel}`}>
										⎇ {s.worktreeLabel}
									</span>
								)}
								<span className="muted ellipsis" style={{ fontSize: 12 }}>
									{typeName(s.agentType)}
								</span>
								{s.reviewRequested && <span className="badge review">Ready for review</span>}
								{s.pendingQuestion && <span className="badge review">Question</span>}
							</div>
						</div>
					))}
				</div>
			</div>
			{selected ? <SessionDetail key={selected.id} session={selected} /> : <div className="empty">Select a session, or start a new one.</div>}
		</div>
	);
}
