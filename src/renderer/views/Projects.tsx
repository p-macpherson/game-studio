import { useEffect, useRef, useState } from "react";
import type { RecentProject } from "../../shared/types";
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

/** The recent projects, read when `active` turns on and whenever the open project changes. */
function useRecent(active: boolean): [RecentProject[] | null, () => void] {
	const current = useStudio((s) => s.project?.path);
	const [recent, setRecent] = useState<RecentProject[] | null>(null);
	const [version, setVersion] = useState(0);
	useEffect(() => {
		if (!active) return;
		let live = true;
		call("project.recent").then((r) => live && setRecent(r), () => live && setRecent([]));
		return () => {
			live = false;
		};
	}, [active, current, version]);
	return [recent, () => setVersion((n) => n + 1)];
}

/** Opens another project; with agents at work in this one, only after the person agrees. */
function switchTo(path?: string): void {
	const s = useStudio.getState();
	const working = s.sessions.filter((x) => x.target === "project" && (x.status === "in_progress" || x.status === "starting")).length;
	if (s.project && working && !window.confirm(`${working} session${working > 1 ? "s are" : " is"} still working in “${s.project.name}”.\n\nIt's safer to let ${working > 1 ? "them" : "it"} finish, or stop ${working > 1 ? "them" : "it"}, before opening another project. Switch anyway?`)) return;
	void run(() => call("project.open", path));
}

/** One project on the recent list: its game's name over its folder; a missing one can only be taken off the list. */
function RecentRow({ p, current, onPick, onForget }: { p: RecentProject; current: boolean; onPick(): void; onForget(): void }) {
	const folder = p.path.slice(0, p.path.lastIndexOf("/")) || "/";
	return (
		<div className={`project-row ${current ? "current" : ""} ${p.exists ? "" : "missing"}`} data-testid="project-row" data-path={p.path}>
			<button className="project-row-open" disabled={current || !p.exists} onClick={onPick} title={p.exists ? (current ? `${p.path} (open now)` : `Open ${p.path}`) : `${p.path} isn't there any more (moved or deleted), or is no longer a Game Studio project`}>
				<span className="project-row-name ellipsis">{p.name}</span>
				<span className="project-row-path ellipsis">{p.exists ? folder : "not found"}</span>
			</button>
			{current ? (
				<span className="project-row-mark" aria-label="Open now">
					✓
				</span>
			) : (
				<button className="project-row-forget" onClick={onForget} title="Take it off this list (the folder isn't touched)" aria-label={`Take ${p.name} off the list`} data-testid="project-forget">
					✕
				</button>
			)}
		</div>
	);
}

export function ProjectPicker({ onSkip }: { onSkip(): void }) {
	const [creating, setCreating] = useState(false);
	const [recent, reload] = useRecent(true);
	return (
		<div className="picker">
			<div className="card">
				<h2>Game Studio</h2>
				<p className="muted">Open a game project, or start a new one.</p>
				<div className="row">
					<button className="primary" onClick={() => setCreating(true)}>
						New project…
					</button>
					<button onClick={() => switchTo()}>Open project…</button>
				</div>
				{recent && recent.length > 0 && (
					<div className="col" style={{ gap: 2 }}>
						<h3>Recent</h3>
						{recent.map((p) => (
							<RecentRow key={p.path} p={p} current={false} onPick={() => switchTo(p.path)} onForget={() => void run(() => call("project.forget", p.path)).then(reload)} />
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

/** The sidebar's project switcher: the open project's name is the button; its menu floats over the sidebar. */
export function ProjectMenu() {
	const project = useStudio((s) => s.project);
	const [open, setOpen] = useState(false);
	const [creating, setCreating] = useState(false);
	const [recent, reload] = useRecent(open);
	// The menu is wider than the sidebar (which clips what overflows it), so it is placed against the window.
	const button = useRef<HTMLButtonElement>(null);
	const [at, setAt] = useState({ left: 0, top: 0 });
	const toggle = () => {
		const r = button.current?.getBoundingClientRect();
		if (r) setAt({ left: r.left, top: r.bottom + 4 });
		setOpen(!open);
	};
	// Closes on a click anywhere else, and on Escape.
	useEffect(() => {
		if (!open) return;
		const click = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(".project, .project-menu") && setOpen(false);
		const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", click);
		document.addEventListener("keydown", key);
		return () => {
			document.removeEventListener("mousedown", click);
			document.removeEventListener("keydown", key);
		};
	}, [open]);
	const others = recent?.filter((p) => p.path !== project?.path) ?? [];
	const act = (what: () => void) => {
		setOpen(false);
		what();
	};
	return (
		<div className="project">
			<button ref={button} className={`project-current ${open ? "open" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open} title={project ? `${project.path}\nClick to switch project` : "Open or start a project"} data-testid="project-current">
				<span className="col grow" style={{ gap: 0, minWidth: 0 }}>
					<span className="project-name ellipsis">{project?.name ?? "No project"}</span>
					<span className="project-path ellipsis">{project?.path ?? "Engine and studio only"}</span>
				</span>
				<span className="muted" aria-hidden>
					▾
				</span>
			</button>
			{open && (
				<div className="card project-menu" role="menu" style={at} data-testid="project-menu">
					{project && (
						<>
							<div className="project-menu-label">Open now</div>
							<RecentRow p={{ ...project, exists: true }} current onPick={() => {}} onForget={() => {}} />
						</>
					)}
					{others.length > 0 && (
						<>
							<div className="project-menu-label">{project ? "Switch to" : "Recent projects"}</div>
							{others.map((p) => (
								<RecentRow key={p.path} p={p} current={false} onPick={() => act(() => switchTo(p.path))} onForget={() => void run(() => call("project.forget", p.path)).then(reload)} />
							))}
						</>
					)}
					<div className="project-menu-actions">
						<button className="ghost nav-item" onClick={() => act(() => setCreating(true))} data-testid="project-new">
							<span className="project-action-glyph" aria-hidden>
								+
							</span>
							New project…
						</button>
						<button className="ghost nav-item" onClick={() => act(() => switchTo())} data-testid="project-open">
							<span className="project-action-glyph" aria-hidden>
								📂
							</span>
							Open a project folder…
						</button>
						{project && (
							<button className="ghost nav-item" onClick={() => act(() => void run(() => call("project.close")))} data-testid="project-close">
								<span className="project-action-glyph" aria-hidden>
									✕
								</span>
								Close project
							</button>
						)}
					</div>
				</div>
			)}
			{creating && <NewProjectDialog onClose={() => setCreating(false)} />}
		</div>
	);
}
