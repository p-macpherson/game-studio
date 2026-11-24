import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { call } from "../api";
import { type SettingsTab, useStudio } from "../store";
import { AccountsPanel } from "./Accounts";
import { AgentTypes } from "./AgentTypes";
import { AppearanceSettings } from "./Appearance";
import { AssetGeneration } from "./Generation";
import { UpdatesCard } from "./Updates";
import { RemoteAccessCard } from "./RemoteAccess";
import { useShallow } from "zustand/react/shallow";

const TABS: { id: SettingsTab; label: string }[] = [
	{ id: "general", label: "General" },
	{ id: "appearance", label: "Appearance" },
	{ id: "accounts", label: "Accounts" },
	{ id: "agents", label: "Agents" },
];

const FIELDS: { key: "engineRepo" | "studioRepo" | "worktreeRoot"; label: string; help: string }[] = [
	{ key: "engineRepo", label: "Engine repository", help: "headless-game-engine checkout. Engine sessions branch from it, and new projects add it as a submodule." },
	{ key: "studioRepo", label: "Game Studio repository", help: "The game-studio checkout that studio sessions change." },
	{ key: "worktreeRoot", label: "Session worktrees", help: "Each session's git worktree lives under here, outside your repos." },
];

export function SettingsView() {
	const { settingsTab, openSettings } = useStudio(useShallow((s) => ({ settingsTab: s.settingsTab, openSettings: s.openSettings })));
	return (
		<div className="page">
			<h2>Settings</h2>
			<div className="tabs settings-tabs">
				{TABS.map((t) => (
					<button key={t.id} className={`tab ${settingsTab === t.id ? "active" : ""}`} onClick={() => openSettings(t.id)}>
						{t.label}
					</button>
				))}
			</div>
			{settingsTab === "accounts" ? (
				<AccountsPanel />
			) : settingsTab === "agents" ? (
				<AgentTypes />
			) : settingsTab === "appearance" ? (
				<AppearanceSettings />
			) : (
				<GeneralSettings />
			)}
		</div>
	);
}

function GeneralSettings() {
	const { settings, showError, refresh } = useStudio(useShallow((s) => ({ settings: s.settings, showError: s.showError, refresh: s.refresh })));
	const [draft, setDraft] = useState<Settings | null>(settings);
	const [host, setHost] = useState("");
	useEffect(() => setDraft(settings), [settings]);
	useEffect(() => {
		call("host.info").then((i) => setHost(`Pi ${i.piVersion} · Node ${i.node} · ${i.providers} providers`), showError);
	}, [showError]);
	if (!draft) return null;

	const dirty = FIELDS.some((f) => draft[f.key] !== settings?.[f.key]);
	const save = async () => {
		try {
			await call("settings.update", { engineRepo: draft.engineRepo, studioRepo: draft.studioRepo, worktreeRoot: draft.worktreeRoot });
			await refresh();
		} catch (err) {
			showError(err);
		}
	};

	return (
		<>
			<div className="card">
				{FIELDS.map((f) => (
					<label key={f.key} className="field">
						<span>{f.label}</span>
						<div className="row">
							<input className="grow" value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
							<button
								onClick={async () => {
									const dir = await call("dialog.pickFolder", f.label);
									if (dir) setDraft({ ...draft, [f.key]: dir });
								}}
							>
								Browse…
							</button>
						</div>
						<small className="muted">{f.help}</small>
					</label>
				))}
				<div className="row">
					<button className="primary" disabled={!dirty} onClick={save}>
						Save
					</button>
				</div>
			</div>
			<div className="card">
				<h3>Sessions</h3>
				<label className="row" style={{ gap: 8 }}>
					<input
						type="checkbox"
						checked={settings?.enterToSend ?? true}
						onChange={async (e) => {
							try {
								await call("settings.update", { enterToSend: e.target.checked });
								await refresh();
							} catch (err) {
								showError(err);
							}
						}}
						data-testid="settings-enter-to-send"
					/>
					Enter sends a message
				</label>
				<small className="muted">
					The default for new sessions: on, Enter sends and Shift+Enter starts a new line; off, Enter starts a new line. Ctrl+Enter (and Ctrl+Shift+Enter) always sends. Each session
					has its own toggle under its message box, and keeps the choice made there.
				</small>
			</div>
			<div className="card">
				<h3>Power</h3>
				<label className="row" style={{ gap: 8 }}>
					<input
						type="checkbox"
						checked={settings?.keepAwake ?? true}
						onChange={async (e) => {
							try {
								await call("settings.update", { keepAwake: e.target.checked });
								await refresh();
							} catch (err) {
								showError(err);
							}
						}}
						data-testid="settings-keep-awake"
					/>
					Keep the computer awake while agents are working
				</label>
				<small className="muted">
					While any session is in progress the computer won't go to sleep; once they're all idle, done or waiting for your answer, it sleeps again after however long your system is set
					to wait. The screen may still turn off and lock.
				</small>
			</div>
			<RemoteAccessCard />
			<UpdatesCard />
			<AssetGeneration />
			<div className="card">
				<h3>Session host</h3>
				<span className="muted" data-testid="host-info">
					{host || "starting…"}
				</span>
			</div>
		</>
	);
}

