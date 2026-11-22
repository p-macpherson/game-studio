// Release: shipping the game to players. A list of releases (release.json: one per version); the picked release has a
// tab per platform (build it on demand, run it, see its checks, publish it to itch.io) and a tab for what ships.
// Builds come from the checkout the worktree bar selects. A build that fails, drags on or ends with failed checks can
// be handed to a session to look into (a failed one is, by itself).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
	DEFAULT_ITCH_CHANNEL,
	RELEASE_SLOW_SECONDS,
	RELEASE_TARGET_LABEL as TARGET_LABEL,
	RELEASE_TARGETS,
	type ReleaseBuild,
	type ReleaseBuilding,
	type ReleaseConfig,
	type ReleaseInfo,
	type ReleaseManifest,
	type ReleaseTarget,
} from "../../shared/release";
import { call, onEvent } from "../api";
import { useStudio } from "../store";
import { runInWorktree } from "../workspace";

export function mb(bytes: number): string {
	return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function duration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

type Tab = ReleaseTarget | "files";
type Mode = { kind: "view" } | { kind: "new" } | { kind: "edit"; version: string };
/** How a release's build for a platform stands. */
type Standing = "none" | "building" | "ok" | "checks" | "failed";

const MARK: Record<Standing, { text: string; cls: string; title: string }> = {
	none: { text: "–", cls: "muted", title: "not built" },
	building: { text: "…", cls: "release-mark-building", title: "building now" },
	ok: { text: "✓", cls: "ok-mark", title: "built, every check passed" },
	checks: { text: "!", cls: "release-mark-warn", title: "built, with failed checks" },
	failed: { text: "✗", cls: "bad-mark", title: "the build failed" },
};

export function Release() {
	const { worktree, worktrees, showError, assetsVersion, openSettings, selectSession } = useStudio(
		useShallow((s) => ({ worktree: s.worktree, worktrees: s.worktrees, showError: s.showError, assetsVersion: s.assetsVersion, openSettings: s.openSettings, selectSession: s.selectSession })),
	);
	const [info, setInfo] = useState<ReleaseInfo | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const [mode, setMode] = useState<Mode>({ kind: "view" });
	const [tab, setTab] = useState<Tab>("linux");
	const [publishLog, setPublishLog] = useState<string[]>([]);
	/** An upload is running: its progress goes to the tab's publish log (a build's goes to the build itself). */
	const publishing = useRef(false);
	const checkout = worktree ?? "main";

	const reload = useCallback(async () => {
		try {
			setInfo(await call("release.info", worktree));
		} catch (err) {
			showError(err);
		}
	}, [worktree, showError]);

	useEffect(() => void reload(), [reload, assetsVersion]);
	useEffect(
		() =>
			onEvent((e) => {
				if (e.type === "release_changed") void reload();
				if (e.type !== "release_progress") return;
				if (publishing.current) setPublishLog((l) => [...l.slice(-100), e.text]);
				else setInfo((i) => (i?.building && i.building.version === e.version && i.building.target === e.target ? { ...i, building: { ...i.building, log: [...i.building.log, e.text] } } : i));
			}),
		[reload],
	);

	/** Every version there is something for: release.json's releases, then versions that only have builds. */
	const rows = useMemo(() => {
		if (!info) return [];
		const listed = info.releases.map((config) => ({ config, listed: true }));
		const extra = [...new Set(info.builds.map((b) => b.version))]
			.filter((v) => !info.releases.some((r) => r.version === v))
			.map((v) => ({ config: { ...info.suggested, version: v, include: [], exclude: [], itch: undefined }, listed: false }));
		return [...listed, ...extra];
	}, [info]);
	const current = rows.find((r) => r.config.version === picked) ?? rows[0] ?? null;
	const version = current?.config.version ?? null;
	const label = worktree ? (worktrees.find((w) => w.id === worktree)?.label ?? worktree) : "main";

	if (!info) return <div className="page muted">Loading…</div>;

	const buildOf = (v: string, t: ReleaseTarget) => info.builds.find((b) => b.version === v && b.target === t);
	const buildingHere = (v: string, t: ReleaseTarget) => !!info.building && info.building.checkout === checkout && info.building.version === v && info.building.target === t;
	const standing = (v: string, t: ReleaseTarget): Standing => {
		if (buildingHere(v, t)) return "building";
		const b = buildOf(v, t);
		return !b ? "none" : b.error ? "failed" : b.ok ? "ok" : "checks";
	};

	/** release.json changes are a person's edit in a worktree (a new one when main is shown), undoable and saved there. */
	const save = async (config: ReleaseConfig, replaces?: string) => {
		try {
			await runInWorktree(replaces ? "Release settings" : `Release ${config.version}`, "save_release", { config, ...(replaces ? { replaces } : {}) });
			setPicked(config.version);
			setMode({ kind: "view" });
			await reload();
			return true;
		} catch (err) {
			showError(err);
			return false;
		}
	};

	const remove = async (row: { config: ReleaseConfig; listed: boolean }) => {
		const v = row.config.version;
		const builds = info.builds.filter((b) => b.version === v);
		const ok = window.confirm(
			`Delete release ${v}?\n\n` +
				(builds.length ? `Its ${builds.length === 1 ? "build is" : `${builds.length} builds are`} removed from this computer (builds/${v}/) and can't be brought back.\n` : "") +
				(row.listed ? "The release leaves release.json; until that edit is saved, Undo brings its settings back." : ""),
		);
		if (!ok) return;
		try {
			// The builds are in the checkout shown now; the release.json edit may open a new worktree and switch to it.
			await call("release.deleteBuilds", worktree, v);
			if (row.listed) await runInWorktree(`Delete release ${v}`, "delete_release", { version: v });
			setPicked(null);
			await reload();
		} catch (err) {
			showError(err);
		}
	};

	const build = async (t: ReleaseTarget) => {
		if (!version) return;
		setPublishLog([]);
		try {
			await call("release.build", worktree, version, t);
		} catch {
			// A failed build shows in its tab (with the session looking into it), not as an error bar.
		} finally {
			await reload();
		}
	};

	const investigate = async (t: ReleaseTarget) => {
		if (!version) return;
		try {
			const id = await call("release.investigate", worktree, version, t);
			await useStudio.getState().refreshSessions();
			selectSession(id);
		} catch (err) {
			showError(err);
		}
	};

	const publish = async (b: ReleaseBuild) => {
		if (!current) return;
		const itch = current.config.itch;
		if (!itch?.target) return showError(new Error("Set the itch.io page (user/game) in the release's settings first"));
		if (!info.itchKey) {
			openSettings("accounts");
			return showError(new Error("Add your itch.io API key under Settings → Accounts first"));
		}
		const channel = itch.channels?.[b.target] ?? DEFAULT_ITCH_CHANNEL[b.target];
		const ok = window.confirm(
			`Upload ${current.config.name} ${b.version} for ${TARGET_LABEL[b.target]} to itch.io?\n\n` +
				`Page: https://${itch.target.split("/")[0]}.itch.io/${itch.target.split("/")[1]}\nChannel: ${channel}\n\n` +
				"Anyone who can see the page can download it once it's uploaded (keep the page restricted or a draft until it's ready)." +
				(b.target === "web" ? "\n\nThe first time, tick \"This file will be played in the browser\" for the upload on the page's edit screen (and set the page's kind to HTML)." : ""),
		);
		if (!ok) return;
		setPublishLog([]);
		publishing.current = true;
		try {
			await call("release.publish", worktree, b.version, b.target);
		} catch (err) {
			showError(err);
		} finally {
			publishing.current = false;
		}
	};

	const editing = mode.kind === "edit" ? rows.find((r) => r.config.version === mode.version) : undefined;
	return (
		<div className="sessions release" data-testid="release">
			<div className="session-list">
				<div className="toolbar">
					<div className="row">
						<strong className="grow">Releases</strong>
						<button className="primary" onClick={() => setMode({ kind: "new" })} data-testid="release-new">
							+ New release
						</button>
					</div>
					<span className="muted small">Built from {label}</span>
				</div>
				<div className="session-items">
					{rows.length === 0 && <div className="empty">No releases yet.</div>}
					{rows.map((r) => (
						<div
							key={r.config.version}
							className={`session-item ${mode.kind === "view" && r.config.version === version ? "selected" : ""}`}
							onClick={() => {
								setPicked(r.config.version);
								setMode({ kind: "view" });
							}}
							data-testid="release-item"
						>
							<div className="row">
								<span className="title grow ellipsis">
									{r.listed ? r.config.name : "Builds"} {r.config.version}
								</span>
								{!r.listed && (
									<span className="badge" title="There are builds of this version, but release.json has no release for it">
										builds only
									</span>
								)}
							</div>
							<div className="row release-marks">
								{RELEASE_TARGETS.map((t) => {
									const m = MARK[standing(r.config.version, t)];
									return (
										<span key={t} className="small" title={`${TARGET_LABEL[t]}: ${m.title}`}>
											<span className={m.cls}>{m.text}</span> <span className="muted">{TARGET_LABEL[t]}</span>
										</span>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</div>

			<div className="session-detail">
				{mode.kind === "new" || editing ? (
					<ReleaseForm
						key={mode.kind === "new" ? "new" : editing!.config.version}
						start={mode.kind === "new" ? info.suggested : editing!.config}
						isNew={mode.kind === "new"}
						hasBuilds={!!editing && info.builds.some((b) => b.version === editing.config.version)}
						taken={info.releases.map((r) => r.version).filter((v) => v !== editing?.config.version)}
						checkout={worktree}
						itchKey={info.itchKey}
						onSave={(c) => save(c, editing?.config.version)}
						onCancel={() => setMode({ kind: "view" })}
					/>
				) : !current ? (
					<div className="empty col release-empty">
						<div>A release is a version of the game for players: you name it, then build it for Linux, Windows or the web whenever you want one.</div>
						<div>
							<button className="primary" onClick={() => setMode({ kind: "new" })}>
								+ New release
							</button>
						</div>
					</div>
				) : (
					<>
						<div className="session-header">
							<div className="row">
								<strong className="grow release-title" data-testid="release-title">
									{current.listed ? current.config.name : "Builds"} {current.config.version}
								</strong>
								{current.listed && (
									<button onClick={() => setMode({ kind: "edit", version: current.config.version })} data-testid="release-edit">
										Settings
									</button>
								)}
								<button className="danger" onClick={() => remove(current)} data-testid="release-delete">
									Delete…
								</button>
							</div>
							{!current.listed && <div className="muted small">release.json has no release {current.config.version} (an agent built it, or the release was deleted): these builds can be run or deleted, not rebuilt.</div>}
							{info.problems.map((p) => (
								<div key={p} className="bad-text small">
									release.json: {p}
								</div>
							))}
							<div className="tabs">
								{RELEASE_TARGETS.map((t) => {
									const m = MARK[standing(current.config.version, t)];
									return (
										<button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)} data-testid={`release-tab-${t}`} title={m.title}>
											{TARGET_LABEL[t]} <span className={m.cls}>{m.text}</span>
										</button>
									);
								})}
								{current.listed && (
									<button className={`tab ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")} data-testid="release-tab-files">
										What ships
									</button>
								)}
							</div>
						</div>
						<div className="tab-body release-body">
							{tab === "files" && current.listed ? (
								<ShippedFiles key={current.config.version} checkout={worktree} config={current.config} version={assetsVersion} onSave={(c) => save(c, current.config.version)} />
							) : (
								<PlatformTab
									key={`${current.config.version}-${tab}`}
									config={current.config}
									listed={current.listed}
									target={tab === "files" ? "linux" : tab}
									build={buildOf(current.config.version, tab === "files" ? "linux" : tab)}
									building={info.building}
									mine={buildingHere(current.config.version, tab === "files" ? "linux" : tab)}
									info={info}
									publishLog={publishLog}
									onBuild={build}
									onInvestigate={investigate}
									onOpenSession={selectSession}
									onPublish={publish}
									onRun={(b) => call("release.run", worktree, b.version, b.target).catch(showError)}
									onReveal={(b) => call("release.reveal", worktree, b.version, b.target).catch(showError)}
								/>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/** One platform of a release: nothing built yet, building now, failed, or built (run it, its output, rebuild). */
function PlatformTab(p: {
	config: ReleaseConfig;
	listed: boolean;
	target: ReleaseTarget;
	build?: ReleaseBuild;
	building: ReleaseBuilding | null;
	/** The build running now is this one. */
	mine: boolean;
	info: ReleaseInfo;
	publishLog: string[];
	onBuild(t: ReleaseTarget): void;
	onInvestigate(t: ReleaseTarget): void;
	onOpenSession(id: string): void;
	onPublish(b: ReleaseBuild): void;
	onRun(b: ReleaseBuild): void;
	onReveal(b: ReleaseBuild): void;
}) {
	const { config, target, build, building, mine, info } = p;
	const name = TARGET_LABEL[target];
	// Only one build runs at a time, in any checkout.
	const busy = !!building;
	const cantBuild = !p.listed ? "release.json has no release for this version" : target === "web" && !info.tools.web ? "This game's engine can't build for the web yet: update the engine first" : busy ? `Wait for the ${TARGET_LABEL[building!.target]} build of ${building!.version} to finish` : undefined;
	const notes = (
		<>
			{target === "windows" && !info.tools.wine && <div className="muted small">Wine isn't installed: a Windows build is made but can't be checked here.</div>}
			{target === "web" && !info.tools.web && <div className="bad-text small">This game's engine can't build for the web yet: update the engine first.</div>}
			{target === "web" && info.tools.web && <div className="muted small">The web build runs in a browser (WebGL 2). Multiplayer and saved files don't work there yet.</div>}
		</>
	);
	const session = (id: string | undefined, ask: string) =>
		id ? (
			<button onClick={() => p.onOpenSession(id)} data-testid="release-session">
				Open the session looking into it
			</button>
		) : (
			<button onClick={() => p.onInvestigate(target)} data-testid="release-investigate">
				{ask}
			</button>
		);

	if (mine && building) return <Building building={building} name={name} session={session} />;

	if (!build) {
		return (
			<div className="release-pane col" data-testid="release-none">
				<div className="release-state">
					<strong>
						No {name} build of {config.version} yet
					</strong>
					<span className="muted">Building compiles the game for players, packages only the files it uses, and checks the package: it starts from its own folder and passes the game's tests.</span>
					<div className="row">
						<button className="primary" disabled={!!cantBuild} title={cantBuild} onClick={() => p.onBuild(target)} data-testid="release-build">
							Build for {name}
						</button>
						{busy && <span className="muted small">{cantBuild}</span>}
					</div>
					{notes}
				</div>
			</div>
		);
	}

	const failedChecks = build.checks.filter((c) => !c.ok);
	const tone = build.error ? "failed" : build.ok ? "ok" : "checks";
	return (
		<div className="release-pane col" data-testid="release-built" data-standing={tone}>
			<div className={`release-state ${tone}`}>
				<div className="row">
					<strong className="grow" data-testid="release-status">
						{build.error ? `The ${name} build failed` : build.ok ? `${name} build: every check passed` : `${name} build: ${failedChecks.length === 1 ? "1 check" : `${failedChecks.length} checks`} failed`}
					</strong>
					{!build.error && (
						<>
							<button title={target === "web" ? "Opens it in your browser" : undefined} onClick={() => p.onRun(build)} data-testid="release-run">
								Run
							</button>
							<button onClick={() => p.onReveal(build)} data-testid="release-reveal">
								Open folder
							</button>
							<button className="primary" data-testid="release-publish" disabled={!build.ok} title={build.ok ? undefined : "Only a build whose checks passed can be published"} onClick={() => p.onPublish(build)}>
								Publish to itch.io
							</button>
						</>
					)}
					<button disabled={!!cantBuild} title={cantBuild} onClick={() => p.onBuild(target)} data-testid="release-rebuild">
						Rebuild
					</button>
				</div>
				<span className="muted small">
					{new Date(build.builtAt).toLocaleString()}
					{build.seconds !== undefined && ` · took ${duration(build.seconds)}`}
					{!build.error && ` · ${build.files === 1 ? "1 file" : `${build.files} files`} · ${mb(build.bytes)}`}
				</span>
				{!build.ok && (
					<div className="row release-help">
						<span className="grow">
							{build.error
								? build.investigation
									? "A session was started to find out why and fix it."
									: "No package was made."
								: build.investigation
									? "A session is looking into the failed checks."
									: "The package was made, but it isn't ready to publish."}
						</span>
						{session(build.investigation, "Have a session investigate")}
					</div>
				)}
				{notes}
			</div>

			<h4 className="release-heading">Build output</h4>
			{build.error && (
				<pre className="test-output release-error" data-testid="release-error">
					{build.error}
				</pre>
			)}
			{build.checks.length > 0 && (
				<div className="release-checks" data-testid="release-checks">
					{build.checks.map((c) => (
						<div key={c.name} className="release-check">
							<span className={c.ok ? "ok-mark" : "bad-mark"}>{c.ok ? "✓" : "✗"}</span> <span>{c.name}</span>
							{!c.ok || c.name.startsWith("Runs") || c.name === "AppImage" ? <span className="muted small"> — {c.detail.split("\n")[0]}</span> : null}
							{!c.ok && c.detail.includes("\n") && <pre className="test-output">{c.detail}</pre>}
						</div>
					))}
				</div>
			)}
			{build.archives.length > 0 && <div className="muted small">Made: {build.archives.map((a) => a.slice(a.lastIndexOf("/") + 1)).join(" · ")}</div>}
			{!!build.log?.length && (
				<details className="release-steps">
					<summary className="muted small">Steps ({build.log.length})</summary>
					<pre className="test-output">{build.log.join("\n")}</pre>
				</details>
			)}
			{p.publishLog.length > 0 && (
				<pre className="test-output release-log" data-testid="release-log">
					{p.publishLog.join("\n")}
				</pre>
			)}
		</div>
	);
}

/** A build in progress: what it's doing, for how long, and once that is long, a session to look into it. */
function Building({ building, name, session }: { building: ReleaseBuilding; name: string; session(id: string | undefined, ask: string): React.ReactNode }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = (now - Date.parse(building.startedAt)) / 1000;
	const slow = seconds >= RELEASE_SLOW_SECONDS;
	const step = building.log[building.log.length - 1] ?? "Starting";
	return (
		<div className="release-pane col" data-testid="release-building">
			<div className={`release-state building ${slow ? "slow" : ""}`}>
				<div className="row">
					<span className="spinner release-spinner" />
					<strong className="grow">
						Building {building.version} for {name}…
					</strong>
					<span className="release-elapsed" data-testid="release-elapsed">
						{duration(seconds)}
					</span>
				</div>
				<div className="release-bar">
					<div />
				</div>
				<span>
					Now: <b>{step}</b>
				</span>
				{slow && (
					<div className="row release-help">
						<span className="grow">This is taking longer than a build usually does. It may still finish: the game's tests run against the package, and a long test holds it up.</span>
						{session(building.investigation, "Have a session investigate")}
					</div>
				)}
			</div>
			<h4 className="release-heading">Steps so far</h4>
			<pre className="test-output release-log" data-testid="release-log">
				{building.log.length ? building.log.join("\n") : "Starting…"}
			</pre>
		</div>
	);
}

/** A release's settings: for a new one, or to change one. */
function ReleaseForm(p: {
	start: ReleaseConfig;
	isNew: boolean;
	hasBuilds: boolean;
	taken: string[];
	checkout: string | null;
	itchKey: boolean;
	onSave(config: ReleaseConfig): Promise<boolean>;
	onCancel(): void;
}) {
	const [draft, setDraft] = useState<ReleaseConfig>(p.start);
	const [pngs, setPngs] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		// The icon is picked from the project's PNGs: any release's file list has them all (shipped or left out).
		call("release.manifest", p.checkout, p.start.version)
			.then((m) => setPngs([...m.files, ...m.leftOut].map((f) => f.path.replace(/^assets\//, "")).filter((f) => f.endsWith(".png") && !/(^|\/)(candidates|concepts|source)\//.test(f))))
			.catch(() => setPngs([]));
	}, [p.checkout, p.start.version]);
	const set = (patch: Partial<ReleaseConfig>) => setDraft({ ...draft, ...patch });
	const version = draft.version.trim();
	const problem = !draft.name.trim()
		? "Give it the game's name"
		: !/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)
			? "The version must be like 1.0.0"
			: p.taken.includes(version)
				? `There's already a release ${version}`
				: draft.itch?.target && !/^[\w-]+\/[\w-]+$/.test(draft.itch.target)
					? "The itch.io page must be user/game"
					: "";
	const submit = async () => {
		setSaving(true);
		await p.onSave({ ...draft, name: draft.name.trim(), version });
		setSaving(false);
	};
	return (
		<div className="release-pane col" data-testid="release-form">
			<strong className="release-title">{p.isNew ? "New release" : `Release ${p.start.version}: settings`}</strong>
			<span className="muted">{p.isNew ? "Name the version. You build it for Linux, Windows or the web afterwards, whichever you want." : "These apply to builds made from now on."}</span>
			<div className="release-settings col">
				<label className="field-row">
					<span className="field-name">Name</span>
					<input value={draft.name} onChange={(e) => set({ name: e.target.value })} data-testid="release-name" />
				</label>
				<label className="field-row">
					<span className="field-name">Version</span>
					<input data-testid="release-version" value={draft.version} disabled={p.hasBuilds} title={p.hasBuilds ? "It has builds under this version: make a new release for another version" : undefined} onChange={(e) => set({ version: e.target.value })} placeholder="1.0.0" />
				</label>
				<label className="field-row">
					<span className="field-name">Icon</span>
					<select value={draft.icon ?? ""} onChange={(e) => set({ icon: e.target.value || undefined })}>
						<option value="">None</option>
						{[...new Set([...(draft.icon ? [draft.icon] : []), ...pngs])].map((f) => (
							<option key={f} value={f}>
								{f}
							</option>
						))}
					</select>
				</label>
				<label className="field-row">
					<span className="field-name">itch.io page</span>
					<input data-testid="release-itch" value={draft.itch?.target ?? ""} placeholder="user/game (optional)" onChange={(e) => set({ itch: e.target.value ? { ...draft.itch, target: e.target.value.trim() } : undefined })} />
				</label>
			</div>
			<span className="muted small">{p.itchKey ? "An itch.io key is saved, so a passing build can be published." : "No itch.io key: add one under Settings → Accounts to publish."}</span>
			<div className="row">
				<button className="primary" disabled={!!problem || saving} title={problem || undefined} onClick={submit} data-testid="release-save">
					{p.isNew ? "Create release" : "Save"}
				</button>
				<button onClick={p.onCancel}>Cancel</button>
				{problem && <span className="bad-text small">{problem}</span>}
			</div>
		</div>
	);
}

/** Which asset files a release ships and which it leaves out, with why; a file can be forced either way. */
function ShippedFiles({ checkout, config, version, onSave }: { checkout: string | null; config: ReleaseConfig; version: number; onSave(config: ReleaseConfig): Promise<boolean> }) {
	const showError = useStudio((s) => s.showError);
	const [manifest, setManifest] = useState<ReleaseManifest | null>(null);
	const [side, setSide] = useState<"ships" | "left">("ships");
	const [filter, setFilter] = useState("");
	useEffect(() => {
		call("release.manifest", checkout, config.version).then(setManifest).catch(showError);
	}, [checkout, config, version, showError]);
	const files = useMemo(() => {
		if (!manifest) return [];
		const list = side === "ships" ? manifest.files : manifest.leftOut;
		const f = filter.toLowerCase();
		return f ? list.filter((x) => x.path.toLowerCase().includes(f) || x.why.toLowerCase().includes(f)) : list;
	}, [manifest, side, filter]);
	if (!manifest) return <div className="release-pane muted">Loading…</div>;
	const assetPath = (path: string) => path.replace(/^assets\//, "");
	return (
		<div className="release-pane col">
			<div className="row">
				<span className="grow muted">
					{manifest.files.length === 1 ? "1 file ships" : `${manifest.files.length} files ship`} ({mb(manifest.bytes)}): what the game's code reaches, directly or through its scenes, screens and effects.
				</span>
				<div className="segmented">
					<button className={side === "ships" ? "on" : ""} onClick={() => setSide("ships")}>
						Ships ({manifest.files.length})
					</button>
					<button className={side === "left" ? "on" : ""} onClick={() => setSide("left")}>
						Left out ({manifest.leftOut.length})
					</button>
				</div>
				<input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
			</div>
			<table className="release-table" data-testid="release-files">
				<tbody>
					{files.map((f) => (
						<tr key={f.path}>
							<td className="ellipsis" title={f.path}>
								{assetPath(f.path)}
							</td>
							<td className="muted small">{mb(f.size)}</td>
							<td className="muted small">{f.why}</td>
							<td>
								{side === "ships" && f.why !== "release.json include" && (
									<button className="ghost small" title="Never ship this file (the release's exclude)" onClick={() => onSave({ ...config, exclude: [...config.exclude, assetPath(f.path)] })}>
										Leave out
									</button>
								)}
								{side === "left" && f.why === "nothing uses it" && (
									<button className="ghost small" title="Ship it although nothing seems to use it, e.g. loaded by a computed path (the release's include)" onClick={() => onSave({ ...config, include: [...config.include, assetPath(f.path)] })}>
										Ship it
									</button>
								)}
								{(f.why === "release.json include" || f.why === "release.json exclude") && (
									<button
										className="ghost small"
										title="Remove the override"
										onClick={() => onSave({ ...config, include: config.include.filter((x) => x !== assetPath(f.path)), exclude: config.exclude.filter((x) => x !== assetPath(f.path)) })}
									>
										Undo override
									</button>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
