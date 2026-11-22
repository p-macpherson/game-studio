import { useMemo, useState } from "react";
import type { Target } from "../../shared/types";
import { findAgentType } from "../../shared/agents";
import { call } from "../api";
import { type NewSessionPreset, useStudio } from "../store";
import { useShallow } from "zustand/react/shallow";
import { AgentGraph } from "./AgentTypes";

/** How New Session shows the agent types: cards, or the delegation graph (as in Settings → Agents). Remembered. */
const LAYOUT_KEY = "new-session-agents-layout";

const TARGET_LABEL: Record<Target, string> = { project: "Game project", engine: "Engine", studio: "Game Studio" };

export function NewSessionDialog({ preset }: { preset: NewSessionPreset }) {
	const { agentTypes, models, project, openNewSession, openSettings, selectSession, showError, selected, worktrees, selectWorktree } = useStudio(
		useShallow((s) => ({
			agentTypes: s.agentTypes,
			models: s.models,
			project: s.project,
			openNewSession: s.openNewSession,
			openSettings: s.openSettings,
			selectSession: s.selectSession,
			showError: s.showError,
			selected: s.selected,
			worktrees: s.worktrees,
			selectWorktree: s.selectWorktree,
		})),
	);
	const picked = worktrees.find((w) => w.id === selected);
	const [typeId, setTypeId] = useState(
		(preset.agentType && findAgentType(agentTypes, preset.agentType)?.id) ?? agentTypes.find((t) => t.id === "chief-director")?.id ?? agentTypes[0]?.id,
	);
	const type = agentTypes.find((t) => t.id === typeId);
	const targets = useMemo(() => (type?.targets ?? []).filter((t) => t !== "project" || project), [type, project]);
	const [target, setTarget] = useState<Target | undefined>(
		preset.target && targets.includes(preset.target) ? preset.target : picked && targets.includes(picked.target) ? picked.target : targets[0],
	);
	// The selected worktree, when it's in the repo this session works on.
	const currentWorktree = picked && picked.target === target ? picked : undefined;
	const defaultModel = (ref?: string) => (ref && models.some((m) => m.ref === ref) ? ref : models[0]?.ref);
	const [model, setModel] = useState(defaultModel(type?.defaultModel));
	const [prompt, setPrompt] = useState(preset.prompt ?? "");
	const [busy, setBusy] = useState(false);
	const [layout, setLayoutState] = useState<"list" | "graph">(() => (localStorage.getItem(LAYOUT_KEY) === "graph" ? "graph" : "list"));
	const setLayout = (l: "list" | "graph") => {
		localStorage.setItem(LAYOUT_KEY, l);
		setLayoutState(l);
	};

	const chooseType = (id: string) => {
		const next = agentTypes.find((t) => t.id === id);
		setTypeId(id);
		const nextTargets = (next?.targets ?? []).filter((t) => t !== "project" || project);
		if (!target || !nextTargets.includes(target)) setTarget(nextTargets[0]);
		setModel(defaultModel(next?.defaultModel));
	};

	const start = async () => {
		if (!type || !target || !model) return;
		setBusy(true);
		try {
			// Sessions work in the selected worktree when it's in their repo; otherwise they get a new one, which is selected.
			const inWorktree = currentWorktree ? { worktreeId: currentWorktree.id } : {};
			const s = await call("sessions.create", { agentType: type.id, target, model, prompt: prompt.trim(), linkedAsset: preset.linkedAsset, ...inWorktree });
			await useStudio.getState().refreshWorktrees();
			selectWorktree(s.worktreeId);
			openNewSession(null);
			selectSession(s.id);
		} catch (err) {
			showError(err);
			setBusy(false);
		}
	};

	return (
		<div className="modal-backdrop" onClick={() => openNewSession(null)}>
			<div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: layout === "graph" ? "min(1040px, 94vw)" : 680 }}>
				<h2>New session</h2>
				<div className="col">
					<div className="row">
						<h3 className="grow">Agent type</h3>
						<div className="segmented">
							<button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")} data-testid="new-session-layout-list">
								List
							</button>
							<button className={layout === "graph" ? "on" : ""} onClick={() => setLayout("graph")} data-testid="new-session-layout-graph">
								Graph
							</button>
						</div>
					</div>
					{layout === "graph" ? (
						<>
							<div className="new-session-graph">
								<AgentGraph types={agentTypes} models={models} picked={typeId ?? null} onPick={chooseType} />
							</div>
							{type && (
								<div className="small" data-testid="new-session-type-description">
									<strong>{type.name}</strong>
									<span className="muted">: {type.description}</span>
								</div>
							)}
						</>
					) : (
						<div className="agent-types">
							{agentTypes.map((t) => (
								<button key={t.id} className={`agent-type ${t.id === typeId ? "on" : ""}`} onClick={() => chooseType(t.id)}>
									<strong>{t.name}</strong>
									<small>{t.description}</small>
								</button>
							))}
						</div>
					)}
				</div>
				<div className="row">
					<label className="field grow">
						<span>Works on</span>
						<select value={target} onChange={(e) => setTarget(e.target.value as Target)}>
							{targets.map((t) => (
								<option key={t} value={t}>
									{TARGET_LABEL[t]}
								</option>
							))}
						</select>
					</label>
					<label className="field grow">
						<span>Model</span>
						<select value={model} onChange={(e) => setModel(e.target.value)}>
							{models.map((m) => (
								<option key={m.ref} value={m.ref}>
									{m.ref}
								</option>
							))}
						</select>
					</label>
				</div>
				{models.length === 0 && (
					<div className="msg error">
						No models available. Sign in to an AI account first:{" "}
						<button className="link" onClick={() => (openNewSession(null), openSettings("accounts"))}>
							Settings → Accounts
						</button>
					</div>
				)}
				{type && targets.length === 0 && <div className="msg error">{type.name} sessions need a game project open.</div>}
				<label className="field">
					<span>{preset.context ? <code>{preset.context}</code> : "What should the agent do?"}</span>
					<textarea
						data-testid="new-session-prompt"
						placeholder={preset.placeholder}
						rows={6}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						autoFocus
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void start();
						}}
					/>
				</label>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<span className="muted grow" style={{ fontSize: 12 }} data-testid="new-session-worktree">
						{currentWorktree ? `Works in worktree “${currentWorktree.label}”.` : "Starts a new worktree for it, named after the task."} Ctrl+Enter to start.
					</span>
					<button onClick={() => openNewSession(null)}>Cancel</button>
					<button className="primary" disabled={busy || !prompt.trim() || !target || !model} onClick={start}>
						{busy ? "Starting…" : "Start session"}
					</button>
				</div>
			</div>
		</div>
	);
}
