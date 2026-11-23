import { useEffect, useRef, useState } from "react";
import type { RecentProject } from "../../shared/types";
import { call } from "../api";
import { useStudio } from "../store";
import { useShallow } from "zustand/react/shallow";

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

/** Fork: a new project from the open one's main branch. Says what comes along and what doesn't before it's made. */
function ForkProjectDialog({ project, onClose }: { project: { path: string; name: string }; onClose(): void }) {
	const parent = project.path.slice(0, project.path.lastIndexOf("/"));
	const [name, setName] = useState(`${project.name} 2`);
	const slug = (n: string) => n.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "fork";
	// The folder follows the name until the person picks or types one.
	const [folder, setFolder] = useState<string | null>(null);
	const path = folder ?? `${parent}/${slug(name)}`;
	const [open, setOpen] = useState(true);
	const [busy, setBusy] = useState(false);
	const [unsaved, setUnsaved] = useState(0);
	const { worktrees, working } = useStudio(
		useShallow((s) => ({
			worktrees: s.worktrees.filter((w) => w.target === "project" && w.status === "active").length,
			working: s.sessions.filter((x) => x.target === "project" && (x.status === "in_progress" || x.status === "starting")).length,
		})),
	);
	useEffect(() => {
		call("git.status", "project").then((s) => setUnsaved(s.files.filter((f) => !f.path.startsWith(".studio/")).length), () => {});
	}, []);
	const pick = async () => {
		const dir = await call("dialog.pickFolder", "Choose an empty folder for the fork");
		if (dir) setFolder(dir);
	};
	const fork = async () => {
		if (open && working && !window.confirm(`${working} session${working > 1 ? "s are" : " is"} still working in “${project.name}”. Opening the fork leaves this project. Fork and open it anyway?`)) return;
		setBusy(true);
		try {
			const made = await call("project.fork", path, name.trim(), open);
			if (!open) useStudio.getState().notify(`Forked “${project.name}” as “${made.name}” in ${made.path}`);
			onClose();
		} catch (err) {
			useStudio.getState().showError(err);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="modal-backdrop">
			<div className="modal" data-testid="fork-dialog">
				<h2>Fork “{project.name}”</h2>
				<p className="muted">
					Makes a separate project from what's on <b>main</b> now: its files, design docs, assets and history. The two are independent afterwards; nothing done in one reaches the
					other.
				</p>
				<ul className="muted fork-notes" data-testid="fork-notes">
					<li>
						{worktrees > 0 ? `The ${worktrees} open worktree${worktrees > 1 ? "s aren't" : " isn't"} copied` : "Worktrees aren't copied"}: merge one first if the fork should have its work.
					</li>
					<li>Sessions and their conversations stay with this project.</li>
					{unsaved > 0 && (
						<li className="fork-warning">
							{unsaved} uncommitted change{unsaved > 1 ? "s" : ""} in main {unsaved > 1 ? "aren't" : "isn't"} copied: commit {unsaved > 1 ? "them" : "it"} in Source Control first to bring {unsaved > 1 ? "them" : "it"} along.
						</li>
					)}
					<li>The fork has no remote: publish it from Source Control when you want one.</li>
				</ul>
				<label className="field">
					<span>Name of the new game</span>
					<input value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="fork-name" />
				</label>
				<label className="field">
					<span>Folder (new, or empty)</span>
					<div className="row">
						<input className="grow" value={path} onChange={(e) => setFolder(e.target.value)} data-testid="fork-path" />
						<button onClick={pick}>Browse…</button>
					</div>
				</label>
				<label className="row" style={{ gap: 8 }}>
					<input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} data-testid="fork-open" />
					Open the fork when it's ready
				</label>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button className="primary" disabled={!path.trim() || !name.trim() || busy} onClick={fork} data-testid="fork-confirm">
						{busy ? "Forking…" : "Fork project"}
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
	const [forking, setForking] = useState(false);
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
							<button className="ghost nav-item" onClick={() => act(() => setForking(true))} title="Make a separate project from this one's main branch" data-testid="project-fork">
								<span className="project-action-glyph" aria-hidden>
									⑂
								</span>
								Fork this project…
							</button>
						)}
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
			{forking && project && <ForkProjectDialog project={project} onClose={() => setForking(false)} />}
		</div>
	);
}
