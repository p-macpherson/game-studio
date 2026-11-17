import { useCallback, useEffect, useState } from "react";
import type { GitCommit, GitFileStatus, GitStatus, Target } from "../../shared/types";
import { call, relativeTime } from "../api";
import { useStudio } from "../store";
import { Diff } from "./Diff";

const SESSIONS_PREFIX = ".studio/sessions/";

function FileRow({ f, staged, selected, onSelect, onToggle, onDiscard }: {
	f: GitFileStatus;
	staged: boolean;
	selected: boolean;
	onSelect(): void;
	onToggle(): void;
	onDiscard?(): void;
}) {
	const code = staged ? f.index : f.worktree === "?" ? "?" : f.worktree;
	return (
		<div className={`row file-row ${selected ? "selected" : ""}`} onClick={onSelect}>
			<span className={`file-code code-${code}`}>{code === "?" ? "U" : code}</span>
			<span className="grow ellipsis" title={f.path}>
				{f.path}
			</span>
			{onDiscard && (
				<button className="ghost" title="Discard changes" onClick={(e) => (e.stopPropagation(), onDiscard())}>
					↺
				</button>
			)}
			<button className="ghost" title={staged ? "Unstage" : "Stage"} onClick={(e) => (e.stopPropagation(), onToggle())}>
				{staged ? "−" : "+"}
			</button>
		</div>
	);
}

export function SourceControl() {
	const { project, showError } = useStudio();
	const [target, setTarget] = useState<Target>(project ? "project" : "engine");
	const [status, setStatus] = useState<GitStatus | null>(null);
	const [commits, setCommits] = useState<GitCommit[]>([]);
	const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
	const [diff, setDiff] = useState("");
	const [message, setMessage] = useState("");
	const [engine, setEngine] = useState<{ pinned: string; latest: string; behind: number } | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(async () => {
		try {
			const [st, log] = await Promise.all([call("git.status", target), call("git.log", target, 15)]);
			setStatus(st);
			setCommits(log);
			setEngine(target === "project" ? await call("git.engineInfo") : null);
		} catch (err) {
			showError(err);
		}
	}, [target, showError]);

	useEffect(() => {
		void reload();
		setSelected(null);
	}, [reload]);

	useEffect(() => {
		if (selected) call("git.diff", target, selected.path, selected.staged).then(setDiff, showError);
		else setDiff("");
	}, [selected, target, showError]);

	const act = async (action: () => Promise<unknown>, confirmText?: string) => {
		if (confirmText && !window.confirm(confirmText)) return;
		setBusy(true);
		try {
			await action();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
			void reload();
		}
	};

	const files = status?.files ?? [];
	const staged = files.filter((f) => f.index !== "." && f.index !== "?");
	const unstaged = files.filter((f) => (f.worktree !== "." || f.index === "?") && !f.path.startsWith(SESSIONS_PREFIX));
	const sessionFiles = files.filter((f) => (f.worktree !== "." || f.index === "?") && f.path.startsWith(SESSIONS_PREFIX));
	const targets: Target[] = project ? ["project", "engine", "studio"] : ["engine", "studio"];

	const section = (title: string, list: GitFileStatus[], isStaged: boolean, discard: boolean) =>
		list.length > 0 && (
			<div className="col" style={{ gap: 2 }}>
				<div className="row">
					<h3 className="grow">
						{title} ({list.length})
					</h3>
					<button className="ghost" onClick={() => act(() => call(isStaged ? "git.unstage" : "git.stage", target, list.map((f) => f.path)))}>
						{isStaged ? "Unstage all" : "Stage all"}
					</button>
				</div>
				{list.map((f) => (
					<FileRow
						key={`${isStaged}-${f.path}`}
						f={f}
						staged={isStaged}
						selected={selected?.path === f.path && selected.staged === isStaged}
						onSelect={() => setSelected({ path: f.path, staged: isStaged })}
						onToggle={() => act(() => call(isStaged ? "git.unstage" : "git.stage", target, [f.path]))}
						onDiscard={discard ? () => act(() => call("git.discardFile", target, f.path), `Discard your changes to ${f.path}? This can't be undone.`) : undefined}
					/>
				))}
			</div>
		);

	return (
		<div className="sessions">
			<div className="session-list">
				<div className="toolbar">
					<div className="chips">
						{targets.map((t) => (
							<button key={t} className={`chip ${t === target ? "on" : ""}`} onClick={() => setTarget(t)}>
								{t === "project" ? project?.name : t === "engine" ? "Engine" : "Studio"}
							</button>
						))}
					</div>
					{status && (
						<div className="row">
							<code className="grow">⎇ {status.branch}</code>
							{status.upstream && (
								<span className="muted">
									↑{status.ahead} ↓{status.behind}
								</span>
							)}
							<button disabled={busy} onClick={() => act(() => call("git.pull", target), "Pull from the remote (fast-forward only)?")}>
								Pull
							</button>
							<button disabled={busy} onClick={() => act(() => call("git.push", target), `Push ${status.branch} to ${status.upstream ?? "the remote"}?`)}>
								Push
							</button>
						</div>
					)}
					<textarea rows={3} placeholder="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
					<button
						className="primary"
						disabled={busy || !message.trim() || staged.length === 0}
						onClick={() => act(async () => {
							await call("git.commit", target, message.trim());
							setMessage("");
						})}
					>
						Commit {staged.length} staged
					</button>
				</div>
				<div className="session-items" style={{ padding: 10 }}>
					<div className="col">
						{section("Staged", staged, true, false)}
						{section("Changes", unstaged, false, true)}
						{section("Studio sessions", sessionFiles, false, false)}
						{files.length === 0 && <div className="muted">Working tree clean.</div>}
						{engine && (
							<div className="card">
								<h3>Engine submodule</h3>
								<div className="muted">
									Pinned at <code>{engine.pinned.slice(0, 7)}</code>
									{engine.behind > 0 ? `, ${engine.behind} commit(s) behind the engine's main` : ", up to date"}
								</div>
								{engine.behind > 0 && (
									<button disabled={busy} onClick={() => act(() => call("git.updateEngine"), `Update the engine to ${engine.latest.slice(0, 7)} and commit?`)}>
										Update engine
									</button>
								)}
							</div>
						)}
						<h3>Recent commits</h3>
						{commits.map((c) => (
							<div key={c.hash} className="list-row" title={c.hash}>
								<code className="muted">{c.hash.slice(0, 7)}</code>
								<span className="grow ellipsis">{c.subject}</span>
								<span className="muted" style={{ fontSize: 11 }}>
									{relativeTime(c.date)}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="session-detail">
				<div className="tab-body">{selected ? <Diff text={diff} /> : <div className="empty">Select a file to see its diff.</div>}</div>
			</div>
		</div>
	);
}
