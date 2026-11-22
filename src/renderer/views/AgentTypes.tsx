// Settings → Agents: the agent types as a list or as the delegation graph; picking one opens its models: the one
// its sessions start on, and the others a parent agent may start it on when it delegates.
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { layoutAgentGraph } from "../../shared/agent-graph";
import { DESIGN_DOCS } from "../../shared/design-docs";
import type { AgentModelSettings, AgentTypeInfo, ModelInfo } from "../../shared/types";
import { call } from "../api";
import { useStudio } from "../store";

type Layout = "list" | "graph";
const LAYOUT_KEY = "agents-layout";

const modelName = (models: ModelInfo[], ref?: string) => (ref ? (models.find((m) => m.ref === ref)?.name ?? ref.split("/").pop()!) : "the first available model");

export function AgentTypes() {
	const { agentTypes, models } = useStudio(useShallow((s) => ({ agentTypes: s.agentTypes, models: s.models })));
	const [layout, setLayoutState] = useState<Layout>(() => (localStorage.getItem(LAYOUT_KEY) === "graph" ? "graph" : "list"));
	const [picked, setPicked] = useState<string | null>(null);
	const setLayout = (l: Layout) => {
		localStorage.setItem(LAYOUT_KEY, l);
		setLayoutState(l);
	};
	const type = agentTypes.find((t) => t.id === picked);
	return (
		<div className="col" data-testid="agent-types">
			<div className="row">
				<p className="muted grow" style={{ margin: 0 }}>
					Any of these can be started from New Session. Sessions delegate along these edges only (a type lists them as <code>delegatesTo</code> in its
					AGENT.md); the edges never form a loop. Click a type to choose its models.
				</p>
				<div className="segmented">
					<button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")} data-testid="agents-layout-list">
						List
					</button>
					<button className={layout === "graph" ? "on" : ""} onClick={() => setLayout("graph")} data-testid="agents-layout-graph">
						Graph
					</button>
				</div>
			</div>
			<div className="agents-body">
				<div className="agents-main">
					{layout === "graph" ? <Graph types={agentTypes} models={models} picked={picked} onPick={setPicked} /> : <List types={agentTypes} models={models} picked={picked} onPick={setPicked} />}
				</div>
				{type && <TypePanel key={type.id} type={type} types={agentTypes} models={models} onPick={setPicked} onClose={() => setPicked(null)} />}
			</div>
		</div>
	);
}

interface ViewProps {
	types: AgentTypeInfo[];
	models: ModelInfo[];
	picked: string | null;
	onPick(id: string): void;
}

/** "Sonnet 5.5 (or Opus 5.5)": the model it starts on and the ones a parent may choose. */
function ModelLine({ t, models }: { t: AgentTypeInfo; models: ModelInfo[] }) {
	return (
		<>
			{modelName(models, t.defaultModel)}
			{!!t.models?.length && <span className="muted"> · or {t.models.map((m) => modelName(models, m)).join(", ")}</span>}
		</>
	);
}

function List({ types, models, picked, onPick }: ViewProps) {
	const name = (id: string) => types.find((t) => t.id === id)?.name ?? id;
	const delegatedBy = (id: string) => types.filter((t) => t.delegatesTo?.includes(id)).map((t) => t.name);
	return (
		<div className="col">
			{types.map((t) => (
				<button key={t.id} className={`card col agent-type-card ${picked === t.id ? "on" : ""}`} onClick={() => onPick(t.id)} data-testid="agent-type-card">
					<div className="row">
						<strong className="grow">{t.name}</strong>
						<span className="small">
							<span className="muted">{t.targets.join(", ")} · </span>
							<ModelLine t={t} models={models} />
							<span className="muted"> · {t.source}</span>
						</span>
					</div>
					<div className="muted small">{t.description}</div>
					<div className="small">
						<span className="muted">Delegates to: </span>
						{t.delegatesTo?.length ? t.delegatesTo.map(name).join(", ") : "nobody"}
						{delegatedBy(t.id).length > 0 && (
							<>
								<span className="muted"> · delegated to by </span>
								{delegatedBy(t.id).join(", ")}
							</>
						)}
					</div>
					{Array.isArray(t.designDocs) && t.designDocs.length > 0 && (
						<div className="small">
							<span className="muted">Works to: </span>
							{t.designDocs.map((d) => DESIGN_DOCS.find((x) => x.id === d)?.title ?? d).join(", ")}
						</div>
					)}
					{t.problems?.map((p) => (
						<div key={p} className="msg error small">
							{p}
						</div>
					))}
				</button>
			))}
		</div>
	);
}

const NODE_W = 158;
const NODE_H = 46;
const COL_GAP = 48;
const ROW_GAP = 12;

/** The delegation graph, left to right: an arrow from each type to the ones it hands tasks to. */
function Graph({ types, models, picked, onPick }: ViewProps) {
	const graph = useMemo(() => layoutAgentGraph(types), [types]);
	const [hover, setHover] = useState<string | null>(null);
	const focus = hover ?? picked;
	const at = new Map(graph.nodes.map((n) => [n.id, { x: n.col * (NODE_W + COL_GAP), y: n.row * (NODE_H + ROW_GAP) }]));
	const width = Math.max(0, graph.cols * (NODE_W + COL_GAP) - COL_GAP);
	const height = Math.max(0, graph.rows * (NODE_H + ROW_GAP) - ROW_GAP);
	// The picked type stays in view when the panel opens beside the graph and narrows it.
	const pickedNode = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// In braces: scrollIntoView returns a promise here, which React would take for the effect's cleanup.
		void pickedNode.current?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
	}, [picked]);
	const near = new Set(focus ? [focus, ...graph.edges.filter((e) => e.from === focus || e.to === focus).flatMap((e) => [e.from, e.to])] : []);
	return (
		<div className="agent-graph-scroll">
			<div className="agent-graph" style={{ width, height }} data-testid="agent-graph">
				<svg width={width} height={height}>
					{graph.edges.map((e) => {
						const a = at.get(e.from)!;
						const b = at.get(e.to)!;
						const x1 = a.x + NODE_W;
						const y1 = a.y + NODE_H / 2;
						const x2 = b.x;
						const y2 = b.y + NODE_H / 2;
						const bend = (x2 - x1) / 2;
						const on = focus === e.from || focus === e.to;
						return <path key={`${e.from}>${e.to}`} className={`agent-edge ${on ? "on" : focus ? "dim" : ""}`} d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`} />;
					})}
				</svg>
				{types.map((t) => {
					const p = at.get(t.id)!;
					return (
						<button
							key={t.id}
							ref={picked === t.id ? pickedNode : undefined}
							className={`agent-node ${picked === t.id ? "on" : ""} ${focus && !near.has(t.id) ? "dim" : ""} ${t.problems?.length ? "problem" : ""}`}
							style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
							onClick={() => onPick(t.id)}
							onMouseEnter={() => setHover(t.id)}
							onMouseLeave={() => setHover(null)}
							title={`${t.description}\n\nStarts on ${modelName(models, t.defaultModel)}${t.models?.length ? `; a parent may choose ${t.models.map((m) => modelName(models, m)).join(", ")}` : ""}`}
							data-testid="agent-node"
						>
							<strong className="ellipsis">{t.name}</strong>
							<span className="small ellipsis">
								{modelName(models, t.defaultModel).replace(/^claude[- ]/i, "")}
								{!!t.models?.length && <span className="muted"> +{t.models.length}</span>}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** One type's details and its models. Changes are kept in Settings (not its AGENT.md) and apply to sessions started from now on. */
function TypePanel({ type, types, models, onPick, onClose }: { type: AgentTypeInfo; types: AgentTypeInfo[]; models: ModelInfo[]; onPick(id: string): void; onClose(): void }) {
	const [error, setError] = useState("");
	const parents = types.filter((t) => t.delegatesTo?.includes(type.id));
	const children = (type.delegatesTo ?? []).flatMap((id) => types.filter((t) => t.id === id));
	const others = type.models ?? [];
	// Every model that can be chosen, plus any this type (or its AGENT.md) names that isn't available now, so it can be
	// seen, removed and put back.
	const named = [type.defaultModel, ...others, type.fileModels?.defaultModel, ...(type.fileModels?.models ?? [])];
	const known = [...new Set([...models.map((m) => m.ref), ...named.filter((m): m is string => !!m)])];
	const available = (ref: string) => models.some((m) => m.ref === ref);
	const save = async (own: AgentModelSettings | null) => {
		setError("");
		try {
			const all = { ...(useStudio.getState().settings?.agentModels ?? {}) };
			if (own) all[type.id] = own;
			else delete all[type.id];
			const settings = await call("settings.update", { agentModels: all });
			useStudio.setState({ settings, agentTypes: await call("agentTypes.list") });
		} catch (e) {
			setError((e as Error).message);
		}
	};
	const links = (list: AgentTypeInfo[]) =>
		list.length
			? list.map((t, i) => (
					<span key={t.id}>
						{i > 0 && ", "}
						<button className="link" onClick={() => onPick(t.id)}>
							{t.name}
						</button>
					</span>
				))
			: "nobody";
	return (
		<div className="card col agent-panel" data-testid="agent-panel">
			<div className="row">
				<strong className="grow">{type.name}</strong>
				<button className="link muted" onClick={onClose} title="Close">
					✕
				</button>
			</div>
			<div className="muted small">{type.description}</div>
			<div className="small">
				<span className="muted">Works in: </span>
				{type.targets.join(", ") || "nothing"}
				<span className="muted"> · {type.source === "project" ? "this project's own type" : "built in"}</span>
			</div>
			<div className="small">
				<span className="muted">Delegates to: </span>
				{links(children)}
			</div>
			<div className="small">
				<span className="muted">Delegated to by: </span>
				{links(parents)}
			</div>
			{type.problems?.map((p) => (
				<div key={p} className="msg error small">
					{p}
				</div>
			))}
			<label className="col agent-field">
				<b>Default model</b>
				<span className="muted small">What its sessions start on, from New Session or as a sub-agent.</span>
				<select
					value={type.defaultModel ?? ""}
					onChange={(e) => void save({ defaultModel: e.target.value, models: others.filter((m) => m !== e.target.value) })}
					data-testid="agent-default-model"
				>
					{!type.defaultModel && <option value="">(none set)</option>}
					{known.map((ref) => (
						<option key={ref} value={ref}>
							{modelName(models, ref)}
							{available(ref) ? "" : " (not available)"}
						</option>
					))}
				</select>
				{type.defaultModel && !available(type.defaultModel) && <span className="small agent-warn">Not available now (no account for it): as a sub-agent it starts on its parent's model instead.</span>}
			</label>
			<div className="col agent-field">
				<b>A parent agent may also start it on</b>
				<span className="muted small">
					{parents.length
						? "When an agent delegates to this type it can ask for one of these instead of the default, for a task that is unusually hard. None ticked: always the default."
						: "Nothing delegates to this type, so this has no effect yet."}
				</span>
				{known
					.filter((ref) => ref !== type.defaultModel)
					.map((ref) => (
						<label key={ref} className="row agent-model-option">
							<input
								type="checkbox"
								checked={others.includes(ref)}
								onChange={(e) => void save({ ...(type.defaultModel ? { defaultModel: type.defaultModel } : {}), models: e.target.checked ? [...others, ref] : others.filter((m) => m !== ref) })}
								data-testid="agent-allow-model"
								data-model={ref}
							/>
							<span className="agent-model-name">{modelName(models, ref)}</span>
							<span className="muted small">{available(ref) ? ref : `${ref} · not available now`}</span>
						</label>
					))}
				{known.filter((ref) => ref !== type.defaultModel).length === 0 && <span className="muted small">No other models are available (Settings → Accounts).</span>}
			</div>
			{type.fileModels && (
				<div className="row small">
					<span className="muted grow">
						Changed here. Its AGENT.md says: {modelName(models, type.fileModels.defaultModel)}
						{type.fileModels.models?.length ? `, or ${type.fileModels.models.map((m) => modelName(models, m)).join(", ")}` : ""}.
					</span>
					<button onClick={() => void save(null)} data-testid="agent-models-reset">
						Reset
					</button>
				</div>
			)}
			{error && <div className="msg error small">{error}</div>}
		</div>
	);
}
