import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { call } from "../api";
import { type SettingsTab, useStudio } from "../store";
import { AccountsPanel } from "./Accounts";
import { AppearanceSettings } from "./Appearance";
import { AssetGeneration } from "./Generation";
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

/** The agent types, which repos they work in, and the delegation graph: who each may hand tasks to. */
function AgentTypes() {
	const { agentTypes } = useStudio(useShallow((s) => ({ agentTypes: s.agentTypes })));
	const name = (id: string) => agentTypes.find((t) => t.id === id)?.name ?? id;
	const delegatedBy = (id: string) => agentTypes.filter((t) => t.delegatesTo?.includes(id)).map((t) => t.name);
	return (
		<div className="col" data-testid="agent-types">
			<p className="muted">
				Any of these can be started from New Session. Sessions delegate along these edges only (a type lists them as <code>delegatesTo</code> in its
				AGENT.md); the edges never form a loop.
			</p>
			{agentTypes.map((t) => (
				<div key={t.id} className="card col agent-type-card" data-testid="agent-type-card">
					<div className="row">
						<strong className="grow">{t.name}</strong>
						<span className="muted small">
							{t.targets.join(", ")} · {t.defaultModel ?? "any model"} · {t.source}
						</span>
					</div>
					<div className="muted small">{t.description}</div>
					<div className="small">
						<span className="muted">Delegates to: </span>
						{t.delegatesTo?.length ? t.delegatesTo.map(name).join(", ") : "nobody"}
						{delegatedBy(t.id).length > 0 && (
							<>
								<span className="muted"> · delegated to by </span>
								{delegatedBy(t.id).join(", ")}
							</>
						)}
					</div>
					{t.problems?.map((p) => (
						<div key={p} className="msg error small">
							{p}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
