// The remote page (vault: Initiatives/Remote Access.md): sessions and worktrees from a phone or laptop elsewhere on
// Pat's tailnet. The same store and session views as the desktop, over the HTTP bridge, in a one-column layout.
import "./remote-bridge";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useShallow } from "zustand/react/shallow";
import type { PlayBuild, SessionSummary } from "../shared/types";
import { call, onEvent, relativeTime } from "./api";
import { applyAppearance, loadAppearance } from "./appearance";
import { onReconnect } from "./remote-bridge";
import { isOpenWorktree, useStudio } from "./store";
import "./styles.css";
import { ImageViewer } from "./views/ImageViewer";
import { MergeDialog } from "./views/MergeDialog";
import { NewSessionDialog } from "./views/NewSession";
import { SessionDetail } from "./views/SessionDetail";
import { StatusBadge } from "./views/Sessions";

applyAppearance(loadAppearance());

type Tab = "sessions" | "worktrees";

/** A session is shown when it's still going or finished recently; the rest are a tap away. */
const RECENT_DAYS = 3;

function SessionRow({ s, children }: { s: SessionSummary; children: number }) {
	const selectSession = useStudio((st) => st.selectSession);
	return (
		<button className="remote-row" onClick={() => selectSession(s.id)} data-testid="remote-session">
			<span className="row">
				<span className="grow ellipsis remote-title">{s.title}</span>
				<StatusBadge s={s} />
			</span>
			<span className="row muted remote-meta">
				<span className="grow ellipsis">⎇ {s.worktreeLabel}</span>
				{children > 0 && <span>{children} sub-agent{children === 1 ? "" : "s"} · </span>}
				<span>{relativeTime(s.updatedAt)}</span>
			</span>
			{s.pendingQuestion && <span className="remote-asks">Asks: {s.pendingQuestion.question}</span>}
		</button>
	);
}

function SessionList() {
	const sessions = useStudio((st) => st.sessions);
	const [everything, setEverything] = useState(false);
	const top = sessions.filter((s) => !s.parentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const recent = Date.now() - RECENT_DAYS * 86_400_000;
	const working = (s: SessionSummary) => s.status === "in_progress" || s.status === "starting" || !!s.pendingQuestion;
	const shown = everything ? top : top.filter((s) => working(s) || s.status !== "done" || new Date(s.updatedAt).getTime() > recent);
	const childCount = (id: string) => sessions.filter((s) => s.parentId === id).length;
	return (
		<div className="remote-list">
			{shown.length === 0 && <div className="muted remote-empty">No sessions{everything ? "" : " lately"}.</div>}
			{shown.map((s) => (
				<SessionRow key={s.id} s={s} children={childCount(s.id)} />
			))}
			{shown.length < top.length && (
				<button className="ghost" onClick={() => setEverything(true)}>
					Show older ({top.length - shown.length})
				</button>
			)}
		</div>
	);
}

/** The line of a failed build's output that says what went wrong: the compiler's error, else its first line. */
function errorLine(error: string): string {
	const lines = error.split("\n").map((l) => l.trim()).filter(Boolean);
	return lines.slice(1).find((l) => /error/i.test(l)) ?? lines[0] ?? "";
}

/** A checkout's web build: build it, follow the build, then play it in a new tab. */
function PlayControls({ checkout }: { checkout: string }) {
	const { showError, selectSession, refreshSessions } = useStudio(useShallow((st) => ({ showError: st.showError, selectSession: st.selectSession, refreshSessions: st.refreshSessions })));
	const [build, setBuild] = useState<PlayBuild | null>(null);
	const [starting, setStarting] = useState(false);
	useEffect(() => {
		void call("play.status", checkout).then(setBuild, () => {});
		return onEvent((e) => {
			if (e.type === "play_build" && e.build.checkout === checkout) setBuild(e.build);
		});
	}, [checkout]);
	const start = () => void call("play.build", checkout).catch(showError);
	// Away from the desk a failed build would be a dead end: an agent looks into it, and its session opens.
	const fix = async () => {
		setStarting(true);
		try {
			const id = await call("play.investigate", checkout);
			await refreshSessions();
			selectSession(id);
		} catch (err) {
			showError(err);
		} finally {
			setStarting(false);
		}
	};
	if (!build) return null;
	if (build.state === "building") return <span className="muted remote-play">Building for the web: {build.step}…</span>;
	return (
		<span className="col remote-play" data-testid="remote-play">
			{build.state === "failed" && (
				<span className="msg error" title={build.error}>
					The build failed: {errorLine(build.error ?? "")}
				</span>
			)}
			{build.state === "ready" && (
				<span className="muted">
					Built {relativeTime(build.builtAt!)}
					{build.commit && build.head && build.commit !== build.head ? " · there's newer work since: rebuild to play it" : ""}
				</span>
			)}
			<span className="row remote-actions">
				<button onClick={start}>{build.state === "none" ? "Build to play" : build.state === "failed" ? "Try again" : "Rebuild"}</button>
				{build.state === "failed" && (
					<button className="primary" disabled={starting} onClick={fix} data-testid="remote-play-fix">
						{build.investigation ? "Open the fix session" : starting ? "Starting…" : "Ask an agent to fix it"}
					</button>
				)}
				{build.state === "ready" && (
					<a className="button primary" href={`/play/${encodeURIComponent(checkout)}/`} target="_blank" rel="noreferrer" data-testid="remote-play-open">
						▶ Play
					</a>
				)}
			</span>
		</span>
	);
}

function WorktreeList() {
	const { project, worktrees, sessions, openMerge, refreshWorktrees, showError, notify } = useStudio(
		useShallow((st) => ({ project: st.project, worktrees: st.worktrees, sessions: st.sessions, openMerge: st.openMerge, refreshWorktrees: st.refreshWorktrees, showError: st.showError, notify: st.notify })),
	);
	const [busy, setBusy] = useState<string | null>(null);
	const open = worktrees.filter(isOpenWorktree).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const update = async (id: string) => {
		setBusy(id);
		try {
			const r = await call("worktrees.update", id);
			notify(r.conflicts.length ? `Conflicts in ${r.conflicts.length} file(s): resolve them at the desktop` : r.commits ? `Brought in ${r.commits} commit(s) from main` : "Already up to date with main");
			await refreshWorktrees();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(null);
		}
	};
	return (
		<div className="remote-list">
			{project && (
				<div className="remote-row" data-testid="remote-main">
					<span className="remote-title">main</span>
					<span className="muted remote-meta">What's merged: the game as it stands</span>
					<PlayControls checkout="main" />
				</div>
			)}
			{open.length === 0 && <div className="muted remote-empty">No open worktrees: everything is merged.</div>}
			{open.map((w) => {
				const its = sessions.filter((s) => s.worktreeId === w.id);
				const working = its.filter((s) => s.status === "in_progress" || s.status === "starting").length;
				return (
					<div key={w.id} className="remote-row" data-testid="remote-worktree">
						<span className="row">
							<span className="grow ellipsis remote-title">⎇ {w.label}</span>
							<span className="badge">{w.target}</span>
						</span>
						<span className="muted remote-meta">
							{its.length} session{its.length === 1 ? "" : "s"}
							{working > 0 && `, ${working} working`} · {relativeTime(w.updatedAt)}
						</span>
						<span className="row remote-actions">
							<button disabled={busy === w.id} onClick={() => update(w.id)}>
								{busy === w.id ? "Updating…" : "Update from main"}
							</button>
							<button className="primary" onClick={() => openMerge(w.id)}>
								Merge…
							</button>
						</span>
						{w.target === "project" && <PlayControls checkout={w.id} />}
					</div>
				);
			})}
		</div>
	);
}

function Remote() {
	const { project, error, notice, newSession, merging, selectedSession, sessions, refresh, openNewSession, selectSession, loadTranscript } = useStudio(
		useShallow((st) => ({
			project: st.project,
			error: st.error,
			notice: st.notice,
			newSession: st.newSession,
			merging: st.merging,
			selectedSession: st.selectedSession,
			sessions: st.sessions,
			refresh: st.refresh,
			openNewSession: st.openNewSession,
			selectSession: st.selectSession,
			loadTranscript: st.loadTranscript,
		})),
	);
	const [tab, setTab] = useState<Tab>("sessions");
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const off = onEvent((e) => useStudio.getState().handleEvent(e));
		void refresh().finally(() => setReady(true));
		// Back after a dropped connection (a phone asleep, a tunnel): what was missed is read again.
		const offReconnect = onReconnect(() => {
			void refresh();
			const open = useStudio.getState().selectedSession;
			if (open) void loadTranscript(open);
		});
		return () => {
			off();
			offReconnect();
		};
	}, [refresh, loadTranscript]);

	const open = sessions.find((s) => s.id === selectedSession);
	const parent = open?.parentId;
	return (
		<div className="remote">
			<header className="remote-header row">
				{open ? (
					<button className="ghost" onClick={() => selectSession(parent ?? null)} data-testid="remote-back">
						‹ {parent ? "Parent" : "Sessions"}
					</button>
				) : (
					<span className="grow remote-project ellipsis">{project?.name ?? "Game Studio"}</span>
				)}
				{open && <span className="grow" />}
				<button className="primary" onClick={() => openNewSession({})} data-testid="remote-new">
					+ New
				</button>
			</header>
			{error && (
				<div className="error-bar">
					<span className="grow">{error}</span>
					<button className="ghost" onClick={() => useStudio.setState({ error: null })}>
						✕
					</button>
				</div>
			)}
			{!ready ? (
				<div className="muted remote-empty">Connecting to the studio…</div>
			) : open ? (
				<SessionDetail key={open.id} session={open} />
			) : (
				<>
					<nav className="row remote-tabs">
						{(["sessions", "worktrees"] as const).map((t) => (
							<button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
								{t === "sessions" ? "Sessions" : "Worktrees"}
							</button>
						))}
					</nav>
					{tab === "sessions" ? <SessionList /> : <WorktreeList />}
				</>
			)}
			{newSession && <NewSessionDialog preset={newSession} />}
			{merging && <MergeDialog key={merging} worktreeId={merging} />}
			<ImageViewer />
			{notice && <div className="toast">{notice}</div>}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Remote />
	</StrictMode>,
);
