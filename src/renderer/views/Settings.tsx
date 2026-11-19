import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { call } from "../api";
import { useStudio } from "../store";
import { AssetGeneration } from "./Generation";

const FIELDS: { key: "engineRepo" | "studioRepo" | "worktreeRoot"; label: string; help: string }[] = [
	{ key: "engineRepo", label: "Engine repository", help: "headless-game-engine checkout. Engine sessions branch from it, and new projects add it as a submodule." },
	{ key: "studioRepo", label: "Game Studio repository", help: "The game-studio checkout that studio sessions change." },
	{ key: "worktreeRoot", label: "Session worktrees", help: "Each session's git worktree lives under here, outside your repos." },
];

export function SettingsView() {
	const { settings, showError, refresh } = useStudio();
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
		<div className="page">
			<h2>Settings</h2>
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
		</div>
	);
}
