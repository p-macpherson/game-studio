import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { onEvent } from "./api";
import { moduleOwns } from "../shared/modules";
import { MODULE_VIEWS } from "./modules";
import { type View, useStudio } from "./store";
import "./styles.css";
import { NewSessionDialog } from "./views/NewSession";
import { Play } from "./views/Play";
import { ProjectMenu, ProjectPicker } from "./views/Projects";
import { Sessions } from "./views/Sessions";
import { SettingsView } from "./views/Settings";
import { SourceControl } from "./views/SourceControl";
import { WorktreePicker } from "./views/Worktrees";

const NAV: { view: View; label: string; icon: string }[] = [
	{ view: "sessions", label: "Sessions", icon: "💬" },
	{ view: "source-control", label: "Source Control", icon: "⎇" },
];

/** A section's changes in the selected worktree, in the change colours: new, modified, removed. */
function NavChanges({ added, modified, deleted }: { added: number; modified: number; deleted: number }) {
	if (!added && !modified && !deleted) return null;
	const title = [added && `${added} new`, modified && `${modified} modified`, deleted && `${deleted} removed`].filter(Boolean).join(", ");
	return (
		<span className="nav-changes" title={`In the selected worktree: ${title}`} data-testid="nav-changes">
			{added > 0 && <span className="change-added">{added}</span>}
			{modified > 0 && <span className="change-modified">{modified}</span>}
			{deleted > 0 && <span className="change-deleted">{deleted}</span>}
		</span>
	);
}

function App() {
	const { project, view, setView, sessions, modules, error, refresh, handleEvent, newSession, run, worktreeChanges } = useStudio();
	/** How many of a section's assets the selected worktree added, modified and removed. */
	const changesIn = (m: (typeof modules)[number]) => {
		const owned = worktreeChanges.filter((c) => moduleOwns(m, c.path));
		return { added: owned.filter((c) => c.change === "added").length, modified: owned.filter((c) => c.change === "modified").length, deleted: owned.filter((c) => c.change === "deleted").length };
	};
	const [ready, setReady] = useState(false);
	const [skipPicker, setSkipPicker] = useState(false);
	// The menu can shrink to an icon rail (labels become tooltips); remembered across launches.
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sidebar-collapsed") === "1");
	const toggleSidebar = () => {
		localStorage.setItem("sidebar-collapsed", collapsed ? "0" : "1");
		setCollapsed(!collapsed);
	};

	useEffect(() => {
		const off = onEvent((e) => useStudio.getState().handleEvent(e));
		refresh().finally(() => setReady(true));
		return off;
	}, [refresh, handleEvent]);

	if (!ready) return null;
	if (!project && !skipPicker) return <ProjectPicker onSkip={() => setSkipPicker(true)} />;

	const active = sessions.filter((s) => s.status !== "done").length;
	const activeModule = modules.find((m) => view === `module:${m.id}`);
	return (
		<div className={`shell ${collapsed ? "collapsed" : ""}`}>
			<nav className="sidebar">
				{!collapsed && <ProjectMenu />}
				<WorktreePicker />
				{NAV.map((n) => (
					<button key={n.view} className={`nav-item ${view === n.view ? "active" : ""}`} title={n.label} aria-label={n.label} onClick={() => setView(n.view)}>
						<span className="nav-icon">{n.icon}</span>
						<span className="nav-label">{n.label}</span>
						{n.view === "sessions" && active > 0 && <span className="count">{active}</span>}
					</button>
				))}
				{project && (
					<>
						<h3 className="nav-section">Game</h3>
						{modules.map((m) => (
							<button
								key={m.id}
								className={`nav-item ${view === `module:${m.id}` ? "active" : ""}`}
								title={m.name}
								aria-label={m.name}
								onClick={() => setView(`module:${m.id}`)}
							>
								<span className="nav-icon">{m.icon}</span>
								<span className="nav-label">{m.name}</span>
								<NavChanges {...changesIn(m)} />
							</button>
						))}
						<button className={`nav-item ${view === "play" ? "active" : ""}`} title="Play & Test" aria-label="Play & Test" onClick={() => setView("play")}>
							<span className="nav-icon">▶</span>
							<span className="nav-label">Play &amp; Test</span>
							{run?.state === "running" && <span className="count">●</span>}
						</button>
					</>
				)}
				<div className="sidebar-bottom">
					<button className={`nav-item ${view === "settings" ? "active" : ""}`} title="Settings" aria-label="Settings" onClick={() => setView("settings")}>
						<span className="nav-icon">⚙</span>
						<span className="nav-label">Settings</span>
					</button>
					<button
						className="nav-item"
						data-testid="sidebar-toggle"
						title={collapsed ? "Expand the menu" : "Collapse the menu"}
						aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
						onClick={toggleSidebar}
					>
						<span className="nav-icon">{collapsed ? "»" : "«"}</span>
						<span className="nav-label">Collapse</span>
					</button>
				</div>
			</nav>
			<main className="main">
				{error && (
					<div className="error-bar">
						<span className="grow">{error}</span>
						<button className="ghost" onClick={() => useStudio.setState({ error: null })}>
							✕
						</button>
					</div>
				)}
				{view === "sessions" && <Sessions />}
				{view === "source-control" && <SourceControl />}
				{view === "settings" && <SettingsView />}
				{view === "play" && project && <Play />}
				{activeModule && project && (() => {
					const ModuleView = MODULE_VIEWS[activeModule.id];
					return <ModuleView key={activeModule.id} module={activeModule} />;
				})()}
			</main>
			{newSession && <NewSessionDialog preset={newSession} />}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
