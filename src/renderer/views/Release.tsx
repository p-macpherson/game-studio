// Release: shipping the game to players. The settings (release.json), what ships and why, builds for Linux and Windows
// with their checks, and publishing a passing build to itch.io. Builds come from the checkout the sidebar selects.
import { useCallback, useEffect, useMemo, useState } from "react";
import { RELEASE_TARGETS, type ReleaseBuild, type ReleaseConfig, type ReleaseInfo, type ReleaseTarget } from "../../shared/release";
import { call, onEvent } from "../api";
import { useStudio } from "../store";
import { runInWorktree } from "../workspace";
import { useShallow } from "zustand/react/shallow";

const TARGET_LABEL: Record<ReleaseTarget, string> = { linux: "Linux", windows: "Windows" };

export function mb(bytes: number): string {
	return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function Release() {
	const { worktree, worktrees, showError, assetsVersion, openSettings } = useStudio(
		useShallow((s) => ({ worktree: s.worktree, worktrees: s.worktrees, showError: s.showError, assetsVersion: s.assetsVersion, openSettings: s.openSettings })),
	);
	const [info, setInfo] = useState<ReleaseInfo | null>(null);
	const [draft, setDraft] = useState<ReleaseConfig | null>(null);
	const [building, setBuilding] = useState<ReleaseTarget | null>(null);
	const [log, setLog] = useState<string[]>([]);
	const [tab, setTab] = useState<"ships" | "left">("ships");
	const [filter, setFilter] = useState("");

	const reload = useCallback(async () => {
		try {
			const i = await call("release.info", worktree);
			setInfo(i);
			setDraft(i.config);
		} catch (err) {
			showError(err);
		}
	}, [worktree, showError]);

	useEffect(() => void reload(), [reload, assetsVersion]);
	useEffect(
		() =>
			onEvent((e) => {
				if (e.type === "release_progress") setLog((l) => [...l.slice(-200), `${TARGET_LABEL[e.target]}: ${e.text}`]);
			}),
		[],
	);

	const label = worktree ? (worktrees.find((w) => w.id === worktree)?.label ?? worktree) : "main";
	const dirty = !!info && !!draft && JSON.stringify(info.config) !== JSON.stringify(draft);

	/** release.json changes are a person's edit in a worktree (a new one when main is shown), undoable and saved there. */
	const saveConfig = async (config: ReleaseConfig) => {
		try {
			await runInWorktree("Release settings", "edit_release", { config });
			await reload();
		} catch (err) {
			showError(err);
		}
	};

	const build = async (target: ReleaseTarget) => {
		setBuilding(target);
		setLog([]);
		try {
			await call("release.build", worktree, target);
		} catch (err) {
			showError(err);
		} finally {
			setBuilding(null);
			await reload();
		}
	};

	const publish = async (b: ReleaseBuild) => {
		if (!info) return;
		const itch = info.config.itch;
		if (!itch?.target) return showError(new Error("Set the itch.io page (user/game) in the settings first"));
		if (!info.itchKey) {
			openSettings("accounts");
			return showError(new Error("Add your itch.io API key under Settings → Accounts first"));
		}
		const channel = itch.channels?.[b.target] ?? b.target;
		const ok = window.confirm(
			`Upload ${info.config.name} ${b.version} for ${TARGET_LABEL[b.target]} to itch.io?\n\n` +
				`Page: https://${itch.target.split("/")[0]}.itch.io/${itch.target.split("/")[1]}\nChannel: ${channel}\n\n` +
				"Anyone who can see the page can download it once it's uploaded (keep the page restricted or a draft until it's ready).",
		);
		if (!ok) return;
		setLog([]);
		try {
			await call("release.publish", worktree, b.version, b.target);
		} catch (err) {
			showError(err);
		}
	};

	const files = useMemo(() => {
		if (!info) return [];
		const list = tab === "ships" ? info.manifest.files : info.manifest.leftOut;
		const f = filter.toLowerCase();
		return f ? list.filter((x) => x.path.toLowerCase().includes(f) || x.why.toLowerCase().includes(f)) : list;
	}, [info, tab, filter]);

	if (!info || !draft) return <div className="page muted">Loading…</div>;
	const set = (patch: Partial<ReleaseConfig>) => setDraft({ ...draft, ...patch });
	const assetPath = (p: string) => p.replace(/^assets\//, "");
	const pngs = [...info.manifest.files, ...info.manifest.leftOut].map((f) => f.path).filter((p) => p.endsWith(".png") && !/\/(candidates|concepts|source)\//.test(p));

	return (
		<div className="page release">
			<div className="row">
				<h2 className="grow">Release</h2>
				<span className="muted">From {label}</span>
			</div>

			<div className="release-grid">
				<section className="card release-settings" data-testid="release-settings">
					<h3>Settings {!info.saved && <span className="muted small">(defaults: no release.json yet)</span>}</h3>
					<label className="field-row">
						<span className="field-name">Name</span>
						<input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
					</label>
					<label className="field-row">
						<span className="field-name">Version</span>
						<input data-testid="release-version" value={draft.version} onChange={(e) => set({ version: e.target.value })} placeholder="1.0.0" />
					</label>
					<label className="field-row">
						<span className="field-name">Icon</span>
						<select value={draft.icon ?? ""} onChange={(e) => set({ icon: e.target.value || undefined })}>
							<option value="">None</option>
							{pngs.map((p) => (
								<option key={p} value={assetPath(p)}>
									{assetPath(p)}
								</option>
							))}
						</select>
					</label>
					<div className="field-row">
						<span className="field-name">Platforms</span>
						<span className="row release-targets">
						{RELEASE_TARGETS.map((t) => (
							<label key={t} className="row">
								<input
									type="checkbox"
									checked={draft.targets.includes(t)}
									onChange={(e) => set({ targets: e.target.checked ? [...draft.targets, t] : draft.targets.filter((x) => x !== t) })}
								/>
								{TARGET_LABEL[t]}
							</label>
						))}
						</span>
					</div>
					<label className="field-row">
						<span className="field-name">itch.io page</span>
						<input
							data-testid="release-itch"
							value={draft.itch?.target ?? ""}
							placeholder="user/game"
							onChange={(e) => set({ itch: e.target.value ? { ...draft.itch, target: e.target.value.trim() } : undefined })}
						/>
					</label>
					{info.problems.map((p) => (
						<div key={p} className="bad-text small">
							{p}
						</div>
					))}
					<div className="row">
						<span className="grow muted small">{info.itchKey ? "itch.io key saved" : "No itch.io key: add one under Settings → Accounts to publish"}</span>
						<button disabled={!dirty} onClick={() => setDraft(info.config)}>
							Reset
						</button>
						<button className="primary" data-testid="release-save" disabled={!dirty && info.saved} onClick={() => saveConfig(draft)}>
							Save
						</button>
					</div>
				</section>

				<section className="card release-build">
					<h3>Build</h3>
					<div className="row">
						{RELEASE_TARGETS.map((t) => (
							<button
								key={t}
								className="primary"
								data-testid={`release-build-${t}`}
								disabled={!!building || !info.config.targets.includes(t) || dirty}
								title={dirty ? "Save the settings first" : !info.config.targets.includes(t) ? `${TARGET_LABEL[t]} isn't one of the platforms` : undefined}
								onClick={() => build(t)}
							>
								{building === t ? <span className="spinner" /> : null} Build for {TARGET_LABEL[t]}
							</button>
						))}
					</div>
					{!info.tools.wine && <div className="muted small">Wine isn't installed: Windows builds are made but can't be checked here.</div>}
					<div className="muted small">
						{info.manifest.files.length === 1 ? "1 file ships" : `${info.manifest.files.length} files ship`} ({mb(info.manifest.bytes)}). Builds go to builds/ (never committed); each is checked from its own folder and
						against the game's tests.
					</div>
					{log.length > 0 && (
						<pre className="console release-log" data-testid="release-log">
							{log.join("\n")}
						</pre>
					)}
				</section>
			</div>

			<section className="release-builds">
				<h3>Builds</h3>
				{info.builds.length === 0 && <div className="empty">No builds yet.</div>}
				{info.builds.map((b) => (
					<div key={`${b.version}-${b.target}`} className="card release-card" data-testid="release-card">
						<div className="row">
							<strong>
								{b.version} · {TARGET_LABEL[b.target]}
							</strong>
							<span className={`badge ${b.ok ? "status-done" : "status-interrupted"}`}>{b.ok ? "Checks passed" : "Checks failed"}</span>
							<span className="muted small grow">
								{new Date(b.builtAt).toLocaleString()} · {b.files === 1 ? "1 file" : `${b.files} files`} · {mb(b.bytes)}
							</span>
							<button onClick={() => call("release.run", worktree, b.version, b.target).catch(showError)}>Run</button>
							<button onClick={() => call("release.reveal", worktree, b.version, b.target).catch(showError)}>Open folder</button>
							<button className="primary" data-testid="release-publish" disabled={!b.ok} title={b.ok ? undefined : "Only a build whose checks passed can be published"} onClick={() => publish(b)}>
								Publish to itch.io
							</button>
						</div>
						<div className="release-checks">
							{b.checks.map((c) => (
								<div key={c.name} className="release-check">
									<span className={c.ok ? "ok-mark" : "bad-mark"}>{c.ok ? "✓" : "✗"}</span> <span>{c.name}</span>
									{!c.ok || c.name.startsWith("Runs") || c.name === "AppImage" ? <span className="muted small"> — {c.detail.split("\n")[0]}</span> : null}
									{!c.ok && c.detail.includes("\n") && <pre className="test-output">{c.detail}</pre>}
								</div>
							))}
						</div>
						<div className="muted small">{b.archives.map((a) => a.slice(a.lastIndexOf("/") + 1)).join(" · ")}</div>
					</div>
				))}
			</section>

			<section className="release-files">
				<div className="row">
					<h3 className="grow">What ships</h3>
					<div className="tabs">
						<button className={`tab ${tab === "ships" ? "active" : ""}`} onClick={() => setTab("ships")}>
							Ships ({info.manifest.files.length})
						</button>
						<button className={`tab ${tab === "left" ? "active" : ""}`} onClick={() => setTab("left")}>
							Left out ({info.manifest.leftOut.length})
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
									{tab === "ships" && f.why !== "release.json include" && (
										<button className="ghost small" title="Never ship this file (release.json exclude)" onClick={() => saveConfig({ ...info.config, exclude: [...info.config.exclude, assetPath(f.path)] })}>
											Leave out
										</button>
									)}
									{tab === "left" && f.why === "nothing uses it" && (
										<button className="ghost small" title="Ship it although nothing seems to use it, e.g. loaded by a computed path (release.json include)" onClick={() => saveConfig({ ...info.config, include: [...info.config.include, assetPath(f.path)] })}>
											Ship it
										</button>
									)}
									{(f.why === "release.json include" || f.why === "release.json exclude") && (
										<button
											className="ghost small"
											title="Remove the override from release.json"
											onClick={() =>
												saveConfig({
													...info.config,
													include: info.config.include.filter((x) => x !== assetPath(f.path)),
													exclude: info.config.exclude.filter((x) => x !== assetPath(f.path)),
												})
											}
										>
											Undo override
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
		</div>
	);
}
