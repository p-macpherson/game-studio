import { useEffect, useMemo, useState } from "react";
import type { AssetSearchHit, AssetSummary, ModuleInfo } from "../../shared/modules";
import { call, relativeTime } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { Markdown } from "../../renderer/views/Markdown";
import { StatusBadge } from "../../renderer/views/Sessions";

/** Resolves a relative link from one repo-relative file to another (`../Lore.md` from `docs/design/x/A.md`). */
export function resolveLink(from: string, href: string): string {
	const parts = from.split("/").slice(0, -1);
	for (const seg of href.split("#")[0].split("/")) {
		if (seg === "..") parts.pop();
		else if (seg && seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

function Highlight({ text, query }: { text: string; query: string }) {
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

export function DesignDocsView({ module }: { module: ModuleInfo }) {
	const { focus, showAsset, assetsVersion, sessions, openNewSession, selectSession, showError, project } = useStudio();
	const [docs, setDocs] = useState<AssetSummary[] | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<AssetSearchHit[]>([]);
	const [text, setText] = useState("");

	useEffect(() => {
		call("assets.list", module.id).then(setDocs, showError);
	}, [module.id, assetsVersion, project?.path, showError]);

	useEffect(() => {
		const q = query.trim();
		if (!q) return setHits([]);
		const t = setTimeout(() => call("assets.search", module.id, q).then(setHits, showError), 150);
		return () => clearTimeout(t);
	}, [query, module.id, assetsVersion, showError]);

	// Select the overview (or the first doc) when nothing of ours is focused.
	const selected = docs?.find((d) => d.path === focus?.path);
	useEffect(() => {
		if (docs && docs.length > 0 && !selected) {
			const first = docs.find((d) => /overview\.md$/i.test(d.path)) ?? docs[0];
			showAsset({ path: first.path, sessionId: first.inMain ? undefined : first.drafts[0]?.sessionId });
		}
	}, [docs, selected, showAsset]);

	const sessionId = selected && (focus?.sessionId ?? (selected.inMain ? undefined : selected.drafts[0]?.sessionId));
	useEffect(() => {
		if (!selected) return;
		call("assets.read", selected.path, sessionId).then(setText, showError);
	}, [selected?.path, sessionId, assetsVersion, showError]);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!docs || !q) return docs ?? [];
		const hitPaths = new Set(hits.map((h) => h.path));
		return docs.filter((d) => `${d.title} ${d.path}`.toLowerCase().includes(q) || hitPaths.has(d.path));
	}, [docs, hits, query]);

	const linkedSessions = selected ? sessions.filter((s) => s.linkedAsset === selected.path) : [];
	const draft = selected?.drafts.find((d) => d.sessionId === sessionId);

	const newDoc = () =>
		openNewSession({
			agentType: module.agentType,
			target: "project",
			context: `New ${module.noun} in ${module.roots[0]}/`,
			placeholder: "What should the new design doc cover?",
		});
	const discuss = (path: string) =>
		openNewSession({
			agentType: module.agentType,
			target: "project",
			linkedAsset: path,
			context: `About ${path}`,
			placeholder: "What do you want to discuss or change?",
		});

	return (
		<div className="sessions">
			<div className="session-list">
				<div className="toolbar">
					<div className="row">
						<h2 className="grow">{module.name}</h2>
						<button className="primary" onClick={newDoc}>
							+ New doc
						</button>
					</div>
					<input placeholder="Search titles and text…" value={query} onChange={(e) => setQuery(e.target.value)} />
				</div>
				<div className="session-items">
					{docs?.length === 0 && <div className="empty">No design docs yet. Start one with “New doc”.</div>}
					{visible.map((d) => (
						<div
							key={d.path}
							data-testid="doc-item"
							className={`session-item asset-item ${d.path === selected?.path ? "selected" : ""}`}
							onClick={() => showAsset({ path: d.path, sessionId: d.inMain ? undefined : d.drafts[0]?.sessionId })}
						>
							<div className="row">
								<span className="title grow ellipsis">{d.title}</span>
								{d.updatedAt && (
									<span className="muted" style={{ fontSize: 11 }}>
										{relativeTime(d.updatedAt)}
									</span>
								)}
							</div>
							<span className="muted ellipsis" style={{ fontSize: 11 }}>
								{d.path.slice(module.roots[0].length + 1)}
							</span>
							{d.excerpt && <span className="excerpt">{d.excerpt}</span>}
							{d.drafts.length > 0 && (
								<div className="row" style={{ flexWrap: "wrap" }}>
									<span className="badge draft">
										{d.inMain ? `${d.drafts.length} draft${d.drafts.length > 1 ? "s" : ""} in progress` : "New, not merged yet"}
									</span>
								</div>
							)}
							{hits
								.filter((h) => h.path === d.path)
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
			{selected ? (
				<div className="session-detail">
					<div className="session-header">
						<div className="row">
							<div className="grow col" style={{ gap: 0, minWidth: 0 }}>
								<h2 className="ellipsis">{selected.title}</h2>
								<code className="muted ellipsis">{selected.path}</code>
							</div>
							{draft && <button onClick={() => selectSession(draft.sessionId)}>Open session</button>}
							<button className="primary" onClick={() => discuss(selected.path)}>
								Discuss / modify
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
						<div className="doc-view">
							{draft?.change === "deleted" ? (
								<div className="empty">Deleted in session “{draft.sessionTitle}”.</div>
							) : (
								<Markdown
									text={text}
									onLink={(href) => {
										const target = resolveLink(selected.path, href);
										if (docs?.some((d) => d.path === target)) showAsset({ path: target });
									}}
								/>
							)}
						</div>
						{linkedSessions.length > 0 && (
							<div className="doc-view col" style={{ paddingTop: 0 }}>
								<h3>Sessions on this doc</h3>
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
				<div className="empty">{docs === null ? "Loading…" : "Select a doc."}</div>
			)}
		</div>
	);
}
