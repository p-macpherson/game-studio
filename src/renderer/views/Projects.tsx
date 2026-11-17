import { useState } from "react";
import { call } from "../api";
import { useStudio } from "../store";

async function run(action: () => Promise<unknown>) {
	try {
		await action();
	} catch (err) {
		useStudio.getState().showError(err);
	}
}

function NewProjectDialog({ onClose }: { onClose(): void }) {
	const [path, setPath] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const pick = async () => {
		const dir = await call("dialog.pickFolder", "Choose an empty folder (or empty git repo) for the project");
		if (dir) {
			setPath(dir);
			if (!name) setName(dir.split("/").pop() ?? "");
		}
	};
	const create = async () => {
		setBusy(true);
		await run(() => call("project.create", path, name.trim()));
		setBusy(false);
		onClose();
	};
	return (
		<div className="modal-backdrop">
			<div className="modal">
				<h2>New project</h2>
				<p className="muted">
					Creates a game from the Game Studio template, with design docs, an Odin game package, asset folders, and the engine as a
					git submodule, then makes the first commit.
				</p>
				<label className="field">
					<span>Folder (empty, or an empty git repo)</span>
					<div className="row">
						<input className="grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/…/my-game" />
						<button onClick={pick}>Browse…</button>
					</div>
				</label>
				<label className="field">
					<span>Game name</span>
					<input value={name} onChange={(e) => setName(e.target.value)} />
				</label>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={onClose}>Cancel</button>
					<button className="primary" disabled={!path || !name.trim() || busy} onClick={create}>
						{busy ? "Creating…" : "Create project"}
					</button>
				</div>
			</div>
		</div>
	);
}

export function ProjectPicker({ onSkip }: { onSkip(): void }) {
	const { settings } = useStudio();
	const [creating, setCreating] = useState(false);
	return (
		<div className="picker">
			<div className="card">
				<h2>Game Studio</h2>
				<p className="muted">Open a game project, or start a new one.</p>
				<div className="row">
					<button className="primary" onClick={() => setCreating(true)}>
						New project…
					</button>
					<button onClick={() => run(() => call("project.open"))}>Open project…</button>
				</div>
				{settings && settings.recentProjects.length > 0 && (
					<div className="col">
						<h3>Recent</h3>
						{settings.recentProjects.map((p) => (
							<div key={p} className="list-row file-row" onClick={() => run(() => call("project.open", p))}>
								{p}
							</div>
						))}
					</div>
				)}
				<button className="ghost" style={{ alignSelf: "flex-start" }} onClick={onSkip}>
					Continue without a project (engine and studio sessions only)
				</button>
			</div>
			{creating && <NewProjectDialog onClose={() => setCreating(false)} />}
		</div>
	);
}

export function ProjectMenu() {
	const { project, settings } = useStudio();
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	return (
		<div className="project">
			<div className="row">
				<div className="grow">
					<div className="project-name ellipsis">{project?.name ?? "No project"}</div>
					<div className="muted ellipsis" style={{ fontSize: 11 }} title={project?.path}>
						{project?.path ?? "Engine and studio only"}
					</div>
				</div>
				<button className="ghost" title="Projects" onClick={() => setOpen(!open)}>
					▾
				</button>
			</div>
			{open && (
				<div className="col card" style={{ marginTop: 8, padding: 8, gap: 2 }}>
					<button className="ghost nav-item" onClick={() => (setCreating(true), setOpen(false))}>
						New project…
					</button>
					<button className="ghost nav-item" onClick={() => (setOpen(false), run(() => call("project.open")))}>
						Open project…
					</button>
					{settings?.recentProjects
						.filter((p) => p !== project?.path)
						.map((p) => (
							<button key={p} className="ghost nav-item ellipsis" title={p} onClick={() => (setOpen(false), run(() => call("project.open", p)))}>
								{p.split("/").pop()}
							</button>
						))}
					{project && (
						<button className="ghost nav-item" onClick={() => (setOpen(false), run(() => call("project.close")))}>
							Close project
						</button>
					)}
				</div>
			)}
			{creating && <NewProjectDialog onClose={() => setCreating(false)} />}
		</div>
	);
}
