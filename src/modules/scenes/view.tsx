// Scenes: the game's levels (and prefabs) as a studio section. A scene is shown live in the game's own engine,
// paused, with a free orbit camera; click to select (the engine's mesh \`pick\`), inspect and edit components,
// move and place things, delete and duplicate. The file is the truth: every edit is a structured change to the
// JSON in a session's worktree (\`edit_scene\`), mirrored into the live game by respawning what it touched.
import { type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, ModuleInfo } from "../../shared/modules";
import {
	applyEdits,
	type ComponentSchema,
	componentsOf,
	effectiveComponents,
	entityLabel,
	findEntity,
	formatScene,
	parentOf,
	parseScene,
	rotationDegrees,
	type SceneEdit,
	type SceneEntity,
	type SceneFile,
	subtree,
	validateScene,
} from "../../shared/scene";
import { call } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { workspaceFor } from "../../renderer/workspace";
import { enginePath, isPrefab } from "./info";
import { defaultOrbit, FOV, type Orbit, orbitPosition, pan, project, type Vec3 } from "./orbit";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
const quiet = (p: Promise<unknown>) => p.catch(() => {});
const round3 = (v: number[]): number[] => v.map((n) => Math.round(n * 1000) / 1000 + 0);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const EDITOR_GROUND = "Studio Editor Ground";
/** Components the engine adds at runtime; not for the inspector's "Add component". */
const RUNTIME_COMPONENTS = ["Scene_Ref", "Net_Entity"];

// Remembered per scene across remounts (the view switches from the merged version to a draft on the first edit).
const cameras = new Map<string, Orbit>();
const selections = new Map<string, number | null>();

export function ScenesView({ module }: { module: ModuleInfo }) {
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New scene"
			newPreset={{
				agentType: "level-designer",
				placeholder: "Describe the scene or prefab: what it's for, what's in it, how it should feel to move through.",
			}}
			modifyLabel="Ask the level designer"
			modifyPlaceholder="What should change? The Level Designer places, moves and dresses things, and checks its work with preview_scene."
			emptyText="No scenes yet. Start one with “New scene”."
			content={(props) => <SceneDetail key={`${props.asset.path}:${props.sessionId ?? ""}`} {...props} />}
		/>
	);
}

type Mode = { kind: "select" } | { kind: "move" } | { kind: "place"; entity: Omit<SceneEntity, "id">; label: string };

interface PickReply {
	hit: { entity: number; root: number; scene_id?: number; point: Vec3; normal: Vec3 } | null;
	ground: Vec3 | null;
}

/** Where an entity stands, from the file: its own position, else its prefab root's (children: null). */
function worldPosition(e: SceneEntity, prefabRoot?: SceneEntity): Vec3 | null {
	if (parentOf(e)) return null;
	const own = isObject(e.Transform) ? e.Transform.position : undefined;
	const base = prefabRoot && isObject(prefabRoot.Transform) ? prefabRoot.Transform.position : undefined;
	const p = own ?? base;
	return Array.isArray(p) && p.length === 3 ? (p as Vec3) : [0, 0, 0];
}


function SceneDetail({ asset, text, sessionId, assets }: AssetContentProps) {
	const { run, frame, showAsset, showError, assetsVersion } = useStudio();
	const parsed = useMemo(() => (text ? parseScene(text) : null), [text]);
	const scene = parsed?.scene;
	const prefabFile = isPrefab(asset.path);
	const scenePath = enginePath(asset.path);
	const checkout = sessionId ?? null;
	const ours = !!run && run.scene === scenePath && run.sessionId === checkout;
	const live = ours && run.state === "running";
	const otherGame = !!run && !ours && !run.scene && ["building", "starting", "running"].includes(run.state);

	const [schemas, setSchemas] = useState<ComponentSchema[] | null>(null);
	const ids = useRef(new Map<number, number>());
	const shown = useRef<string | null>(null);
	const expected = useRef<string | null>(null);
	const [selected, setSelectedState] = useState<number | null>(selections.get(asset.path) ?? null);
	const [orbit, setOrbitState] = useState<Orbit>(() => cameras.get(asset.path) ?? defaultOrbit(scene?.entities, prefabFile));
	const [mode, setMode] = useState<Mode>({ kind: "select" });
	const [busy, setBusy] = useState(false);
	const [prefabRoots, setPrefabRoots] = useState<Record<string, SceneEntity>>({});
	const [models, setModels] = useState<AssetSummary[]>([]);
	const [problems, setProblems] = useState<string[]>([]);

	const select = (id: number | null) => {
		selections.set(asset.path, id);
		setSelectedState(id);
	};
	const setOrbit = (o: Orbit) => {
		cameras.set(asset.path, o);
		setOrbitState(o);
	};

	const start = useCallback(() => quiet(call("run.start", checkout, "hidden", { scene: scenePath }).catch(showError)), [checkout, scenePath, showError]);
	useEffect(() => {
		if (!ours && !otherGame) void start();
		void quiet(call("run.stream", true));
		return () => void quiet(call("run.stream", false));
		// Only when the scene opens: later runs are started from the buttons.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Prefabs this scene uses (their roots fill in names and components), and the models that can be placed.
	const prefabPaths = useMemo(() => [...new Set((scene?.entities ?? []).flatMap((e) => (e.prefab ? [e.prefab] : [])))].sort().join("\n"), [scene]);
	useEffect(() => {
		let alive = true;
		Promise.all(
			prefabPaths
				.split("\n")
				.filter(Boolean)
				.map(async (p) => {
					const t = await call("assets.read", `assets/${p}`, sessionId).catch(() => "");
					return [p, parseScene(t).scene?.entities[0]] as const;
				}),
		).then((list) => alive && setPrefabRoots(Object.fromEntries(list.filter(([, e]) => e)) as Record<string, SceneEntity>));
		call("assets.list", "3d-models").then((m) => alive && setModels(m), () => {});
		return () => {
			alive = false;
		};
	}, [prefabPaths, sessionId, assetsVersion]);

	const refreshIds = async () => {
		const rows = (await call("run.call", "entities", { limit: 100000 })) as { id: number; scene_id?: number }[];
		ids.current = new Map(rows.flatMap((r) => (r.scene_id ? [[r.scene_id, r.id] as [number, number]] : [])));
	};

	// A new live run: the component schemas, the file id → entity map, and a floor under a prefab.
	useEffect(() => {
		if (!live) return;
		let alive = true;
		shown.current = text;
		(async () => {
			const comps = (await call("run.call", "components")) as ComponentSchema[];
			if (prefabFile) {
				await call("run.call", "spawn", {
					name: EDITOR_GROUND,
					components: { Transform: { scale: [12, 1, 12] }, Mesh_Renderer: { mesh: "plane", material: { color: [0.3, 0.32, 0.36, 1] } } },
				});
			}
			await refreshIds();
			if (alive) setSchemas(comps);
		})().catch(showError);
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [live, run?.id]);

	useEffect(() => {
		if (live) void quiet(call("run.call", "camera", { position: orbitPosition(orbit), target: orbit.target, fov: FOV }));
	}, [live, run?.id, orbit]);

	// The file changed under us (an agent, a merge): reload the live view. Our own edits are already mirrored.
	useEffect(() => {
		if (!live || !text || text === shown.current) return;
		shown.current = text;
		if (text === expected.current) return;
		void (async () => {
			await call("run.call", "scene_reload");
			await refreshIds();
		})().catch(showError);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, live]);

	useEffect(() => {
		if (!scene) return setProblems(parsed?.errors ?? []);
		const known = assets.filter((a) => isPrefab(a.path)).map((a) => enginePath(a.path));
		setProblems([...(parsed?.errors ?? []), ...validateScene(scene, { schemas: schemas ?? undefined, prefabs: known.length ? known : undefined })]);
	}, [scene, parsed, schemas, assets]);

	/** Respawns what the edits touched (with their children in the file), so the live view matches the file. */
	const mirror = async (next: SceneFile, edits: SceneEdit[], result: { created: number[]; deleted: number[] }) => {
		for (const id of result.deleted) {
			const eid = ids.current.get(id);
			if (eid) await quiet(call("run.call", "destroy", { entity: eid }));
			ids.current.delete(id);
		}
		const touched = new Set<number>(result.created);
		for (const e of edits) {
			if (e.op === "environment") {
				await call("run.call", "environment", { value: Object.fromEntries(Object.entries(e.value).filter(([, v]) => v !== null)) });
			} else if ("id" in e && e.op !== "delete" && e.op !== "duplicate") touched.add(e.id);
		}
		const done = new Set<number>();
		for (const id of touched) {
			if (done.has(id) || !findEntity(next, id)) continue;
			const old = ids.current.get(id);
			if (old) await quiet(call("run.call", "destroy", { entity: old }));
			for (const fid of subtree(next, id)) {
				done.add(fid);
				const e = findEntity(next, fid)!;
				const components: Record<string, unknown> = { Scene_Ref: { id: e.id } };
				for (const name of componentsOf(e)) components[name] = e[name];
				const parent = parentOf(e);
				if (parent) components.Transform = { ...(e.Transform as object), parent: ids.current.get(parent) ?? 0 };
				const r = (await call("run.call", "spawn", { ...(e.prefab ? { prefab: e.prefab } : {}), components })) as { id: number };
				ids.current.set(e.id, r.id);
			}
		}
	};

	const edit = async (edits: SceneEdit[], selectCreated = false) => {
		if (!scene || busy) return;
		setBusy(true);
		try {
			const name = (asset.path.split("/").pop() ?? "").replace(/\.json$/, "");
			const target = await workspaceFor(asset, sessionId, "level-designer", `Scene: ${name}`);
			const result = (await call("workspace.run", target.id, "edit_scene", { path: asset.path, edits })) as { created: number[]; deleted: number[] };
			if (selectCreated && result.created.length) select(result.created[result.created.length - 1]);
			else if (selected !== null && result.deleted.includes(selected)) select(null);
			if (target.id === sessionId) {
				const local = applyEdits(scene, edits);
				expected.current = formatScene(local.scene);
				if (live) await mirror(local.scene, edits, result).catch(showError);
			} else {
				showAsset({ path: asset.path, sessionId: target.id });
			}
			bumpAssets();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	const entity = selected !== null && scene ? findEntity(scene, selected) : undefined;
	const rootOf = (e: SceneEntity) => (e.prefab ? prefabRoots[e.prefab] : undefined);

	const clickFrame = async (x: number, y: number, keepPlacing: boolean) => {
		if (!live) return;
		const r = (await call("run.call", "pick", { x, y })) as PickReply;
		const hitId = r.hit?.scene_id;
		const onSelf = mode.kind === "move" && hitId === selected;
		const surface = r.hit && !onSelf && r.hit.normal[1] > 0.7 ? r.hit.point : r.ground;
		if (mode.kind === "place") {
			if (!surface) return;
			const t = isObject(mode.entity.Transform) ? mode.entity.Transform : {};
			await edit([{ op: "add", entity: { ...mode.entity, Transform: { ...t, position: round3(surface) } } }], true);
			if (!keepPlacing) setMode({ kind: "select" });
		} else if (mode.kind === "move" && entity) {
			if (!surface) return;
			await edit([{ op: "set", id: entity.id, component: "Transform", value: { position: round3(surface) } }]);
			setMode({ kind: "select" });
		} else {
			select(hitId ?? null);
		}
	};

	const focusOn = (e: SceneEntity) => {
		const p = worldPosition(e, rootOf(e));
		if (p) setOrbit({ ...orbit, target: [p[0], p[1], p[2]], distance: Math.min(orbit.distance, 8) });
	};

	const placeables = useMemo(() => {
		const prefabs = assets
			.filter((a) => isPrefab(a.path) && a.path !== asset.path)
			.map((a) => ({ label: a.title.replace(/ \(prefab\)$/, ""), entity: { prefab: enginePath(a.path) } as Omit<SceneEntity, "id"> }));
		const meshes = models.map((m) => {
			const n = m.path.split("/").at(-2) ?? m.title;
			return { label: n, entity: { Name: m.title, Mesh_Renderer: { mesh: `models/${n}/${n}.glb` } } as Omit<SceneEntity, "id"> };
		});
		return { prefabs, meshes };
	}, [assets, asset.path, models]);

	if (!parsed) return <div className="muted pad">Loading…</div>;
	if (!scene) {
		return (
			<div className="card scene-problems" data-testid="scene-problems">
				<h3>This file can't be read</h3>
				{parsed.errors.map((e, i) => (
					<div key={i}>{e}</div>
				))}
			</div>
		);
	}

	const viewHint =
		mode.kind === "place"
			? `Click where the ${mode.label} goes (shift-click to place several) · Esc to stop`
			: mode.kind === "move"
				? "Click where it goes · Esc to cancel"
				: "Click to select · drag to orbit · right-drag to pan · wheel to zoom · F to frame the selection";
	const marker = entity && frame && live ? worldPosition(entity, rootOf(entity)) : null;
	const markerAt = marker && frame ? project(orbit, marker, frame.width, frame.height) : null;

	return (
		<div className="scene-editor" data-testid="scene-editor">
			<Outline scene={scene} prefabRoots={prefabRoots} selected={selected} onSelect={select} onFocus={focusOn} />
			<div className="scene-main">
				<div className="row scene-toolbar">
					<button className={`chip ${mode.kind === "select" ? "on" : ""}`} onClick={() => setMode({ kind: "select" })}>
						Select
					</button>
					<button
						className={`chip ${mode.kind === "move" ? "on" : ""}`}
						disabled={!entity || !!parentOf(entity) || !live}
						title={entity && parentOf(entity) ? "Move its parent instead" : "Click a spot in the view to move the selection there"}
						onClick={() => setMode({ kind: "move" })}
					>
						Move
					</button>
					<PlaceMenu placeables={placeables} disabled={!live} active={mode.kind === "place" ? mode.label : null} onPick={(p) => setMode({ kind: "place", ...p })} />
					<span className="grow" />
					{busy && <span className="muted small">Saving…</span>}
					{live && (
						<button
							onClick={() =>
								void (async () => {
									await call("run.call", "scene_reload");
									await refreshIds();
								})().catch(showError)
							}
							title="Re-read the file into the live view"
						>
							Reload
						</button>
					)}
				</div>
				<SceneViewport
					frame={live && frame?.runId === run?.id ? frame : null}
					orbit={orbit}
					onOrbit={setOrbit}
					onClick={(x, y, shift) => void clickFrame(x, y, shift).catch(showError)}
					onKey={(e) => {
						if (e.key === "Escape") setMode({ kind: "select" });
						else if ((e.key === "Delete" || e.key === "Backspace") && entity) void edit([{ op: "delete", id: entity.id }]);
						else if (e.key.toLowerCase() === "f" && entity) focusOn(entity);
					}}
					hint={viewHint}
					marker={markerAt && entity ? { ...markerAt, label: entityLabel(entity, rootOf(entity)) } : null}
					placeholder={
						otherGame ? (
							<div className="col" style={{ alignItems: "center" }}>
								<span>The game is running in Play &amp; Test.</span>
								<button className="primary" onClick={() => void start()}>
									Open the live view here (stops it)
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
				{problems.length > 0 && (
					<div className="card scene-problems" data-testid="scene-problems">
						<h3>Problems</h3>
						{problems.map((p, i) => (
							<div key={i}>{p}</div>
						))}
					</div>
				)}
			</div>
			<div className="scene-inspector" data-testid="scene-inspector">
				{entity ? (
					<EntityInspector
						key={entity.id}
						entity={entity}
						prefabRoot={rootOf(entity)}
						schemas={schemas}
						busy={busy}
						onEdit={(edits, selectCreated) => void edit(edits, selectCreated)}
						onOpenPrefab={(p) => showAsset({ path: `assets/${p}`, sessionId })}
					/>
				) : (
					<EnvironmentPanel scene={scene} onEdit={(value) => void edit([{ op: "environment", value }])} />
				)}
			</div>
		</div>
	);
}

function Outline({
	scene,
	prefabRoots,
	selected,
	onSelect,
	onFocus,
}: {
	scene: SceneFile;
	prefabRoots: Record<string, SceneEntity>;
	selected: number | null;
	onSelect(id: number | null): void;
	onFocus(e: SceneEntity): void;
}) {
	const depth = (e: SceneEntity): number => {
		let d = 0;
		for (let p = parentOf(e), guard = 0; p && guard < 32; guard++, d++) p = parentOf(findEntity(scene, p) ?? { id: 0 });
		return d;
	};
	return (
		<div className="scene-outline" data-testid="scene-outline">
			<div className={`entity-row ${selected === null ? "selected" : ""}`} onClick={() => onSelect(null)}>
				🌤 <span className="muted">Environment</span>
			</div>
			{scene.entities.map((e) => (
				<div
					key={e.id}
					data-testid="outline-row"
					className={`entity-row ${selected === e.id ? "selected" : ""}`}
					style={{ paddingLeft: 6 + depth(e) * 14 }}
					onClick={() => onSelect(e.id)}
					onDoubleClick={() => onFocus(e)}
					title={`id ${e.id}${e.prefab ? ` · ${e.prefab}` : ""}${e.notes ? `\n${e.notes}` : ""}`}
				>
					<span className="ellipsis">{entityLabel(e, e.prefab ? prefabRoots[e.prefab] : undefined)}</span>
					{e.prefab && <span className="badge">prefab</span>}
				</div>
			))}
		</div>
	);
}

function PlaceMenu({
	placeables,
	disabled,
	active,
	onPick,
}: {
	placeables: { prefabs: { label: string; entity: Omit<SceneEntity, "id"> }[]; meshes: { label: string; entity: Omit<SceneEntity, "id"> }[] };
	disabled: boolean;
	active: string | null;
	onPick(p: { label: string; entity: Omit<SceneEntity, "id"> }): void;
}) {
	const all = [...placeables.prefabs.map((p) => ({ ...p, group: "Prefabs" })), ...placeables.meshes.map((p) => ({ ...p, group: "Models" }))];
	return (
		<select
			className={`place-menu ${active ? "on" : ""}`}
			data-testid="place-menu"
			disabled={disabled || all.length === 0}
			value=""
			onChange={(e) => {
				const p = all[Number(e.target.value)];
				if (p) onPick(p);
			}}
		>
			<option value="">{active ? `Placing: ${active}` : "Place…"}</option>
			{["Prefabs", "Models"].map((g) => (
				<optgroup key={g} label={g}>
					{all.map((p, i) =>
						p.group === g ? (
							<option key={i} value={i}>
								{p.label}
							</option>
						) : null,
					)}
				</optgroup>
			))}
		</select>
	);
}

function SceneViewport({
	frame,
	orbit,
	onOrbit,
	onClick,
	onKey,
	hint,
	marker,
	placeholder,
}: {
	frame: { src: string; width: number; height: number } | null;
	orbit: Orbit;
	onOrbit(o: Orbit): void;
	onClick(x: number, y: number, shift: boolean): void;
	onKey(e: KeyboardEvent): void;
	hint: string;
	marker: { x: number; y: number; label: string } | null;
	placeholder: ReactNode;
}) {
	const img = useRef<HTMLImageElement>(null);
	const drag = useRef<{ x: number; y: number; button: number; shift: boolean; orbit: Orbit; moved: boolean } | null>(null);
	const latest = useRef({ orbit, onOrbit, onClick, frame });
	latest.current = { orbit, onOrbit, onClick, frame };

	const toFrame = (clientX: number, clientY: number) => {
		const r = img.current!.getBoundingClientRect();
		const f = latest.current.frame!;
		return { x: ((clientX - r.left) * f.width) / r.width, y: ((clientY - r.top) * f.height) / r.height };
	};

	useEffect(() => {
		const move = (e: MouseEvent) => {
			const d = drag.current;
			if (!d || !img.current || !latest.current.frame) return;
			const a = toFrame(d.x, d.y);
			const b = toFrame(e.clientX, e.clientY);
			const [dx, dy] = [b.x - a.x, b.y - a.y];
			if (!d.moved && Math.hypot(dx, dy) < 4) return;
			d.moved = true;
			if (d.button === 0 && !d.shift) {
				latest.current.onOrbit({ ...d.orbit, yaw: d.orbit.yaw + dx * 0.3, pitch: Math.max(3, Math.min(89, d.orbit.pitch + dy * 0.3)) });
			} else {
				latest.current.onOrbit(pan(d.orbit, dx, dy, latest.current.frame.height));
			}
		};
		const up = (e: MouseEvent) => {
			const d = drag.current;
			drag.current = null;
			if (!d || d.moved || d.button !== 0 || !img.current || !latest.current.frame) return;
			const p = toFrame(e.clientX, e.clientY);
			latest.current.onClick(Math.round(p.x), Math.round(p.y), e.shiftKey);
		};
		window.addEventListener("mousemove", move);
		window.addEventListener("mouseup", up);
		return () => {
			window.removeEventListener("mousemove", move);
			window.removeEventListener("mouseup", up);
		};
	}, []);

	if (!frame) return <div className="viewport scene-viewport empty">{placeholder}</div>;
	return (
		<div
			className="viewport scene-viewport"
			tabIndex={0}
			data-testid="scene-viewport"
			onKeyDown={onKey}
			onContextMenu={(e) => e.preventDefault()}
			onWheel={(e: WheelEvent) => onOrbit({ ...orbit, distance: Math.max(0.5, Math.min(400, orbit.distance * Math.exp(e.deltaY * 0.001))) })}
		>
			<div className="scene-frame">
				<img
					ref={img}
					src={frame.src}
					alt="Scene view"
					draggable={false}
					onMouseDown={(e: ReactMouseEvent) => {
						(e.currentTarget.closest(".scene-viewport") as HTMLElement | null)?.focus();
						drag.current = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey, orbit, moved: false };
					}}
				/>
				{marker && (
					<div className="scene-marker" style={{ left: `${(marker.x / frame.width) * 100}%`, top: `${(marker.y / frame.height) * 100}%` }}>
						<span>{marker.label}</span>
					</div>
				)}
			</div>
			<div className="viewport-hint">{hint}</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Inspector

function EntityInspector({
	entity,
	prefabRoot,
	schemas,
	busy,
	onEdit,
	onOpenPrefab,
}: {
	entity: SceneEntity;
	prefabRoot?: SceneEntity;
	schemas: ComponentSchema[] | null;
	busy: boolean;
	onEdit(edits: SceneEdit[], selectCreated?: boolean): void;
	onOpenPrefab(path: string): void;
}) {
	const eff = effectiveComponents(entity, prefabRoot);
	const present = Object.keys(eff);
	const addable = (schemas ?? []).map((s) => s.name).filter((n) => !present.includes(n) && !RUNTIME_COMPONENTS.includes(n));
	const set = (component: string, value: Record<string, unknown> | string) => onEdit([{ op: "set", id: entity.id, component, value }]);
	const position = isObject(entity.Transform) ? entity.Transform.position : undefined;
	return (
		<div className="col" data-testid="entity-inspector">
			<div className="row">
				<h3 className="grow ellipsis">{entityLabel(entity, prefabRoot)}</h3>
				<span className="muted small">id {entity.id}</span>
			</div>
			{entity.prefab && (
				<div className="row small">
					<span className="muted">Prefab</span>
					<button className="link" onClick={() => onOpenPrefab(entity.prefab!)}>
						{entity.prefab}
					</button>
				</div>
			)}
			<div className="row">
				<button
					disabled={busy}
					onClick={() => {
						const p = Array.isArray(position) && position.length === 3 ? (position as number[]) : [0, 0, 0];
						onEdit([{ op: "duplicate", id: entity.id, position: parentOf(entity) ? undefined : round3([p[0] + 1, p[1], p[2] + 1]) }], true);
					}}
				>
					Duplicate
				</button>
				<button className="danger" disabled={busy} onClick={() => onEdit([{ op: "delete", id: entity.id }])}>
					Delete
				</button>
			</div>
			<label className="col small">
				<span className="muted">Notes</span>
				<textarea
					rows={2}
					defaultValue={entity.notes ?? ""}
					placeholder="What this is for (kept in the file)"
					onBlur={(e) => e.target.value !== (entity.notes ?? "") && onEdit([{ op: "notes", id: entity.id, notes: e.target.value }])}
				/>
			</label>
			{present.map((name) => (
				<ComponentCard
					key={name}
					name={name}
					schema={schemas?.find((s) => s.name === name)}
					own={entity[name]}
					base={eff[name].fromPrefab ?? (name === "Name" && prefabRoot ? prefabRoot.Name : undefined)}
					onSet={(v) => set(name, v)}
					onRemove={entity[name] !== undefined ? () => onEdit([{ op: "remove_component", id: entity.id, component: name }]) : undefined}
				/>
			))}
			{addable.length > 0 && (
				<select
					value=""
					data-testid="add-component"
					onChange={(e) => e.target.value && set(e.target.value, e.target.value === "Name" ? "Unnamed" : {})}
				>
					<option value="">+ Add component…</option>
					{addable.map((n) => (
						<option key={n}>{n}</option>
					))}
				</select>
			)}
		</div>
	);
}

function ComponentCard({
	name,
	schema,
	own,
	base,
	onSet,
	onRemove,
}: {
	name: string;
	schema?: ComponentSchema;
	own: unknown;
	base: unknown;
	onSet(v: Record<string, unknown> | string): void;
	onRemove?(): void;
}) {
	const header = (
		<div className="row">
			<b className="grow">{name}</b>
			{own === undefined && base !== undefined && <span className="muted small">from prefab</span>}
			{onRemove && (
				<button className="icon" title={base !== undefined ? "Back to the prefab's" : "Remove the component"} onClick={onRemove}>
					×
				</button>
			)}
		</div>
	);
	if (name === "Name" || typeof (own ?? base) === "string") {
		return (
			<div className="component-card" data-testid={`component-${name}`}>
				{header}
				<TextField value={String(own ?? base ?? "")} inherited={own === undefined} onCommit={(v) => onSet(v)} />
			</div>
		);
	}
	const ownObj = isObject(own) ? own : {};
	const baseObj = isObject(base) ? base : {};
	const fields = schema?.fields ?? [...new Set([...Object.keys(baseObj), ...Object.keys(ownObj)])].map((n) => ({ name: n, type: "", values: undefined }));
	return (
		<div className="component-card" data-testid={`component-${name}`}>
			{header}
			{fields.map((f) => {
				const mine = ownObj[f.name];
				const value = mine ?? baseObj[f.name];
				return (
					<div className="field-row" key={f.name}>
						<span className="field-name" title={f.type}>
							{f.name}
						</span>
						<FieldEditor
							name={f.name}
							type={f.type}
							values={f.values}
							value={value}
							inherited={mine === undefined}
							onCommit={(v) => onSet({ [f.name]: v })}
						/>
						{mine !== undefined ? (
							<button className="icon" title="Back to the default" onClick={() => onSet({ [f.name]: null })}>
								↺
							</button>
						) : (
							<span className="icon-space" />
						)}
					</div>
				);
			})}
		</div>
	);
}

const fmt = (n: unknown) => (typeof n === "number" ? String(Math.round(n * 10000) / 10000) : "");

function NumberField({ value, placeholder, inherited, onCommit }: { value: unknown; placeholder?: string; inherited?: boolean; onCommit(v: number): void }) {
	return (
		<input
			key={fmt(value)}
			className={`num ${inherited ? "inherited" : ""}`}
			defaultValue={fmt(value)}
			placeholder={placeholder}
			onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
			onBlur={(e) => {
				const t = e.target.value.trim();
				const n = Number(t);
				if (t !== "" && Number.isFinite(n) && t !== fmt(value)) onCommit(n);
			}}
		/>
	);
}

function TextField({ value, inherited, onCommit }: { value: string; inherited?: boolean; onCommit(v: string): void }) {
	return (
		<input
			key={value}
			className={inherited ? "inherited" : ""}
			defaultValue={value}
			onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
			onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
		/>
	);
}

/** Zero means default in the engine: blank fields show the default's meaning where it isn't zero. */
const DEFAULT_HINTS: Record<string, string> = { scale: "1", rotation: "0", fov: "60", intensity: "1", speed: "1", fade: "0.2", ambient_intensity: "1", exposure: "1" };

function FieldEditor({
	name,
	type,
	values,
	value,
	inherited,
	onCommit,
}: {
	name: string;
	type: string;
	values?: string[];
	value: unknown;
	inherited: boolean;
	onCommit(v: unknown): void;
}) {
	const vec = /^\[(\d+)\]f32$/.exec(type);
	if (type === "quaternion128" || (vec && name === "rotation")) {
		const euler = value === undefined ? undefined : rotationDegrees(value);
		return (
			<div className="vec" title="pitch, yaw, roll (degrees)">
				{[0, 1, 2].map((i) => (
					<NumberField key={i} value={euler?.[i]} placeholder="0" inherited={inherited} onCommit={(n) => onCommit(round3((euler ?? [0, 0, 0]).map((x, j) => (j === i ? n : x))))} />
				))}
			</div>
		);
	}
	if (vec || (Array.isArray(value) && value.every((x) => typeof x === "number"))) {
		const n = vec ? Number(vec[1]) : (value as number[]).length;
		const cur = Array.isArray(value) ? (value as number[]) : undefined;
		const fill = name === "scale" ? 1 : 0;
		return (
			<div className="vec">
				{Array.from({ length: n }, (_, i) => (
					<NumberField
						key={i}
						value={cur?.[i]}
						placeholder={DEFAULT_HINTS[name] ?? "0"}
						inherited={inherited}
						onCommit={(x) => onCommit(Array.from({ length: n }, (_, j) => (j === i ? x : (cur?.[j] ?? fill))))}
					/>
				))}
			</div>
		);
	}
	if (values) {
		return (
			<select className={inherited ? "inherited" : ""} value={typeof value === "string" ? value : ""} onChange={(e) => onCommit(e.target.value)}>
				<option value="">{values[0]} (default)</option>
				{values.map((v) => (
					<option key={v}>{v}</option>
				))}
			</select>
		);
	}
	if (type === "bool" || typeof value === "boolean") return <input type="checkbox" checked={value === true} onChange={(e) => onCommit(e.target.checked)} />;
	if (type === "string" || typeof value === "string") return <TextField value={typeof value === "string" ? value : ""} inherited={inherited} onCommit={onCommit} />;
	if (/^(f32|f64|int|i32|i64|u32|Entity)$/.test(type) || typeof value === "number") {
		return <NumberField value={value} placeholder={DEFAULT_HINTS[name] ?? "0"} inherited={inherited} onCommit={onCommit} />;
	}
	return <JsonField value={value} inherited={inherited} onCommit={onCommit} />;
}

function JsonField({ value, inherited, onCommit }: { value: unknown; inherited: boolean; onCommit(v: unknown): void }) {
	const text = value === undefined ? "" : JSON.stringify(value);
	const [bad, setBad] = useState(false);
	return (
		<textarea
			key={text}
			className={`json ${inherited ? "inherited" : ""} ${bad ? "bad" : ""}`}
			rows={Math.min(4, Math.ceil(text.length / 34) || 1)}
			defaultValue={text}
			placeholder="default"
			onBlur={(e) => {
				const t = e.target.value.trim();
				if (t === text) return;
				try {
					onCommit(t === "" ? null : JSON.parse(t));
					setBad(false);
				} catch {
					setBad(true);
				}
			}}
		/>
	);
}

// The engine's Environment fields (engine/docs/making-a-game.md).
const ENV_FIELDS: [string, "color" | "number" | "vec" | "bool"][] = [
	["sky_zenith", "color"],
	["sky_horizon", "color"],
	["sky_ground", "color"],
	["ambient_sky", "color"],
	["ambient_ground", "color"],
	["ambient_intensity", "number"],
	["fog_color", "color"],
	["fog_density", "number"],
	["exposure", "number"],
	["gravity", "vec"],
	["zero_gravity", "bool"],
	["no_sky", "bool"],
];

const toHex = (c: unknown) =>
	Array.isArray(c) ? `#${c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, Number(x))) * 255).toString(16).padStart(2, "0")).join("")}` : "#000000";
const fromHex = (h: string) => [1, 3, 5].map((i) => Math.round((parseInt(h.slice(i, i + 2), 16) / 255) * 1000) / 1000);

/** What the engine uses for unset fields (env_resolved in the engine's render.odin; ambient colours approximated). */
function envDefaults(env: Record<string, unknown>): Record<string, unknown> {
	const zenith = (env.sky_zenith as number[] | undefined) ?? [0.24, 0.45, 0.82];
	const horizon = (env.sky_horizon as number[] | undefined) ?? [0.72, 0.82, 0.93];
	const ground = (env.sky_ground as number[] | undefined) ?? [0.32, 0.3, 0.28];
	return {
		sky_zenith: zenith,
		sky_horizon: horizon,
		sky_ground: ground,
		ambient_sky: zenith.map((z, i) => (z + horizon[i]) * 0.5 * 0.8),
		ambient_ground: ground.map((g) => g * 0.65),
		ambient_intensity: 1,
		fog_color: horizon,
		fog_density: 0,
		exposure: 1,
		gravity: [0, -9.81, 0],
	};
}

function EnvironmentPanel({ scene, onEdit }: { scene: SceneFile; onEdit(value: Record<string, unknown>): void }) {
	const env = scene.environment ?? {};
	const live = envDefaults(env);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const later = (value: Record<string, unknown>) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => onEdit(value), 350);
	};
	return (
		<div className="col" data-testid="environment-panel">
			<h3>Environment</h3>
			{scene.notes && <div className="muted small">{scene.notes}</div>}
			{ENV_FIELDS.map(([name, kind]) => {
				const set = env[name] !== undefined;
				const v = set ? env[name] : live[name];
				return (
					<div className="field-row" key={name}>
						<span className="field-name">{name}</span>
						{kind === "color" ? (
							<input type="color" className={set ? "" : "inherited"} defaultValue={toHex(v)} key={toHex(v)} onChange={(e) => later({ [name]: fromHex(e.target.value) })} />
						) : kind === "bool" ? (
							<input type="checkbox" checked={v === true} onChange={(e) => onEdit({ [name]: e.target.checked })} />
						) : (
							<FieldEditor name={name} type={kind === "vec" ? "[3]f32" : "f32"} value={v} inherited={!set} onCommit={(x) => onEdit({ [name]: x })} />
						)}
						{set ? (
							<button className="icon" title="Back to the default" onClick={() => onEdit({ [name]: null })}>
								↺
							</button>
						) : (
							<span className="icon-space" />
						)}
					</div>
				);
			})}
			<div className="muted small">Select something in the view or the outline to inspect it. Values in grey aren't set in the file: they're the engine's defaults.</div>
		</div>
	);
}
