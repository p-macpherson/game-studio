import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { onEvent } from "./api";
import { type View, useStudio } from "./store";
import "./styles.css";
import { Accounts } from "./views/Accounts";
import { NewSessionDialog } from "./views/NewSession";
import { ProjectMenu, ProjectPicker } from "./views/Projects";
import { Sessions } from "./views/Sessions";
import { SettingsView } from "./views/Settings";
import { SourceControl } from "./views/SourceControl";

const NAV: { view: View; label: string; icon: string }[] = [
	{ view: "sessions", label: "Sessions", icon: "💬" },
	{ view: "source-control", label: "Source Control", icon: "⎇" },
	{ view: "accounts", label: "Accounts", icon: "🔑" },
	{ view: "settings", label: "Settings", icon: "⚙" },
];

function App() {
	const { project, view, setView, sessions, error, refresh, handleEvent, newSession } = useStudio();
	const [ready, setReady] = useState(false);
	const [skipPicker, setSkipPicker] = useState(false);

	useEffect(() => {
		const off = onEvent((e) => useStudio.getState().handleEvent(e));
		refresh().finally(() => setReady(true));
		return off;
	}, [refresh, handleEvent]);

	if (!ready) return null;
	if (!project && !skipPicker) return <ProjectPicker onSkip={() => setSkipPicker(true)} />;

	const active = sessions.filter((s) => s.status !== "done").length;
	return (
		<div className="shell">
			<nav className="sidebar">
				<ProjectMenu />
				{NAV.map((n) => (
					<button key={n.view} className={`nav-item ${view === n.view ? "active" : ""}`} onClick={() => setView(n.view)}>
						<span>{n.icon}</span>
						{n.label}
						{n.view === "sessions" && active > 0 && <span className="count">{active}</span>}
					</button>
				))}
				<h3 className="nav-section">Game</h3>
				<div className="muted" style={{ padding: "0 10px", fontSize: 12 }}>
					Design Docs, 3D Models, Music… arrive as modules from M2.
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
				{view === "accounts" && <Accounts />}
				{view === "settings" && <SettingsView />}
			</main>
			{newSession && <NewSessionDialog />}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
