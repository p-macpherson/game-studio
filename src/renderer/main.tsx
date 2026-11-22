import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { onEvent } from "./api";
import { moduleOwns } from "../shared/modules";
import { MODULE_VIEWS } from "./modules";
import { type View, useStudio } from "./store";
import "./styles.css";
import { applyAppearance, loadAppearance } from "./appearance";
import { MergeDialog } from "./views/MergeDialog";
import { NewSessionDialog } from "./views/NewSession";
import { Play } from "./views/Play";
import { Release } from "./views/Release";
import { ProjectMenu, ProjectPicker } from "./views/Projects";
import { Sessions } from "./views/Sessions";
import { SettingsView } from "./views/Settings";
import { SourceControl } from "./views/SourceControl";
import { ChangeCountsLabel } from "./views/AssetBrowser";
import { WorktreePicker } from "./views/Worktrees";
import { WorktreesView } from "./views/WorktreeList";
import { useShallow } from "zustand/react/shallow";

/** The pages that aren't sections of the game (a section's label and icon come from its module). */
const PAGES: Partial<Record<View, { label: string; icon: string; needsProject?: boolean }>> = {
	sessions: { label: "Sessions", icon: "💬" },
	worktrees: { label: "Worktrees", icon: "🌿" },
	"source-control": { label: "Source Control", icon: "⎇" },
	play: { label: "Play & Test", icon: "▶", needsProject: true },
	release: { label: "Release", icon: "📦", needsProject: true },
};
/** The sidebar's groups, each collapsible (remembered). A section no group names lands in Game. */
const NAV_GROUPS: { id: string; label: string; views: View[] }[] = [
	{ id: "project", label: "Project", views: ["sessions", "worktrees", "source-control", "module:game-code"] },
	{ id: "game", label: "Game", views: ["module:design-docs", "module:scenes", "play", "release"] },
	{ id: "visual", label: "Visual", views: ["module:3d-models", "module:textures", "module:shaders", "module:effects", "module:ui"] },
	{ id: "audio", label: "Audio", views: ["module:music", "module:sounds", "module:voices"] },
];
const GROUPED = new Set(NAV_GROUPS.flatMap((g) => g.views));

function App() {
	const { project, view, setView, sessions, modules, error, refresh, handleEvent, newSession, run, worktreeChanges, notice, merging, selectedLabel, openWorktrees } = useStudio(
		useShallow((s) => ({
			openWorktrees: s.worktrees.filter((w) => w.status === "active").length,
			selectedLabel: s.worktrees.find((w) => w.id === s.selected)?.label ?? "main",
			project: s.project,
			view: s.view,
			setView: s.setView,
			sessions: s.sessions,
			modules: s.modules,
			error: s.error,
			refresh: s.refresh,
			handleEvent: s.handleEvent,
			newSession: s.newSession,
			run: s.run,
			worktreeChanges: s.worktreeChanges,
			notice: s.notice,
			merging: s.merging,
		})),
	);
	/** How many of a section's assets the selected worktree added, modified and removed. */
	const changesIn = (m: (typeof modules)[number]) => {
		const owned = worktreeChanges.filter((c) => moduleOwns(m, c.path));
		return { added: owned.filter((c) => c.change === "added").length, modified: owned.filter((c) => c.change === "modified").length, deleted: owned.filter((c) => c.change === "deleted").length };
	};
	const [ready, setReady] = useState(false);
	const [skipPicker, setSkipPicker] = useState(false);
	// The menu can shrink to an icon rail (labels become tooltips); remembered across launches.
	const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sidebar-collapsed") === "1");
	// The worktree bar along the bottom can be hidden (the button beside Collapse); remembered across launches.
	const [barHidden, setBarHidden] = useState(() => localStorage.getItem("worktree-bar-hidden") === "1");
	const toggleBar = () => {
		localStorage.setItem("worktree-bar-hidden", barHidden ? "0" : "1");
		setBarHidden(!barHidden);
	};
	// Which of the sidebar's groups are folded away; remembered across launches.
	const [folded, setFolded] = useState<string[]>(() => {
		try {
			const saved: unknown = JSON.parse(localStorage.getItem("nav-folded") ?? "[]");
			return Array.isArray(saved) ? saved.filter((x): x is string => typeof x === "string") : [];
		} catch {
			return [];
		}
	});
	const toggleGroup = (id: string) => {
		const next = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
		localStorage.setItem("nav-folded", JSON.stringify(next));
		setFolded(next);
	};
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
	/** A sidebar entry for a view (null: not offered now), and whether it has something to show for itself. */
	const navItem = (v: View): { el: React.ReactNode; busy: boolean } | null => {
		const mod = v.startsWith("module:") ? modules.find((x) => v === `module:${x.id}`) : undefined;
		const page = PAGES[v];
		if (v.startsWith("module:") ? !mod || !project : !page || (page.needsProject && !project)) return null;
		const label = mod?.name ?? page!.label;
		const changes = mod ? changesIn(mod) : null;
		const busy = v === "sessions" ? active > 0 : v === "play" ? run?.state === "running" : !!changes && changes.added + changes.modified + changes.deleted > 0;
		const el = (
			<button key={v} className={`nav-item ${view === v ? "active" : ""}`} title={label} aria-label={label} onClick={() => setView(v)}>
				<span className="nav-icon">{mod?.icon ?? page!.icon}</span>
				<span className="nav-label">{label}</span>
				{changes && <ChangeCountsLabel {...changes} />}
				{v === "sessions" && active > 0 && <span className="count">{active}</span>}
				{v === "worktrees" && openWorktrees > 0 && (
					<span className="count" data-testid="worktrees-count">
						{openWorktrees}
					</span>
				)}
				{v === "play" && run?.state === "running" && <span className="count">●</span>}
			</button>
		);
		return { el, busy };
	};
	return (
		<div className={`shell ${collapsed ? "collapsed" : ""}`}>
			<nav className="sidebar">
				{!collapsed && <ProjectMenu />}
				{NAV_GROUPS.map((g) => {
					const views = [...g.views, ...(g.id === "game" ? modules.map((x): View => `module:${x.id}`).filter((v) => !GROUPED.has(v)) : [])];
					const items = views.map(navItem).filter((x) => x !== null);
					if (!items.length) return null;
					// The rail (the collapsed sidebar) has no headers to unfold a group with, so it shows them all.
					const closed = !collapsed && folded.includes(g.id);
					return (
						<div key={g.id} className={`nav-group ${g.id === "project" ? "first" : ""}`} data-testid={`nav-group-${g.id}`}>
							<h3 className="nav-section">
								<button className="nav-section-toggle" aria-expanded={!closed} title={closed ? `Show ${g.label}` : `Hide ${g.label}`} onClick={() => toggleGroup(g.id)} data-testid={`nav-group-toggle-${g.id}`}>
									<span className="grow">{g.label}</span>
									{closed && items.some((i) => i.busy) && <span className="nav-section-dot" title="Something in here is active or changed" />}
									<span className="nav-section-caret">{closed ? "▸" : "▾"}</span>
								</button>
							</h3>
							{!closed && items.map((i) => i.el)}
						</div>
					);
				})}
				<div className="sidebar-bottom">
					<button className={`nav-item ${view === "settings" ? "active" : ""}`} title="Settings" aria-label="Settings" onClick={() => setView("settings")}>
						<span className="nav-icon">⚙</span>
						<span className="nav-label">Settings</span>
					</button>
					<div className="sidebar-toggles">
						<button
							className="nav-item grow"
							data-testid="sidebar-toggle"
							title={collapsed ? "Expand the menu" : "Collapse the menu"}
							aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}
							onClick={toggleSidebar}
						>
							<span className="nav-icon">{collapsed ? "»" : "«"}</span>
							<span className="nav-label">Collapse</span>
						</button>
						{project && (
							<button
								className={`nav-item bar-toggle ${barHidden ? "" : "on"}`}
								data-testid="worktree-bar-toggle"
								title={barHidden ? `Show the worktree bar (now: ${selectedLabel})` : "Hide the worktree bar"}
								aria-label={barHidden ? "Show the worktree bar" : "Hide the worktree bar"}
								aria-pressed={!barHidden}
								onClick={toggleBar}
							>
								<span className="nav-icon">⎇</span>
								{barHidden && selectedLabel !== "main" && <span className="count">●</span>}
							</button>
						)}
					</div>
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
				{view === "worktrees" && <WorktreesView />}
				{view === "source-control" && <SourceControl />}
				{view === "settings" && <SettingsView />}
				{view === "play" && project && <Play />}
				{view === "release" && project && <Release />}
				{activeModule && project && (() => {
					const ModuleView = MODULE_VIEWS[activeModule.id];
					return <ModuleView key={activeModule.id} module={activeModule} />;
				})()}
				{/* Kept mounted while hidden: it also publishes the worktree's changes for the sidebar's counts. */}
				<WorktreePicker hidden={barHidden} />
			</main>
			{newSession && <NewSessionDialog preset={newSession} />}
			{merging && <MergeDialog key={merging} worktreeId={merging} />}
			{notice && (
				<div className="toast" data-testid="notice">
					{notice}
				</div>
			)}
		</div>
	);
}

// The theme and fonts before the first paint, so the studio doesn't flash the default theme.
applyAppearance(loadAppearance());

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
