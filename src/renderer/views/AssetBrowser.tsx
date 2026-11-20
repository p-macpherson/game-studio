// The common shape of a module section: a searchable tree of its assets and a viewer, both showing the checkout
// selected in the sidebar (main, or a worktree: its changes labelled, other worktrees' hidden), with actions and
// the sessions linked to the asset. Each module draws an asset's content.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type ChangeCounts, assetTree, type TreeNode, treeLeaves } from "../../shared/asset-tree";
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
	/** A small icon before each item's name in the tree (e.g. a thumbnail), from the shown checkout. */
	itemPreview?(asset: AssetSummary, checkout?: string): ReactNode;
	/** A short note after an item's name (e.g. where it's used). */
	itemHint?(asset: AssetSummary): string | undefined;
	modifyLabel: string;
	modifyPlaceholder: string;
	emptyText: string;
	/** Which asset to show when nothing is focused; the first one by default. */
	pickDefault?(assets: AssetSummary[]): AssetSummary;
	content(props: AssetContentProps): ReactNode;
	/** Extra header buttons for the selected asset. */
	actions?(asset: AssetSummary, checkout?: string): ReactNode;
}

/** How many things the selected worktree added, modified and removed, in the change colours (sidebar, folders). */
export function ChangeCountsLabel({ added, modified, deleted }: ChangeCounts) {
	if (!added && !modified && !deleted) return null;
	const title = [added && `${added} new`, modified && `${modified} modified`, deleted && `${deleted} removed`].filter(Boolean).join(", ");
	return (
		<span className="change-counts" title={`In the selected worktree: ${title}`} data-testid="change-counts">
			{added > 0 && <span className="change-added">{added}</span>}
			{modified > 0 && <span className="change-modified">{modified}</span>}
			{deleted > 0 && <span className="change-deleted">{deleted}</span>}
		</span>
	);
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
	// Folded folders, remembered per section.
	const foldKey = `asset-tree-folded:${module.id}`;
	const [folded, setFolded] = useState<string[]>(() => JSON.parse(localStorage.getItem(foldKey) ?? "[]"));
	const toggleFolder = (key: string) => {
		const next = folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key];
		localStorage.setItem(foldKey, JSON.stringify(next));
		setFolded(next);
	};

	useEffect(() => {
		// Only the latest request counts: one started during a merge can finish after the one that followed it.
		let live = true;
		call("assets.list", module.id, worktree).then((a) => live && setAssets(a), (err) => live && showError(err));
		return () => {
			live = false;
		};
	}, [module.id, assetsVersion, project?.path, worktree, showError]);

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
		if (assets && assets.length > 0 && !selected && !waitingFor) showAsset({ path: (pickDefault?.(assets) ?? treeLeaves(assetTree(module, assets))[0].asset).path });
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
	const tree = useMemo(() => assetTree(module, visible), [module, visible]);
	// While searching or filtering, every folder is open so the matches show.
	const filtering = !!query.trim() || onlyChanged;

	const row = (n: TreeNode, depth: number): ReactNode => {
		const indent = { paddingLeft: 8 + depth * 14 };
		if (n.kind === "folder") {
			const open = filtering || !folded.includes(n.key);
			return (
				<div key={n.key} role="group">
					<button className="tree-row tree-folder" style={indent} aria-expanded={open} onClick={() => toggleFolder(n.key)} data-testid="tree-folder">
						<span className="caret">{open ? "▾" : "▸"}</span>
						<span className="grow ellipsis">{n.name}</span>
						<ChangeCountsLabel {...n.changes} />
					</button>
					{open && n.children.map((c) => row(c, depth + 1))}
				</div>
			);
		}
		const a = n.asset;
		const hint = props.itemHint?.(a);
		const icon = props.itemPreview?.(a, checkout);
		const tooltip = [a.title !== n.name ? a.title : "", a.excerpt, a.updatedAt ? `Changed ${relativeTime(a.updatedAt)}` : ""].filter(Boolean).join("\n");
		return (
			<div key={n.key}>
				<div
					data-testid="asset-item"
					className={`tree-row asset-item ${a.path === selected?.path ? "selected" : ""}`}
					style={indent}
					title={tooltip}
					onClick={() => showAsset({ path: a.path })}
				>
					<span className="caret" />
					{icon && <span className="tree-icon">{icon}</span>}
					<span className={`title ellipsis ${a.change === "deleted" ? "removed" : ""}`}>{n.name}</span>
					<span className="muted small grow ellipsis" data-testid="item-hint">
						{hint ?? (a.title.toLowerCase() !== n.name.toLowerCase() ? a.title : "")}
					</span>
					{a.change && <ChangeLabel change={a.change} />}
				</div>
				{hits
					.filter((h) => h.path === a.path)
					.slice(0, 3)
					.map((h) => (
						<div key={h.line} className="hit ellipsis" style={{ paddingLeft: 30 + depth * 14 }}>
							{h.line}: <Highlight text={h.text} query={query.trim()} />
						</div>
					))}
			</div>
		);
	};

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
					<div className="asset-tree" role="tree">{tree.map((n) => row(n, 0))}</div>
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
