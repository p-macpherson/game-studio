// The common shape of a module section: a searchable tree of its assets and a viewer, both showing the checkout
// selected in the sidebar (main, or a worktree: its changes labelled, other worktrees' hidden), with actions and
// the sessions linked to the asset. Each module draws an asset's content.
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type ChangeCounts, assetTree, type TreeNode, treeLeaves } from "../../shared/asset-tree";
import type { MoveResult } from "../../shared/modules";
import { type AssetSearchHit, type AssetSummary, type ModuleInfo, moduleOwns } from "../../shared/modules";
import type { WorktreeSummary } from "../../shared/types";
import { call, relativeTime } from "../api";
import { type NewSessionPreset, useStudio } from "../store";
import { editCheckout } from "../workspace";
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
	// Moving and renaming: the right-click menu, the path being edited, what's dragged, and what the last move did.
	const [menu, setMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
	const [moving, setMoving] = useState<{ node: TreeNode; value: string; rename: boolean } | null>(null);
	const [dragged, setDragged] = useState<TreeNode | null>(null);
	const [moved, setMoved] = useState<(MoveResult & { name: string; folder: boolean }) | null>(null);
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

	// Paths are edited relative to the item's root, without what the section implies (the manifest file, a lone extension).
	const manifest = module.extensions.every((e) => e.startsWith("/")) ? module.extensions[0] : null;
	const lone = !manifest && module.extensions.length === 1 ? module.extensions[0] : "";
	const rootOf = (path: string) => module.roots.find((r) => path === r || path.startsWith(`${r}/`)) ?? module.roots[0];
	const pathOf = (n: TreeNode) => (n.kind === "folder" ? n.key : n.asset.path);
	const relOf = (path: string, folder: boolean) => {
		const rel = path.slice(rootOf(path).length + 1);
		if (folder) return rel;
		return manifest ? rel.slice(0, -manifest.length) : lone ? rel.slice(0, -lone.length) : rel;
	};
	const editable = (n: TreeNode) => relOf(pathOf(n), n.kind === "folder");
	const targetOf = (n: TreeNode, rel: string) => `${rootOf(pathOf(n))}/${rel}${n.kind === "folder" ? "" : manifest ?? lone}`;
	const movable = (n: TreeNode) => (n.kind === "folder" ? !module.roots.includes(n.key) : n.asset.change !== "deleted");
	const move = async (n: TreeNode, rel: string) => {
		setMoving(null);
		const to = targetOf(n, rel.trim().replace(/^\/+|\/+$/g, ""));
		if (to === pathOf(n)) return;
		try {
			// Like any section edit: in the selected worktree, or a new one when main is shown.
			const at = await editCheckout(`Move: ${n.name}`);
			const r = await call("assets.move", module.id, at, pathOf(n), to);
			setMoved({ ...r, name: n.name, folder: n.kind === "folder" });
			useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
			if (n.kind === "leaf") showAsset({ path: r.to });
		} catch (err) {
			showError(err);
		}
	};
	/** Dropping `n` on a folder (or the root, `into` = its key) moves it there, keeping its name. */
	const dropInto = (into: string, n: TreeNode) => {
		const name = editable(n).split("/").pop()!;
		const root = rootOf(into);
		if (rootOf(pathOf(n)) !== root || into === pathOf(n) || into.startsWith(`${pathOf(n)}/`)) return;
		void move(n, into === root ? name : `${into.slice(root.length + 1)}/${name}`);
	};
	const rowEvents = (n: TreeNode) =>
		movable(n)
			? {
					draggable: true,
					onDragStart: () => setDragged(n),
					onDragEnd: () => setDragged(null),
					onContextMenu: (e: React.MouseEvent) => {
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY, node: n });
					},
				}
			: {};
	const dropTarget = (key: string) => ({
		onDragOver: (e: React.DragEvent) => dragged && e.preventDefault(),
		onDrop: (e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (dragged) dropInto(key, dragged);
			setDragged(null);
		},
	});

	const row = (n: TreeNode, depth: number): ReactNode => {
		const indent = { paddingLeft: 8 + depth * 14 };
		if (n.kind === "folder") {
			const open = filtering || !folded.includes(n.key);
			return (
				<div key={n.key} role="group">
					<button className="tree-row tree-folder" style={indent} aria-expanded={open} onClick={() => toggleFolder(n.key)} data-testid="tree-folder" {...rowEvents(n)} {...dropTarget(n.key)}>
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
					{...rowEvents(n)}
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
				{moved && (
					<div className="move-notice row" data-testid="move-notice">
						<span className="grow" title={moved.updated.join("\n")}>
							Moved {moved.name} to <code>{relOf(moved.to, moved.folder)}</code>
							{moved.updated.length > 0 ? `, updating ${moved.updated.length} file${moved.updated.length > 1 ? "s" : ""} that referred to it.` : "."}
							{moved.code && <span className="change-modified"> Game code changed: run the tests in Play &amp; Test before merging.</span>}
						</span>
						<button className="ghost small" onClick={() => setMoved(null)}>
							✕
						</button>
					</div>
				)}
				<div className="session-items">
					{assets?.length === 0 && <div className="empty">{props.emptyText}</div>}
					{!!assets?.length && visible.length === 0 && <div className="empty">Nothing matches.</div>}
					<div className="asset-tree" role="tree" {...(module.roots.length === 1 ? dropTarget(module.roots[0]) : {})}>
						{tree.map((n) => row(n, 0))}
					</div>
				</div>
			</div>
			{menu && (
				<div className="modal-backdrop clear" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
					<div className="card context-menu" style={{ left: menu.x, top: menu.y }} data-testid="tree-menu">
						<button className="ghost" onClick={() => (setMenu(null), setMoving({ node: menu.node, value: editable(menu.node), rename: true }))}>
							Rename…
						</button>
						<button className="ghost" onClick={() => (setMenu(null), setMoving({ node: menu.node, value: editable(menu.node), rename: false }))}>
							Move to…
						</button>
					</div>
				</div>
			)}
			{moving && (
				<div className="modal-backdrop" onClick={() => setMoving(null)}>
					<div className="modal col" style={{ width: 460 }} onClick={(e) => e.stopPropagation()} data-testid="move-dialog">
						<h3>{moving.rename ? "Rename" : "Move"} {moving.node.name}</h3>
						<label className="col">
							<span className="muted small">
								Path in <code>{rootOf(pathOf(moving.node))}/</code>
								{moving.node.kind === "leaf" && (manifest || lone) ? ` (without ${manifest ? manifest.slice(1) : lone})` : ""}: folders with "/"
							</span>
							<input
								autoFocus
								value={moving.value}
								onFocus={(e) => moving.rename && e.target.setSelectionRange(e.target.value.lastIndexOf("/") + 1, e.target.value.length)}
								onChange={(e) => setMoving({ ...moving, value: e.target.value })}
								onKeyDown={(e) => (e.key === "Enter" ? void move(moving.node, moving.value) : e.key === "Escape" && setMoving(null))}
								data-testid="move-path"
							/>
						</label>
						<span className="muted small">
							References to it in scenes, prefabs, game code, tests and docs are updated. It happens in the selected worktree (or a new one), so
							nothing changes in the game until you merge.
						</span>
						<div className="row" style={{ justifyContent: "flex-end" }}>
							<button onClick={() => setMoving(null)}>Cancel</button>
							<button className="primary" onClick={() => void move(moving.node, moving.value)} data-testid="move-ok">
								{moving.rename ? "Rename" : "Move"}
							</button>
						</div>
					</div>
				</div>
			)}
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
