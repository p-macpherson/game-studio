// UI (M10): the game's screens, edited over a live, paused engine view (click an element to select it, drag to
// move it, drag its corner to resize it, the inspector for the rest, sample values for its bindings), and its UI
// art (frames, buttons, icons: candidates, the made piece stretched as screens use it, its slice insets).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { leafName } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { parseUiArt, UI_ART_KINDS, type UiArtKind } from "../../shared/ui-art";
import {
	ANCHORS,
	allElements,
	applyUiEdits,
	ELEMENT_TYPES,
	type ElementType,
	find,
	formatUiScreen,
	parseUiScreen,
	screenInterface,
	type UiEdit,
	type UiElement,
	type UiScreen,
} from "../../shared/ui-screen";
import { call, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { editCheckout, runInWorktree } from "../../renderer/workspace";
import { ART_ROOT, artImage, artName, dragEdit, isArt, screenName, UI_ROOT } from "./info";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
const quiet = <T,>(p: Promise<T>) => p.catch(() => undefined);
/** The engine's UI space is 720 units tall. */
const UI_HEIGHT = 720;

export function UiView({ module }: { module: ModuleInfo }) {
	const [creating, setCreating] = useState<"choose" | "screen" | "art" | null>(null);
	const assetsVersion = useStudio((s) => s.assetsVersion);
	return (
		<>
			<AssetBrowser
				module={module}
				newLabel="+ New…"
				onNew={() => setCreating("choose")}
				modifyLabel="Ask the UI designer"
				modifyPlaceholder="What should change? Screens (title, HUD, pause, win, settings) and their art: frames, buttons, icons, layout. The UI Designer reports what the game code must show and handle."
				emptyText="No UI yet. Start a screen with “New screen”, or make UI art (frames, buttons, icons) with “New UI art”."
				itemPreview={(a, checkout) =>
					isArt(a.path) ? <img className="ui-art-thumb" src={studioFile(checkout, `assets/${artImage(artName(a.path))}`, `${assetsVersion}`)} alt="" /> : null
				}
				content={(props) =>
					isArt(props.asset.path) ? (
						<ArtDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />
					) : (
						<ScreenDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} onNewArt={() => setCreating("art")} />
					)
				}
			/>
			{creating === "choose" && (
				<div className="modal-backdrop" onClick={() => setCreating(null)}>
					<div className="modal col" style={{ width: 460 }} onClick={(e) => e.stopPropagation()} data-testid="ui-new-choose">
						<h3>New…</h3>
						<button className="agent-type" onClick={() => setCreating("screen")} data-testid="ui-new-choose-screen">
							<strong>Screen</strong>
							<small>A menu, HUD, pause or win screen: panels, text, images and buttons the engine draws over the game.</small>
						</button>
						<button className="agent-type" onClick={() => setCreating("art")} data-testid="ui-new-choose-art">
							<strong>UI art</strong>
							<small>A frame for panels, a button, or an icon: generated in the game's style, cut out, ready to stretch.</small>
						</button>
					</div>
				</div>
			)}
			{creating === "screen" && <NewScreenDialog onClose={() => setCreating(null)} />}
			{creating === "art" && <NewArtDialog onClose={() => setCreating(null)} />}
		</>
	);
}

// --- Screens ----------------------------------------------------------------------------------------------------

/** An element as the engine laid it out last frame (`ui_tree`): rect in UI units, px in frame pixels. */
interface Node {
	screen: string;
	id: string;
	type: string;
	depth: number;
	rect: number[];
	px: number[];
	text: string;
	visible: boolean;
}

type Drag = { kind: "move" | "resize"; id: string; x0: number; y0: number; dx: number; dy: number };

const valuesKey = (project: string, screen: string) => `ui-values:${project}:${screen}`;

function ScreenDetail({ asset, text, checkout: shownCheckout, onNewArt }: AssetContentProps & { onNewArt(): void }) {
	const { run, frame, showError, project, assetsVersion } = useStudio(
		useShallow((s) => ({ run: s.run, frame: s.frame, showError: s.showError, project: s.project, assetsVersion: s.assetsVersion })),
	);
	const name = screenName(asset.path);
	const checkout = shownCheckout ?? null;
	const parsed = useMemo(() => (text ? parseUiScreen(text) : null), [text]);
	const screen = parsed?.screen ?? null;
	const ours = !!run && run.screen === name && run.sessionId === checkout;
	const live = ours && run.state === "running";
	// Another editor's live view (Scenes, another screen) gives way; a game in Play & Test is asked about first.
	const otherGame = !!run && !ours && !run.scene && !run.screen && ["building", "starting", "running"].includes(run.state);
	const [selected, setSelected] = useState<string | null>(null);
	const [nodes, setNodes] = useState<Node[]>([]);
	const [busy, setBusy] = useState(false);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [art, setArt] = useState<{ name: string; kind: UiArtKind }[]>([]);
	const shown = useRef<string | null>(null);
	const expected = useRef<string | null>(null);
	const [values, setValuesState] = useState<Record<string, string>>(() => {
		try {
			return JSON.parse(localStorage.getItem(valuesKey(project?.path ?? "", name)) ?? "{}");
		} catch {
			return {};
		}
	});
	const iface = useMemo(() => (screen ? screenInterface(screen) : { bindings: [], actions: [] }), [screen]);

	const start = useCallback(() => quiet(call("run.start", checkout, "hidden", { screen: name }).catch(showError)), [checkout, name, showError]);
	useEffect(() => {
		if (!ours && !otherGame) void start();
		void quiet(call("run.stream", true));
		return () => void quiet(call("run.stream", false));
		// Only when the screen opens: later runs are started from the buttons.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** Has the engine re-read the screen file now; an engine older than `ui_reload` re-reads it within half a second. */
	const reload = useCallback(async () => {
		await call("run.call", "ui_reload").catch(() => new Promise((r) => setTimeout(r, 700)));
	}, []);

	const refreshTree = useCallback(async () => {
		await call("run.call", "wait", { frames: 2 });
		const all = (await call("run.call", "ui_tree")) as Node[];
		setNodes(all.filter((n) => n.screen === name));
	}, [name]);

	// A new live run: its sample values, then the layout.
	useEffect(() => {
		if (!live) return;
		shown.current = text;
		void (async () => {
			if (Object.keys(values).length) await call("run.call", "ui_set", { values, pin: true });
			await refreshTree();
		})().catch(showError);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [live, run?.id]);

	// The file changed (our edit, an agent, a merge): the engine re-reads it now, then the layout is read again.
	useEffect(() => {
		if (!live || !text || text === shown.current) return;
		shown.current = text;
		void (async () => {
			await reload();
			await refreshTree();
		})().catch(showError);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, live]);

	// The UI art screens can use, for the frame and image pickers.
	useEffect(() => {
		let alive = true;
		call("assets.list", "ui", checkout).then(async (list) => {
			const pieces = await Promise.all(
				list
					.filter((a) => isArt(a.path) && a.change !== "deleted")
					.map(async (a) => {
						const { art: piece } = parseUiArt(await call("assets.read", a.path, checkout).catch(() => ""));
						return piece?.source ? { name: artName(a.path), kind: piece.kind } : null;
					}),
			);
			if (alive) setArt(pieces.filter((p): p is { name: string; kind: UiArtKind } => !!p));
		}, () => {});
		return () => {
			alive = false;
		};
	}, [checkout, assetsVersion]);

	const setValues = (next: Record<string, string>) => {
		setValuesState(next);
		localStorage.setItem(valuesKey(project?.path ?? "", name), JSON.stringify(next));
		if (live) void (async () => {
			await call("run.call", "ui_set", { values: next, pin: true });
			await refreshTree();
		})().catch(showError);
	};

	const edit = async (edits: UiEdit[]) => {
		if (!screen || busy) return;
		setBusy(true);
		try {
			const ran = await runInWorktree(`UI: ${name}`, "edit_ui", { screen: name, edits });
			if (ran.checkout === shownCheckout) expected.current = formatUiScreen(applyUiEdits(screen, edits));
			bumpAssets();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	const element = selected && screen ? find(screen, selected) : undefined;
	const nodeOf = (id: string) => nodes.find((n) => n.id === id);

	const commitDrag = (d: Drag) => {
		const el = screen && find(screen, d.id);
		const node = nodeOf(d.id);
		if (!el || !node || !frame) return;
		const e = dragEdit(el, { w: node.rect[2], h: node.rect[3] }, d, frame.height);
		if (e) void edit([e]);
	};

	if (!parsed) return <div className="muted pad">Loading…</div>;
	if (!screen) {
		return (
			<div className="card scene-problems" data-testid="ui-problems">
				<h3>This screen can't be read</h3>
				{parsed.problems.map((p, i) => (
					<div key={i}>
						{p.at && <code>{p.at}</code>} {p.message}
					</div>
				))}
			</div>
		);
	}

	return (
		<div className="scene-editor ui-editor" data-testid="ui-editor">
			<ElementOutline
				screen={screen}
				selected={selected}
				onSelect={setSelected}
				busy={busy}
				onEdit={(e) => void edit(e)}
			/>
			<div className="scene-main">
				<div className="row scene-toolbar">
					<span className="muted small grow">
						{live ? "Click an element to select it · drag to move · drag its corner to resize · arrows nudge (shift: 10)" : ""}
					</span>
					{busy && <span className="muted small">Saving…</span>}
					{live && (
						<button onClick={() => void refreshTree().catch(showError)} title="Read the layout again">
							Refresh
						</button>
					)}
				</div>
				<ScreenViewport
					frame={live && frame?.runId === run?.id ? frame : null}
					nodes={nodes}
					selected={selected}
					drag={drag}
					onSelect={setSelected}
					onDrag={setDrag}
					onDrop={(d) => {
						setDrag(null);
						commitDrag(d);
					}}
					onKey={(e) => {
						if (!element) return;
						if (e.key === "Delete" || e.key === "Backspace") return void edit([{ op: "delete", id: element.id }]).then(() => setSelected(null));
						const step = e.shiftKey ? 10 : 1;
						const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
						if (!dir) return;
						e.preventDefault();
						const a = element.anchor ?? "top_left";
						const [ox, oy] = element.offset ?? [0, 0];
						void edit([{ op: "set", id: element.id, fields: { offset: [ox + dir[0] * step * (a.endsWith("right") ? -1 : 1), oy + dir[1] * step * (a.startsWith("bottom") ? -1 : 1)] } }]);
					}}
					placeholder={
						otherGame ? (
							<div className="col" style={{ alignItems: "center" }}>
								<span>The game is running in Play &amp; Test.</span>
								<button className="primary" onClick={() => void start()}>
									Show this screen here (stops it)
								</button>
							</div>
						) : run && ours && (run.state === "exited" || run.state === "build_failed") ? (
							<div className="col" style={{ alignItems: "center" }}>
								<span>{run.state === "build_failed" ? "The game doesn't build: see Play & Test for the errors." : "The live view stopped."}</span>
								<button className="primary" onClick={() => void start()}>
									Restart the live view
								</button>
							</div>
						) : !ours ? (
							<button className="primary" onClick={() => void start()}>
								Open the live view
							</button>
						) : (
							<span>{run?.state === "building" ? "Building the game…" : "Starting the game…"}</span>
						)
					}
				/>
				{parsed.problems.length > 0 && (
					<div className="card scene-problems" data-testid="ui-problems">
						<h3>Problems</h3>
						{parsed.problems.map((p, i) => (
							<div key={i}>
								{p.at && <code>{p.at}</code>} {p.message}
							</div>
						))}
					</div>
				)}
				<SampleValues bindings={iface.bindings} actions={iface.actions} values={values} onChange={setValues} />
			</div>
			<div className="scene-inspector" data-testid="ui-inspector">
				{element ? (
					<ElementInspector key={element.id} element={element} art={art} busy={busy} onNewArt={onNewArt} onSet={(fields) => void edit([{ op: "set", id: element.id, fields }])} />
				) : (
					<ScreenSettings screen={screen} busy={busy} onSet={(fields) => void edit([{ op: "screen", fields }])} />
				)}
			</div>
		</div>
	);
}

function ScreenViewport({
	frame,
	nodes,
	selected,
	drag,
	onSelect,
	onDrag,
	onDrop,
	onKey,
	placeholder,
}: {
	frame: { src: string; width: number; height: number } | null;
	nodes: Node[];
	selected: string | null;
	drag: Drag | null;
	onSelect(id: string | null): void;
	onDrag(d: Drag | null): void;
	onDrop(d: Drag): void;
	onKey(e: React.KeyboardEvent): void;
	placeholder: React.ReactNode;
}) {
	if (!frame) return <div className="viewport scene-viewport empty">{placeholder}</div>;
	/** The topmost visible element under a point (frame pixels): the deepest, then the last drawn. */
	const hit = (x: number, y: number) => {
		let best: Node | undefined;
		nodes.forEach((n) => {
			if (!n.visible) return;
			const [px, py, w, h] = n.px;
			if (x >= px && y >= py && x <= px + w && y <= py + h && (!best || n.depth >= best.depth)) best = n;
		});
		return best;
	};
	const pct = (v: number, of: number) => `${(v / of) * 100}%`;
	const sel = nodes.find((n) => n.id === selected && n.visible);
	const ghost = sel && drag && drag.id === sel.id ? (drag.kind === "move" ? [sel.px[0] + drag.dx, sel.px[1] + drag.dy, sel.px[2], sel.px[3]] : [sel.px[0], sel.px[1], Math.max(4, sel.px[2] + drag.dx), Math.max(4, sel.px[3] + drag.dy)]) : null;
	// Pointer capture keeps every move and the release coming to the overlay until the drag ends, wherever the
	// pointer goes (window mouse listeners lost them when a drag started on the handle).
	const toFrame = (e: React.PointerEvent<HTMLDivElement>) => frame.width / e.currentTarget.getBoundingClientRect().width;
	return (
		<div className="viewport scene-viewport ui-viewport" tabIndex={0} onKeyDown={onKey} data-testid="ui-viewport">
			<div className="ui-frame" style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
				<img src={frame.src} alt="" draggable={false} />
				<div
					className="ui-overlay"
					data-testid="ui-overlay"
					onDragStart={(e) => e.preventDefault()}
					onPointerDown={(e) => {
						if (e.button !== 0) return;
						const onHandle = (e.target as HTMLElement).dataset.testid === "ui-resize";
						e.currentTarget.setPointerCapture(e.pointerId);
						if (onHandle && sel) return onDrag({ kind: "resize", id: sel.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
						const r = e.currentTarget.getBoundingClientRect();
						const k = toFrame(e);
						const n = hit((e.clientX - r.left) * k, (e.clientY - r.top) * k);
						onSelect(n?.id ?? null);
						if (n) onDrag({ kind: "move", id: n.id, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
					}}
					onPointerMove={(e) => {
						if (!drag) return;
						const k = toFrame(e);
						onDrag({ ...drag, dx: (e.clientX - drag.x0) * k, dy: (e.clientY - drag.y0) * k });
					}}
					onPointerUp={(e) => {
						if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
						if (drag) onDrop(drag);
					}}
					onPointerCancel={() => onDrag(null)}
				>
					{nodes
						.filter((n) => n.visible && n.id !== selected)
						.map((n) => (
							<div key={n.id} className="ui-node" style={{ left: pct(n.px[0], frame.width), top: pct(n.px[1], frame.height), width: pct(n.px[2], frame.width), height: pct(n.px[3], frame.height) }} />
						))}
					{sel && (
						<div
							className="ui-node selected"
							data-testid="ui-selected"
							style={{ left: pct(sel.px[0], frame.width), top: pct(sel.px[1], frame.height), width: pct(sel.px[2], frame.width), height: pct(sel.px[3], frame.height) }}
						>
							<span className="ui-node-label">{sel.id}</span>
							<div className="ui-handle" data-testid="ui-resize" title="Drag to resize" />
						</div>
					)}
					{ghost && (drag!.dx !== 0 || drag!.dy !== 0) && (
						<div className="ui-node ghost" style={{ left: pct(ghost[0], frame.width), top: pct(ghost[1], frame.height), width: pct(ghost[2], frame.width), height: pct(ghost[3], frame.height) }} />
					)}
				</div>
			</div>
		</div>
	);
}

const TYPE_ICON: Record<ElementType, string> = { panel: "▭", text: "T", image: "🖼", button: "⏺", slider: "⎯", checkbox: "☑", bar: "▬", stack: "☰" };
const CONTAINERS: ElementType[] = ["panel", "stack"];

/** A new element of a type, with an id not yet used and sizes that show up. */
function newElement(type: ElementType, screen: UiScreen): UiElement {
	const taken = new Set(allElements(screen).map((x) => x.element.id));
	let n = 1;
	while (taken.has(`${type}${n === 1 ? "" : n}`)) n++;
	const id = `${type}${n === 1 ? "" : n}`;
	switch (type) {
		case "text":
			return { id, type, text: "Text" };
		case "button":
			return { id, type, text: "Button", size: [220, 56], action: id };
		case "slider":
			return { id, type, text: "Volume", bind: id, size: [260, 40], action: id };
		case "checkbox":
			return { id, type, text: "Option", bind: id, size: [220, 32], action: id };
		case "bar":
			return { id, type, bind: id, size: [200, 16] };
		case "image":
			return { id, type, image: "", size: [64, 64] };
		case "stack":
			return { id, type, size: [260, 200], gap: 12 };
		default:
			return { id, type, size: [300, 200], padding: 16 };
	}
}

function ElementOutline({ screen, selected, onSelect, busy, onEdit }: { screen: UiScreen; selected: string | null; onSelect(id: string | null): void; busy: boolean; onEdit(e: UiEdit[]): void }) {
	const [adding, setAdding] = useState(false);
	const list = allElements(screen);
	const sel = selected ? list.find((x) => x.element.id === selected) : undefined;
	const parentFor = sel && CONTAINERS.includes(sel.element.type) ? sel.element.id : (sel?.parent ?? undefined);
	const siblings = sel ? list.filter((x) => x.parent === sel.parent).map((x) => x.element.id) : [];
	const at = sel ? siblings.indexOf(sel.element.id) : -1;
	return (
		<div className="scene-outline" data-testid="ui-outline">
			<div className="row">
				<b className="grow">Elements</b>
				<div style={{ position: "relative" }}>
					<button className="small" disabled={busy} onClick={() => setAdding(!adding)} data-testid="ui-add">
						+ Add
					</button>
					{adding && (
						<div className="card ui-add-menu" onMouseLeave={() => setAdding(false)}>
							<span className="muted small">{parentFor ? `Into ${parentFor}` : "At the top level"}</span>
							{ELEMENT_TYPES.map((t) => (
								<button
									key={t}
									className="ghost nav-item"
									onClick={() => {
										setAdding(false);
										const el = newElement(t, screen);
										onEdit([{ op: "add", element: el, ...(parentFor ? { parent: parentFor } : {}) }]);
										onSelect(el.id);
									}}
									data-testid="ui-add-type"
								>
									<span className="ui-type-icon">{TYPE_ICON[t]}</span> {t}
								</button>
							))}
						</div>
					)}
				</div>
			</div>
			<div className="outline-items">
				<button className={`ghost nav-item ${selected === null ? "active" : ""}`} onClick={() => onSelect(null)}>
					<span className="muted">Screen settings</span>
				</button>
				{list.map(({ element: e, depth }) => (
					<button
						key={e.id}
						className={`ghost nav-item outline-item ${selected === e.id ? "active" : ""}`}
						style={{ paddingLeft: 10 + depth * 14 }}
						onClick={() => onSelect(e.id)}
						data-testid="ui-outline-item"
					>
						<span className="ui-type-icon">{TYPE_ICON[e.type] ?? "?"}</span>
						<span className="grow ellipsis">{e.id}</span>
						{e.text && <span className="muted small ellipsis">{e.text}</span>}
					</button>
				))}
			</div>
			{sel && (
				<div className="row">
					<button className="small" disabled={busy || at <= 0} onClick={() => onEdit([{ op: "move", id: sel.element.id, parent: sel.parent, index: at - 1 }])} title="Earlier (drawn below; earlier in a stack)">
						↑
					</button>
					<button className="small" disabled={busy || at < 0 || at >= siblings.length - 1} onClick={() => onEdit([{ op: "move", id: sel.element.id, parent: sel.parent, index: at + 1 }])} title="Later (drawn above; later in a stack)">
						↓
					</button>
					<span className="grow" />
					<button className="small danger" disabled={busy} onClick={() => (onEdit([{ op: "delete", id: sel.element.id }]), onSelect(null))} data-testid="ui-delete">
						Delete
					</button>
				</div>
			)}
		</div>
	);
}

/** A text input that commits on Enter or leaving it; empty clears the field (the engine's default). */
function Field({ label, value, onCommit, placeholder, testid }: { label: string; value: string; onCommit(v: string): void; placeholder?: string; testid?: string }) {
	const [v, setV] = useState(value);
	useEffect(() => setV(value), [value]);
	return (
		<label className="field ui-field">
			<span>{label}</span>
			<input
				value={v}
				placeholder={placeholder}
				onChange={(e) => setV(e.target.value)}
				onBlur={() => v !== value && onCommit(v)}
				onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
				data-testid={testid}
			/>
		</label>
	);
}

const num = (s: string): number | null => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);

function PairField({ label, value, names, onCommit, testid }: { label: string; value?: number[]; names: [string, string]; onCommit(v: [number, number] | null): void; testid?: string }) {
	const [a, b] = value ?? [];
	const commit = (i: number, s: string) => {
		const n = num(s);
		const next: [number, number] = [a ?? 0, b ?? 0];
		next[i] = n ?? 0;
		onCommit(next[0] === 0 && next[1] === 0 ? null : next);
	};
	return (
		<div className="field ui-field">
			<span>{label}</span>
			<div className="row">
				<SmallNumber title={names[0]} value={a} onCommit={(s) => commit(0, s)} testid={testid && `${testid}-0`} />
				<SmallNumber title={names[1]} value={b} onCommit={(s) => commit(1, s)} testid={testid && `${testid}-1`} />
			</div>
		</div>
	);
}

function SmallNumber({ title, value, onCommit, testid }: { title: string; value?: number; onCommit(v: string): void; testid?: string }) {
	const [v, setV] = useState(value === undefined ? "" : String(value));
	useEffect(() => setV(value === undefined ? "" : String(value)), [value]);
	return (
		<input
			className="ui-num"
			title={title}
			placeholder={title}
			value={v}
			onChange={(e) => setV(e.target.value)}
			onBlur={() => v !== (value === undefined ? "" : String(value)) && onCommit(v)}
			onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
			data-testid={testid}
		/>
	);
}

function ArtPicker({ label, value, art, kinds, onCommit, onNewArt, testid }: { label: string; value?: string; art: { name: string; kind: UiArtKind }[]; kinds: UiArtKind[]; onCommit(v: string | null): void; onNewArt(): void; testid?: string }) {
	const choices = art.filter((a) => kinds.includes(a.kind));
	return (
		<label className="field ui-field">
			<span>{label}</span>
			<div className="row">
				<select className="grow" value={value ?? ""} onChange={(e) => (e.target.value === "__new" ? onNewArt() : onCommit(e.target.value || null))} data-testid={testid}>
					<option value="">None</option>
					{choices.map((a) => (
						<option key={a.name} value={artImage(a.name)}>
							{a.name} ({a.kind})
						</option>
					))}
					{value && !choices.some((a) => artImage(a.name) === value) && <option value={value}>{value}</option>}
					<option value="__new">+ New UI art…</option>
				</select>
			</div>
		</label>
	);
}

function ElementInspector({ element: e, art, busy, onSet, onNewArt }: { element: UiElement; art: { name: string; kind: UiArtKind }[]; busy: boolean; onSet(f: Record<string, unknown>): void; onNewArt(): void }) {
	const str = (k: keyof UiElement) => (e[k] === undefined ? "" : String(e[k]));
	const set = (k: string) => (v: string) => onSet({ [k]: v === "" ? null : v });
	const setNum = (k: string) => (v: string) => onSet({ [k]: num(v) });
	const t = e.type;
	const hasText = ["text", "button", "slider", "checkbox"].includes(t);
	return (
		<div className="col ui-inspector" data-testid="ui-element-inspector">
			<div className="row">
				<b className="grow">
					{e.id} <span className="muted">{t}</span>
				</b>
				{busy && <span className="muted small">Saving…</span>}
			</div>
			<label className="field ui-field">
				<span>Anchor</span>
				<select value={e.anchor ?? "top_left"} onChange={(ev) => onSet({ anchor: ev.target.value === "top_left" ? null : ev.target.value })} data-testid="ui-anchor">
					{ANCHORS.map((a) => (
						<option key={a}>{a}</option>
					))}
				</select>
			</label>
			<PairField label="Offset" value={e.offset} names={["x", "y"]} onCommit={(v) => onSet({ offset: v })} testid="ui-offset" />
			<PairField label="Size" value={e.size} names={["w", "h"]} onCommit={(v) => onSet({ size: v })} testid="ui-size" />
			{hasText && <Field label="Text" value={str("text")} onCommit={set("text")} placeholder="Gold: {gold}" testid="ui-text" />}
			{hasText && (
				<div className="row">
					<label className="field ui-field">
						<span>Font size</span>
						<SmallNumber title="font size" value={e.font_size} onCommit={setNum("font_size")} />
					</label>
					<Field label="Colour" value={str("color")} onCommit={set("color")} placeholder="#rrggbb" />
				</div>
			)}
			{t === "text" && (
				<label className="field ui-field">
					<span>Align</span>
					<select value={e.align ?? "left"} onChange={(ev) => onSet({ align: ev.target.value === "left" ? null : ev.target.value })}>
						{["left", "center", "right"].map((a) => (
							<option key={a}>{a}</option>
						))}
					</select>
				</label>
			)}
			{(t === "panel" || t === "stack" || t === "button") && (
				<>
					<ArtPicker label="Frame" value={e.frame} art={art} kinds={t === "button" ? ["button", "frame"] : ["frame", "button"]} onCommit={(v) => onSet({ frame: v })} onNewArt={onNewArt} testid="ui-frame" />
					{e.frame && (
						<label className="field ui-field">
							<span>Corner size</span>
							<SmallNumber title="border (UI units)" value={e.border} onCommit={setNum("border")} />
						</label>
					)}
				</>
			)}
			{t === "panel" && !e.frame && <Field label="Fill colour" value={str("color")} onCommit={set("color")} placeholder="#rrggbbaa" />}
			{t === "image" && <ArtPicker label="Image" value={e.image} art={art} kinds={["icon", "frame", "button"]} onCommit={(v) => onSet({ image: v ?? "" })} onNewArt={onNewArt} testid="ui-image" />}
			{(t === "image" || e.frame) && <Field label="Tint" value={str("tint")} onCommit={set("tint")} placeholder="#rrggbb" />}
			{(t === "button" || t === "slider" || t === "checkbox") && <Field label="Action" value={str("action")} onCommit={set("action")} placeholder="what the game hears" testid="ui-action" />}
			{(t === "slider" || t === "checkbox" || t === "bar") && <Field label="Binding" value={str("bind")} onCommit={set("bind")} placeholder="volume" />}
			{(t === "slider" || t === "bar") && <PairField label="Min, max" value={e.min !== undefined || e.max !== undefined ? [e.min ?? 0, e.max ?? 1] : undefined} names={["min", "max"]} onCommit={(v) => onSet({ min: v?.[0] ?? null, max: v?.[1] ?? null })} />}
			{t === "stack" && (
				<div className="row">
					<label className="field ui-field">
						<span>Direction</span>
						<select value={e.direction ?? "vertical"} onChange={(ev) => onSet({ direction: ev.target.value === "vertical" ? null : ev.target.value })}>
							<option>vertical</option>
							<option>horizontal</option>
						</select>
					</label>
					<label className="field ui-field">
						<span>Gap</span>
						<SmallNumber title="gap" value={e.gap} onCommit={setNum("gap")} />
					</label>
				</div>
			)}
			{(t === "panel" || t === "stack" || t === "button") && (
				<label className="field ui-field">
					<span>Padding</span>
					<SmallNumber title="padding" value={e.padding} onCommit={setNum("padding")} />
				</label>
			)}
			<Field label="Visible while" value={str("visible")} onCommit={set("visible")} placeholder="has_map, or !has_map" />
		</div>
	);
}

function ScreenSettings({ screen, busy, onSet }: { screen: UiScreen; busy: boolean; onSet(f: Record<string, unknown>): void }) {
	return (
		<div className="col ui-inspector" data-testid="ui-screen-settings">
			<b>Screen settings</b>
			<label className="row">
				<input type="checkbox" disabled={busy} checked={!!screen.pauses} onChange={(e) => onSet({ pauses: e.target.checked || null })} data-testid="ui-pauses" /> Pauses the game while shown
			</label>
			<label className="row">
				<input type="checkbox" disabled={busy} checked={!!screen.modal} onChange={(e) => onSet({ modal: e.target.checked || null })} /> Modal (screens below don't react)
			</label>
			<Field label="Notes" value={screen.notes ?? ""} onCommit={(v) => onSet({ notes: v || null })} placeholder="What it's for" />
			<span className="muted small">Select an element in the outline or the view to edit it.</span>
		</div>
	);
}

/** Values for the screen's bindings while editing (not saved in the file): the game sets the real ones. */
function SampleValues({ bindings, actions, values, onChange }: { bindings: string[]; actions: string[]; values: Record<string, string>; onChange(v: Record<string, string>): void }) {
	if (!bindings.length && !actions.length) return null;
	return (
		<div className="card ui-values" data-testid="ui-values">
			<b>Sample values</b>
			<span className="muted small">For previewing only: the game sets the real ones with engine.ui_set.</span>
			<div className="ui-values-grid">
				{bindings.map((b) => (
					<label key={b} className="row">
						<code>{b}</code>
						<input value={values[b] ?? ""} placeholder="(unset)" onChange={(e) => onChange({ ...values, [b]: e.target.value })} data-testid={`ui-value-${b}`} />
					</label>
				))}
			</div>
			{actions.length > 0 && <div className="muted small">Actions the game handles: {actions.join(", ")}</div>}
		</div>
	);
}

function NewScreenDialog({ onClose }: { onClose(): void }) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const [name, setName] = useState("");
	const [pauses, setPauses] = useState(false);
	const [busy, setBusy] = useState(false);
	const create = async () => {
		const n = name.trim();
		if (!n) return;
		setBusy(true);
		try {
			await runInWorktree(`UI: ${n}`, "edit_ui", {
				screen: n,
				create: true,
				edits: [...(pauses ? [{ op: "screen", fields: { pauses: true, modal: true } }] : []), { op: "add", element: { id: "panel", type: "panel", anchor: "center", size: [380, 300], padding: 24 } }],
			});
			bumpAssets();
			showAsset({ path: `${UI_ROOT}/${n}.json` });
			onClose();
		} catch (err) {
			showError(err);
			setBusy(false);
		}
	};
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal col" style={{ width: 480 }} onClick={(e) => e.stopPropagation()} data-testid="ui-new-screen">
				<h3>New screen</h3>
				<label className="field">
					<span>Name (what the game shows it by: engine.ui_show("…"))</span>
					<input autoFocus value={name} placeholder="title, hud, pause, win" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} data-testid="ui-new-screen-name" />
				</label>
				<label className="row">
					<input type="checkbox" checked={pauses} onChange={(e) => setPauses(e.target.checked)} /> A menu that pauses the game (pause, settings)
				</label>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={onClose}>Cancel</button>
					<button className="primary" disabled={busy || !/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/.test(name.trim())} onClick={() => void create()} data-testid="ui-new-screen-create">
						Create
					</button>
				</div>
			</div>
		</div>
	);
}

// --- Art --------------------------------------------------------------------------------------------------------

/** A 9-slice preview with CSS border-image, drawn as the engine does: the largest inset `border` px wide. */
function NineSlice({ src, slice, w, h, border, label }: { src: string; slice: number[]; w: number; h: number; border: number; label?: string }) {
	const k = border / Math.max(1, ...slice);
	const [l, t, r, b] = slice;
	return (
		<div
			className="ui-nine"
			style={{
				width: w,
				height: h,
				borderStyle: "solid",
				borderImageSource: `url("${src}")`,
				borderImageSlice: `${t} ${r} ${b} ${l} fill`,
				borderImageWidth: `${t * k}px ${r * k}px ${b * k}px ${l * k}px`,
				borderImageRepeat: "stretch",
			}}
		>
			{label}
		</div>
	);
}

function ArtDetail({ asset, text, checkout }: AssetContentProps) {
	const { showError, assetsVersion } = useStudio(useShallow((s) => ({ showError: s.showError, assetsVersion: s.assetsVersion })));
	const name = artName(asset.path);
	const dir = `${ART_ROOT}/${name}`;
	const { art } = useMemo(() => parseUiArt(text), [text]);
	const [busy, setBusy] = useState(false);
	const [candidates, setCandidates] = useState<{ source: string; slice: number[] }[]>([]);
	const [slice, setSlice] = useState<number[]>(art?.slice ?? []);
	const [prompt, setPrompt] = useState(art?.prompt ?? "");
	useEffect(() => setSlice(art?.slice ?? []), [art?.slice?.join(",")]);
	const v = `${assetsVersion}`;
	useEffect(() => {
		let alive = true;
		call("ui.artCandidates", checkout ?? null, name).then(
			(c) => alive && setCandidates(c),
			() => alive && setCandidates([]),
		);
		return () => {
			alive = false;
		};
	}, [name, checkout, assetsVersion]);
	const run = async (method: "make_ui_art" | "generate_ui_art", params: Record<string, unknown>) => {
		setBusy(true);
		try {
			await runInWorktree(`UI art: ${name}`, method, { name, ...params });
			bumpAssets();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};
	if (!art) return <div className="muted pad">This art's file can't be read.</div>;
	const made = studioFile(checkout, `${dir}/${leafName(name)}.png`, v);
	return (
		<div className="col ui-art-detail" data-testid="ui-art-detail">
			<div className="row">
				<span className="badge">{art.kind}</span>
				<span className="muted grow ellipsis">{art.notes ?? art.prompt}</span>
				{art.source && (
					<code className="muted small" title="What screens put in frame or image">
						{artImage(name)}
					</code>
				)}
			</div>
			{art.source ? (
				<div className="card col">
					<b>As screens use it</b>
					{art.kind === "icon" ? (
						<div className="row ui-icon-preview">
							{[48, 96].map((px) => (
								<img key={px} src={made} width={px} height={px} alt="" />
							))}
						</div>
					) : (
						<>
							<div className="row ui-nine-row" data-testid="ui-nine">
								{(art.kind === "button"
									? [
											[220, 56, 26, "Play"],
											[300, 70, 30, "Settings"],
											[120, 44, 22, "OK"],
										]
									: [
											[200, 80, 22, ""],
											[360, 60, 20, ""],
											[220, 160, 30, ""],
										]
								).map(([w, h, b, label], i) => (
									<NineSlice key={i} src={made} slice={slice.length === 4 ? slice : (art.slice ?? [0, 0, 0, 0])} w={w as number} h={h as number} border={b as number} label={label as string} />
								))}
							</div>
							<div className="row">
								<span className="muted small">Slice (the corners that don't stretch, in pixels): left, top, right, bottom</span>
								{[0, 1, 2, 3].map((i) => (
									<input
										key={i}
										className="ui-num"
										value={slice[i] ?? ""}
										onChange={(e) => {
											const next = [...(slice.length === 4 ? slice : [0, 0, 0, 0])];
											next[i] = Math.max(0, Math.round(Number(e.target.value) || 0));
											setSlice(next);
										}}
										data-testid={`ui-slice-${i}`}
									/>
								))}
								<button className="small" disabled={busy || slice.join(",") === (art.slice ?? []).join(",")} onClick={() => void run("make_ui_art", { slice })} data-testid="ui-slice-apply">
									Apply
								</button>
							</div>
						</>
					)}
				</div>
			) : (
				<div className="muted">Not made yet: choose a candidate below.</div>
			)}
			<div className="col">
				<b>Candidates</b>
				<div className="ui-candidates">
					{candidates.map((c) => (
						<div key={c.source} className={`card col ui-candidate ${art.source === c.source ? "on" : ""}`} data-testid="ui-candidate">
							<img src={studioFile(checkout, `${dir}/${c.source}`, v)} alt="" />
							<div className="row">
								<span className="muted small grow ellipsis">{c.source.replace("candidates/", "")}</span>
								{art.source === c.source ? (
									<span className="badge">in use</span>
								) : (
									<button className="small" disabled={busy} onClick={() => void run("make_ui_art", { source: c.source })} data-testid="ui-candidate-use">
										Use
									</button>
								)}
							</div>
						</div>
					))}
				</div>
				<div className="row">
					<input className="grow" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What it shows" />
					<button disabled={busy || !prompt.trim()} onClick={() => void run("generate_ui_art", { kind: art.kind, prompt: prompt.trim(), count: 2 })} data-testid="ui-art-more">
						{busy ? "Working…" : "More candidates"}
					</button>
				</div>
			</div>
		</div>
	);
}

function NewArtDialog({ onClose }: { onClose(): void }) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const [name, setName] = useState("");
	const [kind, setKind] = useState<UiArtKind>("frame");
	const [prompt, setPrompt] = useState("");
	const [style, setStyle] = useState(() => localStorage.getItem("ui-art-style") ?? "");
	const [busy, setBusy] = useState(false);
	const create = async () => {
		setBusy(true);
		try {
			const id = await editCheckout(`UI art: ${name}`);
			if (style.trim()) localStorage.setItem("ui-art-style", style.trim());
			await call("worktrees.run", id, "generate_ui_art", { name: name.trim(), kind, prompt: prompt.trim(), ...(style.trim() ? { style: style.trim() } : {}), count: 3 });
			bumpAssets();
			showAsset({ path: `${ART_ROOT}/${name.trim()}/${leafName(name.trim())}.json` });
			onClose();
		} catch (err) {
			showError(err);
			setBusy(false);
		}
	};
	return (
		<div className="modal-backdrop" onClick={() => !busy && onClose()}>
			<div className="modal col" style={{ width: 560 }} onClick={(e) => e.stopPropagation()} data-testid="ui-new-art-dialog">
				<h3>New UI art</h3>
				<div className="row">
					{UI_ART_KINDS.map((k) => (
						<button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
							{k === "frame" ? "Frame (panels)" : k === "button" ? "Button" : "Icon"}
						</button>
					))}
				</div>
				<label className="field">
					<span>Name</span>
					<input value={name} placeholder={kind === "icon" ? "icons/coin" : kind === "button" ? "button" : "panel"} onChange={(e) => setName(e.target.value)} data-testid="ui-new-art-name" />
				</label>
				<label className="field">
					<span>What it shows</span>
					<input value={prompt} placeholder={kind === "icon" ? "a gold coin with a goblin face" : "a carved wooden border with gold rivets, a plain parchment inside"} onChange={(e) => setPrompt(e.target.value)} data-testid="ui-new-art-prompt" />
				</label>
				<label className="field">
					<span>Art direction (kept for next time)</span>
					<input value={style} placeholder="whimsical hand-painted fantasy, warm colours" onChange={(e) => setStyle(e.target.value)} />
				</label>
				<span className="muted small">Three candidates on the GPU (about 10 s each), cut out and, for frames and buttons, made symmetric with their stretch insets.</span>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button disabled={busy} onClick={onClose}>
						Cancel
					</button>
					<button className="primary" disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void create()} data-testid="ui-new-art-create">
						{busy ? "Generating…" : "Generate"}
					</button>
				</div>
			</div>
		</div>
	);
}
