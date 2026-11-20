// The common shape of a module section: a searchable asset list (main checkout plus drafts from session
// worktrees), and a viewer with a Merged/Draft version bar, actions and the sessions linked to the asset.
// Each module supplies how an asset's content is drawn.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type AssetDraft, type AssetSearchHit, type AssetSummary, type ModuleInfo, moduleOwns } from "../../shared/modules";
import { call, relativeTime } from "../api";
import { type NewSessionPreset, useStudio } from "../store";
import { StatusBadge } from "./Sessions";

export interface AssetContentProps {
	asset: AssetSummary;
	text: string;
	/** Set when showing a session's draft rather than the merged version. */
	sessionId?: string;
	draft?: AssetDraft;
	assets: AssetSummary[];
	/** Line to scroll to and highlight (e.g. from a compiler error). */
	line?: number;
}

export interface AssetBrowserProps {
	module: ModuleInfo;
	newLabel: string;
	/** What "New" does: open the New Session dialog with this preset, or run `onNew` instead. */
	newPreset?: NewSessionPreset;
	onNew?(): void;
	/** Drawn at the top of each list item (e.g. a thumbnail); `sessionId` is the draft shown for it, if any. */
	itemPreview?(asset: AssetSummary, sessionId?: string): ReactNode;
	modifyLabel: string;
	modifyPlaceholder: string;
	emptyText: string;
	/** Which asset to show when nothing is focused; the first one by default. */
	pickDefault?(assets: AssetSummary[]): AssetSummary;
	content(props: AssetContentProps): ReactNode;
	/** Extra header buttons for the selected asset. */
	actions?(asset: AssetSummary, sessionId?: string): ReactNode;
}

export function Highlight({ text, query }: { text: string; query: string }) {
	const i = text.toLowerCase().indexOf(query.toLowerCase());
	if (i < 0 || !query) return <>{text}</>;
	return (
		<>
			{text.slice(0, i)}
			<mark>{text.slice(i, i + query.length)}</mark>
			{text.slice(i + query.length)}
		</>
	);
}

export function AssetBrowser(props: AssetBrowserProps) {
	const { module } = props;
	const { focus, showAsset, assetsVersion, sessions, openNewSession, selectSession, showError, project } = useStudio();
	const [assets, setAssets] = useState<AssetSummary[] | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<AssetSearchHit[]>([]);
	// The text of one checkout's version of one asset: content views never see the previous asset's text.
	const [loaded, setLoaded] = useState<{ key: string; text: string }>({ key: "", text: "" });

	useEffect(() => {
		call("assets.list", module.id).then(setAssets, showError);
	}, [module.id, assetsVersion, project?.path, showError]);

	useEffect(() => {
		const q = query.trim();
		if (!q) return setHits([]);
		const t = setTimeout(() => call("assets.search", module.id, q).then(setHits, showError), 150);
		return () => clearTimeout(t);
	}, [query, module.id, assetsVersion, showError]);

	const selected = assets?.find((a) => a.path === focus?.path);
	const { pickDefault } = props;
	useEffect(() => {
		// A focused asset of ours that isn't listed yet was just created: the list catches up on its next refresh.
		const waitingFor = focus && moduleOwns(module, focus.path);
		if (assets && assets.length > 0 && !selected && !waitingFor) {
			const first = pickDefault?.(assets) ?? assets[0];
			showAsset({ path: first.path, sessionId: first.inMain ? undefined : first.drafts[0]?.sessionId });
		}
	}, [assets, selected, showAsset, pickDefault, focus, module]);

	const sessionId = selected && (focus?.sessionId ?? (selected.inMain ? undefined : selected.drafts[0]?.sessionId));
	useEffect(() => {
		if (!selected) return;
		const key = `${selected.path}:${sessionId ?? ""}`;
		call("assets.read", selected.path, sessionId).then((text) => setLoaded({ key, text }), showError);
	}, [selected?.path, sessionId, assetsVersion, showError]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!assets || !q) return assets ?? [];
		const hitPaths = new Set(hits.map((h) => h.path));
		return assets.filter((a) => `${a.title} ${a.path}`.toLowerCase().includes(q) || hitPaths.has(a.path));
	}, [assets, hits, query]);

	const linkedSessions = selected ? sessions.filter((s) => s.linkedAsset === selected.path) : [];
	const draft = selected?.drafts.find((d) => d.sessionId === sessionId);
	const subtitle = (path: string) => (module.roots.length === 1 ? path.slice(module.roots[0].length + 1) : path);

	const modify = (path: string) =>
		openNewSession({ agentType: module.agentType, target: "project", linkedAsset: path, context: `About ${path}`, placeholder: props.modifyPlaceholder });

	return (
		<div className="sessions">
			<div className="session-list">
				<div className="toolbar">
					<div className="row">
						<h2 className="grow">{module.name}</h2>
						<button className="primary" onClick={() => (props.onNew ? props.onNew() : props.newPreset && openNewSession(props.newPreset))}>
							{props.newLabel}
						</button>
					</div>
					<input placeholder="Search names and text…" value={query} onChange={(e) => setQuery(e.target.value)} />
				</div>
				<div className="session-items">
					{assets?.length === 0 && <div className="empty">{props.emptyText}</div>}
					{visible.map((a) => (
						<div
							key={a.path}
							data-testid="asset-item"
							className={`session-item asset-item ${a.path === selected?.path ? "selected" : ""}`}
							onClick={() => showAsset({ path: a.path, sessionId: a.inMain ? undefined : a.drafts[0]?.sessionId })}
						>
							{props.itemPreview?.(a, a.inMain ? undefined : a.drafts[0]?.sessionId)}
							<div className="row">
								<span className="title grow ellipsis">{a.title}</span>
								{a.updatedAt && (
									<span className="muted" style={{ fontSize: 11 }}>
										{relativeTime(a.updatedAt)}
									</span>
								)}
							</div>
							<span className="muted ellipsis" style={{ fontSize: 11 }}>
								{subtitle(a.path)}
							</span>
							{a.excerpt && <span className="excerpt">{a.excerpt}</span>}
							{a.drafts.length > 0 && (
								<div className="row" style={{ flexWrap: "wrap" }}>
									<span className="badge draft">
										{a.inMain ? `${a.drafts.length} draft${a.drafts.length > 1 ? "s" : ""} in progress` : "New, not merged yet"}
									</span>
								</div>
							)}
							{hits
								.filter((h) => h.path === a.path)
								.slice(0, 3)
								.map((h) => (
									<div key={h.line} className="hit ellipsis">
										{h.line}: <Highlight text={h.text} query={query.trim()} />
									</div>
								))}
						</div>
					))}
				</div>
			</div>
			{selected && assets ? (
				<div className="session-detail">
					<div className="session-header">
						<div className="row">
							<div className="grow col" style={{ gap: 0, minWidth: 0 }}>
								<h2 className="ellipsis">{selected.title}</h2>
								<code className="muted ellipsis">{selected.path}</code>
							</div>
							{props.actions?.(selected, sessionId)}
							{draft && <button onClick={() => selectSession(draft.sessionId)}>Open session</button>}
							<button className="primary" onClick={() => modify(selected.path)}>
								{props.modifyLabel}
							</button>
						</div>
						{selected.drafts.length > 0 && (
							<div className="version-bar">
								<span className="muted">Showing:</span>
								{selected.inMain && (
									<button className={`chip ${!sessionId ? "on" : ""}`} onClick={() => showAsset({ path: selected.path })}>
										Merged
									</button>
								)}
								{selected.drafts.map((d) => (
									<button
										key={d.sessionId}
										className={`chip ${sessionId === d.sessionId ? "on" : ""}`}
										title={`${d.change} in session “${d.sessionTitle}”`}
										onClick={() => showAsset({ path: selected.path, sessionId: d.sessionId })}
									>
										Draft: {d.sessionTitle}
									</button>
								))}
							</div>
						)}
					</div>
					<div className="tab-body">
						{draft?.change === "deleted" ? (
							<div className="empty">Deleted in session “{draft.sessionTitle}”.</div>
						) : (
							props.content({
									asset: selected,
									text: loaded.key === `${selected.path}:${sessionId ?? ""}` ? loaded.text : "",
									sessionId,
									draft,
									assets,
									line: focus?.line,
								})
						)}
						{linkedSessions.length > 0 && (
							<div className="doc-view col" style={{ paddingTop: 0 }}>
								<h3>Sessions on this {module.noun}</h3>
								{linkedSessions.map((s) => (
									<div key={s.id} className="list-row file-row" onClick={() => selectSession(s.id)}>
										<span className="grow ellipsis">{s.title}</span>
										<StatusBadge s={s} />
										<span className="muted" style={{ fontSize: 11 }}>
											{relativeTime(s.updatedAt)}
										</span>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			) : (
				<div className="empty">{assets === null ? "Loading…" : `Select a ${module.noun}.`}</div>
			)}
		</div>
	);
}
