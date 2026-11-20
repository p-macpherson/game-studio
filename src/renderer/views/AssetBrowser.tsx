// The common shape of a module section: a searchable asset list and a viewer, both showing the checkout
// selected in the sidebar (main, or a worktree: its changes shown, other worktrees' hidden), with actions, a
// banner over what the worktree changed, and the sessions linked to the asset. Each module draws an asset's content.
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { type AssetSearchHit, type AssetSummary, type ModuleInfo, moduleOwns } from "../../shared/modules";
import type { WorktreeSummary } from "../../shared/types";
import { call, relativeTime } from "../api";
import { type NewSessionPreset, useStudio } from "../store";
import { StatusBadge } from "./Sessions";

export interface AssetContentProps {
	asset: AssetSummary;
	text: string;
	/** The worktree shown (its id); none for the main checkout. */
	checkout?: string;
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
	/** Drawn at the top of each list item (e.g. a thumbnail), from the shown checkout. */
	itemPreview?(asset: AssetSummary, checkout?: string): ReactNode;
	modifyLabel: string;
	modifyPlaceholder: string;
	emptyText: string;
	/** Which asset to show when nothing is focused; the first one by default. */
	pickDefault?(assets: AssetSummary[]): AssetSummary;
	content(props: AssetContentProps): ReactNode;
	/** Extra header buttons for the selected asset. */
	actions?(asset: AssetSummary, checkout?: string): ReactNode;
	/** Drawn at the bottom of each list item (e.g. where it's used). */
	itemFooter?(asset: AssetSummary, checkout?: string): ReactNode;
	/** Lists the assets under headings, in this order (e.g. Scenes, then Prefabs). */
	groups?: { name: string; has(asset: AssetSummary): boolean }[];
}

type Groups = NonNullable<AssetBrowserProps["groups"]>;
const groupName = (a: AssetSummary, groups: Groups) => groups.find((g) => g.has(a))?.name ?? "Other";
/** The assets in their groups' order (stable within a group); unchanged without groups. */
function inGroups(assets: AssetSummary[], groups?: Groups): AssetSummary[] {
	if (!groups) return assets;
	const rank = (a: AssetSummary) => {
		const i = groups.findIndex((g) => g.has(a));
		return i < 0 ? groups.length : i;
	};
	return assets.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
}

const CHANGE_LABEL = { added: "New", modified: "Modified", deleted: "Removed" } as const;

/** What the selected worktree did to an asset: ⎇ New (green), ⎇ Modified (yellow), ⎇ Removed (red). */
export function ChangeLabel({ change }: { change: NonNullable<AssetSummary["change"]> }) {
	return (
		<span className={`change-label change-${change}`} title={`${CHANGE_LABEL[change]} in the selected worktree (not in the game until it's merged)`} data-testid="change-label">
			⎇ {CHANGE_LABEL[change]}
		</span>
	);
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

/**
 * Shown over an asset the selected worktree added or changed: it isn't in the game until the worktree is merged.
 * Merging (or discarding) takes the whole worktree, so the other files it changed are listed first.
 */
export function AssetBrowser(props: AssetBrowserProps) {
	const { module } = props;
	const { focus, showAsset, assetsVersion, sessions, openNewSession, selectSession, showError, project, worktree, worktrees } = useStudio();
	const [assets, setAssets] = useState<AssetSummary[] | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<AssetSearchHit[]>([]);
	// The text of one checkout's version of one asset: content views never see the previous asset's text.
	const [loaded, setLoaded] = useState<{ key: string; text: string }>({ key: "", text: "" });
	const checkout = worktree ?? undefined;
	const selectedWorktree = worktrees.find((w) => w.id === worktree);
	// Filters (with a worktree selected): only what it changed; whether to list what it removed.
	const [onlyChanged, setOnlyChanged] = useState(false);
	const [includeRemoved, setIncludeRemoved] = useState(true);
	// Folded group headings, remembered per section.
	const groupsKey = `asset-groups-hidden:${module.id}`;
	const [hiddenGroups, setHiddenGroups] = useState<string[]>(() => JSON.parse(localStorage.getItem(groupsKey) ?? "[]"));
	const toggleGroup = (name: string) => {
		const next = hiddenGroups.includes(name) ? hiddenGroups.filter((g) => g !== name) : [...hiddenGroups, name];
		localStorage.setItem(groupsKey, JSON.stringify(next));
		setHiddenGroups(next);
	};

	useEffect(() => {
		// Only the latest request counts: one started during a merge can finish after the one that followed it.
		let live = true;
		call("assets.list", module.id, worktree).then((a) => live && setAssets(inGroups(a, props.groups)), (err) => live && showError(err));
		return () => {
			live = false;
		};
	}, [module.id, assetsVersion, project?.path, worktree, showError, props.groups]);

	useEffect(() => {
		const q = query.trim();
		if (!q) return setHits([]);
		const t = setTimeout(() => call("assets.search", module.id, q, worktree).then(setHits, showError), 150);
		return () => clearTimeout(t);
	}, [query, module.id, assetsVersion, worktree, showError]);

	const selected = assets?.find((a) => a.path === focus?.path);
	const { pickDefault } = props;
	useEffect(() => {
		// A focused asset of ours that isn't listed yet was just created: the list catches up on its next refresh.
		const waitingFor = focus && moduleOwns(module, focus.path);
		if (assets && assets.length > 0 && !selected && !waitingFor) showAsset({ path: (pickDefault?.(assets) ?? assets[0]).path });
	}, [assets, selected, showAsset, pickDefault, focus, module]);

	useEffect(() => {
		if (!selected) return;
		let live = true;
		const key = `${selected.path}:${worktree ?? ""}`;
		call("assets.read", selected.path, worktree).then(
			(text) => live && setLoaded({ key, text }),
			(err) => live && showError(err),
		);
		return () => {
			live = false;
		};
	}, [selected?.path, worktree, assetsVersion, showError]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = (assets ?? []).filter((a) => (!onlyChanged || a.change) && (includeRemoved || a.change !== "deleted"));
		if (!q) return filtered;
		const hitPaths = new Set(hits.map((h) => h.path));
		return filtered.filter((a) => `${a.title} ${a.path}`.toLowerCase().includes(q) || hitPaths.has(a.path));
	}, [assets, hits, query, onlyChanged, includeRemoved]);

	const linkedSessions = selected ? sessions.filter((s) => s.linkedAsset === selected.path) : [];
	const subtitle = (path: string) => (module.roots.length === 1 ? path.slice(module.roots[0].length + 1) : path);

	// With groups: one section per heading (in order, only those with something to show); headings fold away.
	const sections: { name?: string; items: AssetSummary[] }[] = props.groups
		? [...props.groups.map((g) => g.name), "Other"]
				.map((name) => ({ name, items: visible.filter((a) => groupName(a, props.groups!) === name) }))
				.filter((sec) => sec.items.length > 0)
		: [{ items: visible }];
	const item = (a: AssetSummary) => (
		<div
			key={a.path}
			data-testid="asset-item"
			className={`session-item asset-item ${a.path === selected?.path ? "selected" : ""}`}
			onClick={() => showAsset({ path: a.path })}
		>
			{props.itemPreview?.(a, checkout)}
			<div className="row">
				<span className={`title grow ellipsis ${a.change === "deleted" ? "removed" : ""}`}>{a.title}</span>
				{a.change && <ChangeLabel change={a.change} />}
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
			{hits
				.filter((h) => h.path === a.path)
				.slice(0, 3)
				.map((h) => (
					<div key={h.line} className="hit ellipsis">
						{h.line}: <Highlight text={h.text} query={query.trim()} />
					</div>
				))}
			{props.itemFooter?.(a, checkout)}
		</div>
	);

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
					{worktree && (
						<div className="row asset-filters" data-testid="asset-filters">
							<label className="check">
								<input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} data-testid="filter-changed" /> Only changes in this worktree
							</label>
							<label className="check">
								<input type="checkbox" checked={includeRemoved} onChange={(e) => setIncludeRemoved(e.target.checked)} data-testid="filter-removed" /> Include removed
							</label>
						</div>
					)}
				</div>
				<div className="session-items">
					{assets?.length === 0 && <div className="empty">{props.emptyText}</div>}
					{!!assets?.length && visible.length === 0 && <div className="empty">Nothing matches.</div>}
					{sections.map((sec) => (
						<Fragment key={sec.name ?? ""}>
							{sec.name && (
								<button
									className="asset-group"
									data-testid="asset-group"
									aria-expanded={!hiddenGroups.includes(sec.name)}
									title={hiddenGroups.includes(sec.name) ? `Show ${sec.name.toLowerCase()}` : `Hide ${sec.name.toLowerCase()}`}
									onClick={() => toggleGroup(sec.name!)}
								>
									<span className="caret">{hiddenGroups.includes(sec.name) ? "▸" : "▾"}</span>
									{sec.name}
									<span className="muted">{sec.items.length}</span>
								</button>
							)}
							{!(sec.name && hiddenGroups.includes(sec.name)) && sec.items.map(item)}
						</Fragment>
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
							{props.actions?.(selected, checkout)}
							<button className="primary" onClick={() => modify(selected.path)}>
								{props.modifyLabel}
							</button>
						</div>
					</div>
					<div className="tab-body">
						{selected.change === "deleted" ? (
							<div className="empty" data-testid="asset-removed">
								Removed in worktree “{selectedWorktree?.label}”. Merging the worktree removes it from the game; discarding the worktree keeps it.
							</div>
						) : (
							props.content({
								asset: selected,
								text: loaded.key === `${selected.path}:${worktree ?? ""}` ? loaded.text : "",
								checkout,
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
										<span className="muted small ellipsis" style={{ maxWidth: 200 }}>
											⎇ {s.worktreeLabel}
										</span>
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
