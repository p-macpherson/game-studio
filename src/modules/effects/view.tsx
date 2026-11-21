// Effects (M12): effect files played live on a plain ground (looping, or paused at a scrubbed moment), with an inspector
// per emitter (curve and gradient editors) and the file as JSON; and the particle textures they use (procedural recipes,
// or generated candidates to choose from). Edits write the whole file (write_effect, an undo step) and the live engine
// re-reads it and replays.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ASSET_NAME } from "../../shared/asset-names";
import {
	addEmitter,
	type ColorStop,
	curveKeys,
	curveValue,
	EFFECT_DIR,
	EFFECT_TEMPLATES,
	type EffectFile,
	type Emitter,
	effectLength,
	formatEffect,
	gradientStops,
	gradientValue,
	PARTICLE_TEXTURE_DIR,
	PROCEDURAL_SHAPES,
	ANIMATED_SHAPES,
	type ParticleTextureFile,
	parseEffect,
	removeEmitter,
	SHAPE_KINDS,
	setEffectField,
} from "../../shared/effect";
import type { ModuleInfo } from "../../shared/modules";
import { isEditorRun } from "../../shared/run";
import { call, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { editCheckout, runInWorktree } from "../../renderer/workspace";
import { effectName, isTexture, textureImage, textureName } from "./info";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
const quiet = <T,>(p: Promise<T>) => p.catch(() => undefined);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
interface Playing {
	handle: number;
	path: string;
	particles: number;
	sim_ms: number;
	bounds?: number[][];
}

export function EffectsView({ module }: { module: ModuleInfo }) {
	const [creating, setCreating] = useState(false);
	return (
		<>
			<AssetBrowser
				module={module}
				newLabel="+ New…"
				onNew={() => setCreating(true)}
				modifyLabel="Ask the VFX artist"
				modifyPlaceholder="What should it look like, and when does it play? The VFX Artist builds effects and their textures and judges them frame by frame."
				emptyText="No effects yet. Start one with “New…”."
				content={(props) =>
					isTexture(props.asset.path) ? (
						<TextureDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />
					) : (
						<EffectDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />
					)
				}
			/>
			{creating && <NewDialog onClose={() => setCreating(false)} />}
		</>
	);
}

// --- An effect ---------------------------------------------------------------------------------------------------------

function EffectDetail({ asset, text, checkout: shownCheckout }: AssetContentProps) {
	const { run, frame, showError, assetsVersion } = useStudio(useShallow((s) => ({ run: s.run, frame: s.frame, showError: s.showError, assetsVersion: s.assetsVersion })));
	const name = effectName(asset.path);
	const path = `effects/${name}.json`;
	const checkout = shownCheckout ?? null;
	const ours = !!run && run.effect === name && run.sessionId === checkout;
	const live = ours && run.state === "running";
	const otherGame = !!run && !ours && !isEditorRun(run) && ["building", "starting", "running"].includes(run.state);
	const parsed = useMemo(() => (text ? parseEffect(text) : null), [text]);
	const [draft, setDraft] = useState<EffectFile | null>(parsed?.effect ?? null);
	// Edits build on the latest draft, even several in one event (a texture brings its flipbook).
	const current = useRef<EffectFile | null>(draft);
	const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
	const [selected, setSelected] = useState(0);
	const [tab, setTab] = useState<"emitter" | "effect" | "json">("emitter");
	const [background, setBackground] = useState<"dark" | "light">("dark");
	const [playing, setPlaying] = useState(true);
	const [time, setTime] = useState(0.3);
	const [state, setState] = useState<{ particles: number; sim_ms: number; problems: string[] }>({ particles: 0, sim_ms: 0, problems: [] });
	const [textures, setTextures] = useState<{ name: string; flipbook?: [number, number] }[]>([]);
	const handle = useRef(0);
	const framed = useRef(false);

	useEffect(() => {
		if (parsed?.effect && !pending.current) {
			setDraft(parsed.effect);
			current.current = parsed.effect;
		}
	}, [parsed]);

	const start = useCallback(
		(bg = background) => {
			framed.current = false;
			return quiet(call("run.start", checkout, "hidden", { effect: { name, background: bg } }).catch(showError));
		},
		[checkout, name, background, showError],
	);
	useEffect(() => {
		if (!ours && !otherGame) void start();
		void quiet(call("run.stream", true));
		return () => void quiet(call("run.stream", false));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** Plays it afresh: running (real time, while the game is paused) or frozen at `at` seconds. */
	const replay = useCallback(
		async (at?: number) => {
			await quiet(call("run.call", "effect_stop", { clear: true }));
			const r = (await quiet(call("run.call", "effect_play", at === undefined ? { path, real_time: true, seed: 7 } : { path, time: at, seed: 7 }))) as { handle: number } | undefined;
			handle.current = r?.handle ?? 0;
		},
		[path],
	);

	// The camera on the particles: played to its middle, its bounds read, then a three-quarter view.
	const frameIt = useCallback(async () => {
		if (!draft) return;
		await replay(Math.min(effectLength(draft) * 0.6, 2));
		await quiet(call("run.call", "wait", { frames: 2 }));
		const s = (await quiet(call("run.call", "effects"))) as { playing: Playing[] } | undefined;
		const b = s?.playing.find((p) => p.handle === handle.current)?.bounds;
		const c = b ? b[0].map((v, i) => (v + b[1][i]) / 2) : [0, 0.5, 0];
		const e = b ? Math.max(...b[1].map((v, i) => v - b[0][i]), 0.6) : 1.5;
		await quiet(call("run.call", "camera", { position: [c[0] + e * 0.3, c[1] + e * 0.35, c[2] - (e * 0.95 + 0.6)], target: c, fov: 50 }));
		framed.current = true;
		await (playing ? replay() : replay(time));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft, replay, playing, time]);

	useEffect(() => {
		if (live && !framed.current) void frameIt();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [live, run?.id]);

	// The file changed (an edit, an agent): the engine re-reads it, then it plays again.
	useEffect(() => {
		if (!live || !framed.current) return;
		void (async () => {
			await quiet(call("run.call", "effects", { reload: true }));
			await (playing ? replay() : replay(time));
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text, live]);

	// Counts and cost; a one-shot that has finished plays again after a beat.
	useEffect(() => {
		if (!live) return;
		let idle = 0;
		const t = setInterval(async () => {
			const s = (await quiet(call("run.call", "effects"))) as { loaded: { path: string; problems: string[] }[]; playing: Playing[] } | undefined;
			if (!s) return;
			const p = s.playing.find((x) => x.handle === handle.current);
			setState({ particles: p?.particles ?? 0, sim_ms: p?.sim_ms ?? 0, problems: s.loaded.find((l) => l.path === path)?.problems ?? [] });
			if (playing && !p && ++idle >= 2) {
				idle = 0;
				void replay();
			}
		}, 400);
		return () => clearInterval(t);
	}, [live, playing, path, replay]);

	// Made textures, for the texture picker.
	useEffect(() => {
		let alive = true;
		call("assets.list", "effects", checkout).then(async (list) => {
			const made = await Promise.all(
				list
					.filter((a) => isTexture(a.path) && a.change !== "deleted")
					.map(async (a) => {
						try {
							const t = JSON.parse(await call("assets.read", a.path, checkout)) as ParticleTextureFile;
							return t.mode === "procedural" || t.source ? { name: textureName(a.path), flipbook: t.flipbook } : null;
						} catch {
							return null;
						}
					}),
			);
			if (alive) setTextures(made.flatMap((x) => (x ? [{ name: x.name, ...(x.flipbook ? { flipbook: x.flipbook } : {}) }] : [])));
		}, () => {});
		return () => {
			alive = false;
		};
	}, [checkout, assetsVersion]);

	const save = (next: EffectFile, now = false) => {
		current.current = next;
		setDraft(next);
		clearTimeout(pending.current);
		const write = async () => {
			pending.current = undefined;
			try {
				await runInWorktree(`Effect: ${name}`, "write_effect", { effect: name, source: formatEffect(next) });
				bumpAssets();
			} catch (err) {
				showError(err);
			}
		};
		if (now) void write();
		else pending.current = setTimeout(write, 450);
	};

	if (!parsed) return <div className="muted pad">Loading…</div>;
	if (!draft) {
		return (
			<div className="card scene-problems" data-testid="effect-problems">
				<h3>This effect can't be read</h3>
				{parsed.problems.map((p) => (
					<div key={p}>{p}</div>
				))}
			</div>
		);
	}
	const length = effectLength(draft);
	const emitter = draft.emitters[Math.min(selected, draft.emitters.length - 1)];
	const problems = [...new Set([...parsed.problems, ...state.problems])];
	return (
		<div className="effect-editor" data-testid="effect-editor">
			<div className="scene-main">
				<div className="row scene-toolbar">
					<button onClick={() => (playing ? (setPlaying(false), void replay(time)) : (setPlaying(true), void replay()))} disabled={!live} data-testid="effect-play">
						{playing ? "⏸ Pause" : "▶ Play"}
					</button>
					<button onClick={() => void (playing ? replay() : replay(time))} disabled={!live} title="Play it again from the start">
						↻ Replay
					</button>
					<input
						type="range"
						min={0}
						max={length}
						step={0.01}
						value={Math.min(time, length)}
						disabled={!live}
						onChange={(e) => {
							const t = Number(e.target.value);
							setTime(t);
							setPlaying(false);
							void replay(t);
						}}
						title="Its state at a moment (pauses)"
						data-testid="effect-time"
					/>
					<span className="muted small">{playing ? "playing" : `t = ${time.toFixed(2)} s`}</span>
					<span className="grow" />
					<span className="small" data-testid="effect-stats">
						{state.particles} particles · {state.sim_ms.toFixed(2)} ms
					</span>
					<div className="seg">
						{(["dark", "light"] as const).map((bg) => (
							<button key={bg} className={background === bg ? "on" : ""} onClick={() => (setBackground(bg), void start(bg))}>
								{bg}
							</button>
						))}
					</div>
					<button onClick={() => void frameIt()} disabled={!live} title="Point the camera at the particles">
						Frame
					</button>
				</div>
				<div className="viewport scene-viewport" data-testid="effect-viewport">
					{live && frame?.runId === run?.id ? (
						<img src={frame.src} alt="" draggable={false} />
					) : otherGame ? (
						<div className="col" style={{ alignItems: "center" }}>
							<span>The game is running in Play &amp; Test.</span>
							<button className="primary" onClick={() => void start()}>
								Show this effect here (stops it)
							</button>
						</div>
					) : ours && (run.state === "exited" || run.state === "build_failed") ? (
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
						<span className="muted">{run?.state === "building" ? "Building the game…" : "Starting the game…"}</span>
					)}
				</div>
				{problems.length > 0 && (
					<div className="card scene-problems" data-testid="effect-problems">
						{problems.map((p) => (
							<div key={p}>{p}</div>
						))}
					</div>
				)}
			</div>
			<div className="scene-inspector col" data-testid="effect-inspector">
				<div className="row emitter-tabs">
					{draft.emitters.map((e, i) => (
						<button key={i} className={tab === "emitter" && i === selected ? "on" : ""} onClick={() => (setSelected(i), setTab("emitter"))} data-testid="effect-emitter-tab">
							{typeof e.name === "string" ? e.name : `#${i}`}
						</button>
					))}
					<button className="icon" title="Add an emitter" onClick={() => (save(addEmitter(current.current!, { name: `emitter-${draft.emitters.length + 1}`, rate: 10, life: 1, speed: 1 }), true), setSelected(draft.emitters.length), setTab("emitter"))}>
						+
					</button>
					<span className="grow" />
					<button className={tab === "effect" ? "on" : ""} onClick={() => setTab("effect")}>
						Effect
					</button>
					<button className={tab === "json" ? "on" : ""} onClick={() => setTab("json")} data-testid="effect-json-tab">
						JSON
					</button>
				</div>
				{tab === "json" ? (
					<JsonEditor value={formatEffect(draft)} onSave={(src) => {
						const r = parseEffect(src);
						if (!r.effect) return showError(new Error(r.problems.join("; ")));
						save(r.effect, true);
					}} />
				) : tab === "effect" ? (
					<EffectFields effect={draft} onSet={(k, v) => save(setEffectField(current.current!, null, k, v))} />
				) : (
					emitter && (
						<EmitterInspector
							key={selected}
							emitter={emitter}
							textures={textures}
							onSet={(k, v, now) => save(setEffectField(current.current!, selected, k, v), now)}
							onRemove={draft.emitters.length > 1 ? () => (save(removeEmitter(current.current!, selected), true), setSelected(0)) : undefined}
						/>
					)
				)}
			</div>
		</div>
	);
}

function EffectFields({ effect, onSet }: { effect: EffectFile; onSet(k: string, v: unknown): void }) {
	return (
		<div className="col">
			<label className="field">
				<span>Notes</span>
				<textarea rows={3} defaultValue={effect.notes ?? ""} onBlur={(e) => onSet("notes", e.target.value || null)} />
			</label>
			<Num label="duration" value={effect.duration} hint="seconds its emitters emit (0 = forever)" onSet={(v) => onSet("duration", v)} />
			<Check label="loop" value={effect.loop} onSet={(v) => onSet("loop", v)} />
			<div className="muted small">Play it from code with engine.play_effect("{`effects/…json`}", position), or put an Effect component on an entity.</div>
		</div>
	);
}

const SECTION = (title: string) => <div className="emitter-section">{title}</div>;

function EmitterInspector({ emitter: e, textures, onSet, onRemove }: { emitter: Emitter; textures: { name: string; flipbook?: [number, number] }[]; onSet(k: string, v: unknown, now?: boolean): void; onRemove?: () => void }) {
	const shape = (e.shape ?? {}) as Record<string, unknown>;
	const setShape = (k: string, v: unknown) => {
		const next = { ...shape };
		if (v === null) delete next[k];
		else next[k] = v;
		onSet("shape", Object.keys(next).length ? next : null);
	};
	const gpu = e.sim === "gpu";
	return (
		<div className="col emitter-inspector">
			<div className="row">
				<input className="grow" defaultValue={typeof e.name === "string" ? e.name : ""} placeholder="name" onBlur={(x) => onSet("name", x.target.value || null, true)} />
				{onRemove && (
					<button className="icon" title="Remove this emitter" onClick={onRemove}>
						🗑
					</button>
				)}
			</div>
			{SECTION("Emission")}
			<Select label="sim" value={e.sim} options={["cpu", "gpu"]} onSet={(v) => onSet("sim", v, true)} />
			<Num label="max" value={e.max} onSet={(v) => onSet("max", v)} />
			{!gpu && <Num label="rate" value={e.rate} hint="per second" onSet={(v) => onSet("rate", v)} testid="effect-rate" />}
			{!gpu && <Json label="burst" value={e.burst} hint='a count, or [{"at": 0, "count": [20, 30]}]' onSet={(v) => onSet("burst", v, true)} />}
			<Num label="delay" value={e.delay} onSet={(v) => onSet("delay", v)} />
			<Num label="duration" value={e.duration} onSet={(v) => onSet("duration", v)} />
			{SECTION("Shape")}
			<Select label="kind" value={shape.kind} options={[...SHAPE_KINDS]} onSet={(v) => setShape("kind", v)} />
			<Num label="radius" value={shape.radius} onSet={(v) => setShape("radius", v)} />
			{shape.kind === "box" && <Vec label="size" value={shape.size} onSet={(v) => setShape("size", v)} />}
			{shape.kind === "cone" && <Num label="angle" value={shape.angle} onSet={(v) => setShape("angle", v)} />}
			{shape.kind === "line" && <Num label="length" value={shape.length} onSet={(v) => setShape("length", v)} />}
			<Check label="surface" value={shape.surface} onSet={(v) => setShape("surface", v)} />
			<Vec label="offset" value={e.offset} onSet={(v) => onSet("offset", v)} />
			{SECTION("Motion")}
			<Range label="life" value={e.life} onSet={(v) => onSet("life", v)} />
			<Range label="speed" value={e.speed} onSet={(v) => onSet("speed", v)} />
			<Vec label="velocity" value={e.velocity} onSet={(v) => onSet("velocity", v)} />
			<Num label="gravity" value={e.gravity} hint="m/s² down; negative rises" onSet={(v) => onSet("gravity", v)} />
			<Num label="drag" value={e.drag} onSet={(v) => onSet("drag", v)} />
			<Vec label="force" value={e.force} onSet={(v) => onSet("force", v)} />
			<Num label="noise" value={e.noise} onSet={(v) => onSet("noise", v)} />
			<Num label="noise scale" value={e.noise_scale} onSet={(v) => onSet("noise_scale", v)} />
			<Range label="rotation" value={e.rotation} onSet={(v) => onSet("rotation", v)} />
			<Range label="spin" value={e.rotation_speed} onSet={(v) => onSet("rotation_speed", v)} />
			{!gpu && <Select label="space" value={e.space} options={["world", "local"]} onSet={(v) => onSet("space", v, true)} />}
			{SECTION("Look")}
			<CurveEditor label="size" value={e.size} def={0.2} onSet={(v) => onSet("size", v)} />
			<Range label="size random" value={e.size_random} onSet={(v) => onSet("size_random", v)} />
			<GradientEditor value={e.color} onSet={(v) => onSet("color", v)} />
			<Num label="intensity" value={e.intensity} hint="multiplies the colour: above 1 blooms" onSet={(v) => onSet("intensity", v)} />
			<div className="field-row">
				<span className="field-name">texture</span>
				<select
					value={typeof e.texture === "string" ? e.texture : ""}
					onChange={(x) => {
						const t = textures.find((tt) => textureImage(tt.name) === x.target.value);
						onSet("texture", x.target.value || null, true);
						if (t?.flipbook) onSet("flipbook", t.flipbook, true);
					}}
					data-testid="effect-texture"
				>
					<option value="">soft dot (default)</option>
					{textures.map((t) => (
						<option key={t.name} value={textureImage(t.name)}>
							{t.name}
							{t.flipbook ? ` (${t.flipbook[0]}×${t.flipbook[1]})` : ""}
						</option>
					))}
					{typeof e.texture === "string" && e.texture && !textures.some((t) => textureImage(t.name) === e.texture) && <option value={e.texture}>{e.texture}</option>}
				</select>
				<span className="icon-space" />
			</div>
			<Json label="flipbook" value={e.flipbook} hint="[columns, rows]" onSet={(v) => onSet("flipbook", v, true)} />
			<Num label="fps" value={e.fps} hint="0 = once over its life" onSet={(v) => onSet("fps", v)} />
			<Select label="blend" value={e.blend} options={["alpha", "additive"]} onSet={(v) => onSet("blend", v, true)} />
			<Num label="soft" value={e.soft} hint="metres it fades into what's behind" onSet={(v) => onSet("soft", v)} />
			<Select label="align" value={e.align} options={["camera", "velocity", "ground"]} onSet={(v) => onSet("align", v, true)} />
			{e.align === "velocity" && <Num label="stretch" value={e.stretch} hint="length × (1 + stretch × speed)" onSet={(v) => onSet("stretch", v)} />}
		</div>
	);
}

// --- Fields --------------------------------------------------------------------------------------------------------------

function Row({ label, hint, set, onReset, children }: { label: string; hint?: string; set: boolean; onReset(): void; children: React.ReactNode }) {
	return (
		<div className="field-row" title={hint}>
			<span className={`field-name ${set ? "" : "muted"}`}>{label}</span>
			{children}
			{set ? (
				<button className="icon" title="Back to the default" onClick={onReset}>
					↺
				</button>
			) : (
				<span className="icon-space" />
			)}
		</div>
	);
}

function Num({ label, value, hint, onSet, testid }: { label: string; value: unknown; hint?: string; onSet(v: number | null): void; testid?: string }) {
	return (
		<Row label={label} hint={hint} set={value !== undefined} onReset={() => onSet(null)}>
			<input
				type="number"
				step={0.05}
				defaultValue={isNum(value) ? value : ""}
				key={String(value)}
				placeholder="default"
				onBlur={(e) => e.target.value !== String(value ?? "") && onSet(e.target.value === "" ? null : Number(e.target.value))}
				onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
				data-testid={testid}
			/>
		</Row>
	);
}

function Range({ label, value, onSet }: { label: string; value: unknown; onSet(v: number | number[] | null): void }) {
	const [a, b] = isNum(value) ? [value, value] : Array.isArray(value) ? value : ["", ""];
	const commit = (lo: string, hi: string) => {
		if (lo === "" && hi === "") return onSet(null);
		const x = Number(lo || hi), y = Number(hi || lo);
		onSet(x === y ? x : [Math.min(x, y), Math.max(x, y)]);
	};
	return (
		<Row label={label} hint="a value, or a range picked per particle" set={value !== undefined} onReset={() => onSet(null)}>
			<span className="vec" key={JSON.stringify(value)}>
				<input type="number" step={0.05} defaultValue={a as number} placeholder="min" onBlur={(e) => commit(e.target.value, String(b))} />
				<input type="number" step={0.05} defaultValue={b as number} placeholder="max" onBlur={(e) => commit(String(a), e.target.value)} />
			</span>
		</Row>
	);
}

function Vec({ label, value, onSet }: { label: string; value: unknown; onSet(v: number[] | null): void }) {
	const v = Array.isArray(value) ? (value as number[]) : [0, 0, 0];
	return (
		<Row label={label} set={value !== undefined} onReset={() => onSet(null)}>
			<span className="vec" key={JSON.stringify(value)}>
				{[0, 1, 2].map((i) => (
					<input key={i} type="number" step={0.05} defaultValue={v[i]} onBlur={(e) => Number(e.target.value) !== v[i] && onSet(v.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
				))}
			</span>
		</Row>
	);
}

function Select({ label, value, options, onSet }: { label: string; value: unknown; options: string[]; onSet(v: string | null): void }) {
	return (
		<Row label={label} set={value !== undefined} onReset={() => onSet(null)}>
			<select value={typeof value === "string" ? value : ""} onChange={(e) => onSet(e.target.value || null)}>
				<option value="">default ({options[0]})</option>
				{options.map((o) => (
					<option key={o}>{o}</option>
				))}
			</select>
		</Row>
	);
}

function Check({ label, value, onSet }: { label: string; value: unknown; onSet(v: boolean | null): void }) {
	return (
		<Row label={label} set={value !== undefined} onReset={() => onSet(null)}>
			<input type="checkbox" checked={value === true} onChange={(e) => onSet(e.target.checked)} />
		</Row>
	);
}

function Json({ label, value, hint, onSet }: { label: string; value: unknown; hint?: string; onSet(v: unknown): void }) {
	const [bad, setBad] = useState(false);
	return (
		<Row label={label} hint={hint} set={value !== undefined} onReset={() => onSet(null)}>
			<input
				className={bad ? "bad" : ""}
				defaultValue={value === undefined ? "" : JSON.stringify(value)}
				key={JSON.stringify(value)}
				placeholder={hint}
				onBlur={(e) => {
					if (e.target.value === "") return onSet(null);
					try {
						onSet(JSON.parse(e.target.value));
						setBad(false);
					} catch {
						setBad(true);
					}
				}}
			/>
		</Row>
	);
}

/** Keys over a particle's life: drag a point, double-click to add one, right-click to remove it. */
function CurveEditor({ label, value, def, onSet }: { label: string; value: unknown; def: number; onSet(v: unknown): void }) {
	const keys = curveKeys(value, def);
	const [drag, setDrag] = useState<{ i: number; keys: [number, number][] } | null>(null);
	const shown = drag?.keys ?? keys;
	const top = Math.max(...keys.map((k) => k[1]), 0.01) * 1.3;
	const W = 220, H = 70;
	const x = (t: number) => 6 + t * (W - 12);
	const y = (v: number) => H - 6 - (v / top) * (H - 12);
	const at = (ev: React.PointerEvent<SVGSVGElement>) => {
		const r = ev.currentTarget.getBoundingClientRect();
		return [Math.min(1, Math.max(0, ((ev.clientX - r.left) / r.width * W - 6) / (W - 12))), Math.max(0, (H - 6 - (ev.clientY - r.top) / r.height * H) / (H - 12) * top)];
	};
	const line = (shown.length === 1 ? [[0, shown[0][1]], [1, shown[0][1]]] : [...shown].sort((a, b) => a[0] - b[0])).map(([t, v]) => `${x(t)},${y(v)}`).join(" ");
	return (
		<div className="field-col" data-testid={`curve-${label}`}>
			<div className="row">
				<span className={`field-name grow ${value !== undefined ? "" : "muted"}`}>{label} over life</span>
				<span className="muted small">top {Math.round(top * 100) / 100}</span>
				{value !== undefined && (
					<button className="icon" title="Back to the default" onClick={() => onSet(null)}>
						↺
					</button>
				)}
			</div>
			<svg
				className="curve"
				viewBox={`0 0 ${W} ${H}`}
				onDoubleClick={(ev) => {
					const [t, v] = at(ev as unknown as React.PointerEvent<SVGSVGElement>);
					onSet(curveValue([...keys, [t, v]]));
				}}
				onPointerMove={(ev) => {
					if (!drag) return;
					const [t, v] = at(ev);
					setDrag({ i: drag.i, keys: drag.keys.map((k, j) => (j === drag.i ? [t, v] : k)) });
				}}
				onPointerUp={() => {
					if (drag) onSet(curveValue(drag.keys));
					setDrag(null);
				}}
			>
				<polyline points={line} />
				{shown.map(([t, v], i) => (
					<circle
						key={i}
						cx={x(shown.length === 1 ? 0.5 : t)}
						cy={y(v)}
						r={4}
						onPointerDown={(ev) => {
							(ev.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(ev.pointerId);
							setDrag({ i, keys });
						}}
						onContextMenu={(ev) => {
							ev.preventDefault();
							if (keys.length > 1) onSet(curveValue(keys.filter((_, j) => j !== i)));
						}}
					>
						<title>{`t ${t.toFixed(2)}: ${v.toFixed(3)}`}</title>
					</circle>
				))}
			</svg>
		</div>
	);
}

/** Colour over a particle's life: stops along the bar (click one to edit its colour, alpha and intensity). */
function GradientEditor({ value, onSet }: { value: unknown; onSet(v: unknown): void }) {
	const stops = gradientStops(value);
	const [sel, setSel] = useState(0);
	const s = stops[Math.min(sel, stops.length - 1)];
	const css = (st: ColorStop) => {
		const n = parseInt(st.color.slice(1), 16);
		return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${st.alpha})`;
	};
	const bg = stops.length === 1 ? `linear-gradient(${css(stops[0])}, ${css(stops[0])})` : `linear-gradient(to right, ${[...stops].sort((a, b) => a.t - b.t).map((st) => `${css(st)} ${st.t * 100}%`).join(", ")})`;
	const set = (patch: Partial<ColorStop>) => onSet(gradientValue(stops.map((st, i) => (i === sel ? { ...st, ...patch } : st))));
	return (
		<div className="field-col" data-testid="gradient">
			<div className="row">
				<span className={`field-name grow ${value !== undefined ? "" : "muted"}`}>colour over life</span>
				<button className="icon" title="Add a stop" onClick={() => (onSet(gradientValue([...stops, { ...s, t: Math.min(1, s.t + 0.25) }])), setSel(stops.length))}>
					+
				</button>
				{stops.length > 1 && (
					<button className="icon" title="Remove this stop" onClick={() => (onSet(gradientValue(stops.filter((_, i) => i !== sel))), setSel(0))}>
						−
					</button>
				)}
			</div>
			<div className="gradient-bar checker" style={{ ["--grad" as string]: bg }}>
				{stops.map((st, i) => (
					<button key={i} className={`stop ${i === sel ? "on" : ""}`} style={{ left: `${st.t * 100}%`, background: st.color }} onClick={() => setSel(i)} title={`t ${st.t}`} />
				))}
			</div>
			<div className="row gradient-stop">
				<input type="color" value={s.color} onChange={(e) => set({ color: e.target.value })} data-testid="gradient-color" />
				<label className="small">t <input type="number" min={0} max={1} step={0.05} defaultValue={s.t} key={`t${sel}${s.t}`} onBlur={(e) => set({ t: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>
				<label className="small">alpha <input type="number" min={0} max={1} step={0.05} defaultValue={s.alpha} key={`a${sel}${s.alpha}`} onBlur={(e) => set({ alpha: Number(e.target.value) })} /></label>
				<label className="small" title="Above 1 glows and blooms">× <input type="number" min={0} step={0.5} defaultValue={s.intensity} key={`i${sel}${s.intensity}`} onBlur={(e) => set({ intensity: Number(e.target.value) })} data-testid="gradient-intensity" /></label>
			</div>
		</div>
	);
}

function JsonEditor({ value, onSave }: { value: string; onSave(src: string): void }) {
	const [text, setText] = useState(value);
	useEffect(() => setText(value), [value]);
	const r = useMemo(() => parseEffect(text), [text]);
	return (
		<div className="col grow" style={{ minHeight: 0 }}>
			<textarea className="json-edit grow" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} data-testid="effect-json" />
			<div className="row">
				<span className={`small grow ${r.effect ? "muted" : "bad-text"}`}>{r.effect ? `${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}` : r.problems[0]}</span>
				<button className="primary" disabled={text === value || !r.effect} onClick={() => onSave(text)}>
					Save
				</button>
			</div>
		</div>
	);
}

// --- A texture -----------------------------------------------------------------------------------------------------------

function TextureDetail({ asset, text, checkout }: AssetContentProps) {
	const { showError, assetsVersion } = useStudio(useShallow((s) => ({ showError: s.showError, assetsVersion: s.assetsVersion })));
	const name = textureName(asset.path);
	const t = useMemo(() => {
		try {
			return text ? (JSON.parse(text) as ParticleTextureFile) : null;
		} catch {
			return null;
		}
	}, [text]);
	const [candidates, setCandidates] = useState<{ source: string; seed?: number }[]>([]);
	const [busy, setBusy] = useState(false);
	const [prompt, setPrompt] = useState(t?.prompt ?? "");
	const [recipe, setRecipe] = useState<{ shape: string; cols: number; rows: number; seed: number }>({ shape: t?.recipe?.shape ?? "smoke", cols: t?.recipe?.flipbook?.[0] ?? 1, rows: t?.recipe?.flipbook?.[1] ?? 1, seed: t?.recipe?.seed ?? 1 });
	const v = `${assetsVersion}`;
	useEffect(() => {
		if (t?.recipe) setRecipe({ shape: t.recipe.shape, cols: t.recipe.flipbook?.[0] ?? 1, rows: t.recipe.flipbook?.[1] ?? 1, seed: t.recipe.seed ?? 1 });
		if (t?.prompt) setPrompt((p) => p || t.prompt!);
	}, [t]);
	useEffect(() => {
		let alive = true;
		call("effects.textureCandidates", checkout ?? null, name).then((c) => alive && setCandidates(c), () => {});
		return () => {
			alive = false;
		};
	}, [name, checkout, assetsVersion]);
	const run = async (method: "generate_particle_texture" | "make_particle_texture", params: Record<string, unknown>) => {
		setBusy(true);
		try {
			await runInWorktree(`Particle texture: ${name}`, method, { name, ...params });
			bumpAssets();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};
	if (!t) return <div className="muted pad">This texture's .json can't be read.</div>;
	const made = t.mode === "procedural" || !!t.source;
	const img = studioFile(checkout, `assets/${textureImage(name)}`, v);
	return (
		<div className="doc-view col particle-texture" data-testid="particle-texture">
			{made ? (
				<section className="col">
					<div className="row">
						<h3 className="grow">{name}</h3>
						<code className="muted small" title="What effects set as texture">{textureImage(name)}</code>
					</div>
					<div className="row particle-previews">
						{["dark", "light"].map((bg) => (
							<div key={bg} className={`particle-tile ${bg}`} style={{ backgroundImage: `url("${img}")` }}>
								{t.flipbook && <div className="flipbook-grid" style={{ backgroundSize: `${100 / t.flipbook[0]}% ${100 / t.flipbook[1]}%` }} />}
							</div>
						))}
					</div>
					<span className="muted small">
						{t.mode === "procedural" ? `Procedural ${t.recipe?.shape}` : `Generated (${t.mode}) from ${t.source}`}
						{t.flipbook ? ` · a ${t.flipbook[0]}×${t.flipbook[1]} flipbook: set "flipbook": [${t.flipbook[0]}, ${t.flipbook[1]}] on the emitter` : ""}
					</span>
				</section>
			) : (
				<div className="empty">Not made yet: choose a candidate below.</div>
			)}
			{t.mode === "procedural" ? (
				<section className="col">
					<h3>Recipe</h3>
					<div className="row">
						<select value={recipe.shape} onChange={(e) => setRecipe({ ...recipe, shape: e.target.value })} data-testid="particle-shape">
							{PROCEDURAL_SHAPES.map((s) => (
								<option key={s}>{s}</option>
							))}
						</select>
						{ANIMATED_SHAPES.includes(recipe.shape) && (
							<label className="small">
								flipbook{" "}
								<input type="number" min={1} max={8} value={recipe.cols} onChange={(e) => setRecipe({ ...recipe, cols: Number(e.target.value) })} style={{ width: 48 }} />×
								<input type="number" min={1} max={8} value={recipe.rows} onChange={(e) => setRecipe({ ...recipe, rows: Number(e.target.value) })} style={{ width: 48 }} />
							</label>
						)}
						<label className="small">
							seed <input type="number" value={recipe.seed} onChange={(e) => setRecipe({ ...recipe, seed: Number(e.target.value) })} style={{ width: 64 }} />
						</label>
						<button
							className="primary"
							disabled={busy}
							onClick={() =>
								void run("make_particle_texture", {
									recipe: { shape: recipe.shape, seed: recipe.seed, ...(ANIMATED_SHAPES.includes(recipe.shape) && recipe.cols * recipe.rows > 1 ? { flipbook: [recipe.cols, recipe.rows] } : {}) },
								})
							}
							data-testid="particle-make"
						>
							Make
						</button>
					</div>
				</section>
			) : (
				<section className="col">
					<h3>Candidates</h3>
					<div className="candidate-grid">
						{candidates.map((c) => (
							<div key={c.source} className={`candidate ${t.source === c.source ? "chosen" : ""}`} data-testid="particle-candidate">
								<div className="particle-tile dark" style={{ backgroundImage: `url("${studioFile(checkout, `${PARTICLE_TEXTURE_DIR}/${name}/${c.source}`, v)}")` }} />
								<div className="row">
									<span className="grow muted small">seed {c.seed}</span>
									{t.source === c.source ? (
										<span className="small">In use</span>
									) : (
										<button className="small" disabled={busy} onClick={() => void run("make_particle_texture", { source: c.source })}>
											Use this
										</button>
									)}
								</div>
							</div>
						))}
					</div>
					<div className="row">
						<input className="grow" value={prompt} placeholder="One element: a bright four-pointed sparkle" onChange={(e) => setPrompt(e.target.value)} />
						<button disabled={busy || !prompt.trim()} onClick={() => void run("generate_particle_texture", { mode: t.mode, prompt: prompt.trim(), count: 3 })}>
							More candidates
						</button>
					</div>
				</section>
			)}
		</div>
	);
}

// --- New ---------------------------------------------------------------------------------------------------------------

function NewDialog({ onClose }: { onClose(): void }) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const [kind, setKind] = useState<"effect" | "procedural" | "glow" | "solid">("effect");
	const [name, setName] = useState("");
	const [template, setTemplate] = useState(EFFECT_TEMPLATES[0].id);
	const [shape, setShape] = useState("smoke");
	const [flip, setFlip] = useState(true);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const n = name.trim();
	const create = async () => {
		setBusy(true);
		try {
			if (kind === "effect") {
				const source = formatEffect(EFFECT_TEMPLATES.find((t) => t.id === template)!.effect);
				await runInWorktree(`Effect: ${n}`, "write_effect", { effect: n, source, create: true });
				showAsset({ path: `${EFFECT_DIR}/${n}.json` });
			} else if (kind === "procedural") {
				await runInWorktree(`Particle texture: ${n}`, "make_particle_texture", { name: n, recipe: { shape, ...(flip && ANIMATED_SHAPES.includes(shape) ? { flipbook: [4, 4] } : {}) } });
				showAsset({ path: `${PARTICLE_TEXTURE_DIR}/${n}/${n.split("/").pop()}.json` });
			} else {
				const id = await editCheckout(`Particle texture: ${n}`);
				await call("worktrees.run", id, "generate_particle_texture", { name: n, mode: kind, prompt: prompt.trim(), count: 3 });
				showAsset({ path: `${PARTICLE_TEXTURE_DIR}/${n}/${n.split("/").pop()}.json` });
			}
			bumpAssets();
			onClose();
		} catch (err) {
			showError(err);
			setBusy(false);
		}
	};
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal col" style={{ width: 520 }} onClick={(e) => e.stopPropagation()} data-testid="effect-new">
				<h3>New…</h3>
				<div className="seg">
					{(
						[
							["effect", "Effect"],
							["procedural", "Texture: procedural"],
							["glow", "Texture: glow"],
							["solid", "Texture: solid"],
						] as const
					).map(([k, label]) => (
						<button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)} data-testid={`effect-new-${k}`}>
							{label}
						</button>
					))}
				</div>
				<label className="field">
					<span>Name</span>
					<input autoFocus value={name} placeholder={kind === "effect" ? "chest-open, footstep-dust, fireflies" : "spark, smoke, leaves/maple"} onChange={(e) => setName(e.target.value)} data-testid="effect-new-name" />
				</label>
				{kind === "effect" && (
					<label className="field">
						<span>Start from</span>
						<select value={template} onChange={(e) => setTemplate(e.target.value)}>
							{EFFECT_TEMPLATES.map((t) => (
								<option key={t.id} value={t.id}>
									{t.label}
								</option>
							))}
						</select>
					</label>
				)}
				{kind === "procedural" && (
					<div className="row">
						<select value={shape} onChange={(e) => setShape(e.target.value)}>
							{PROCEDURAL_SHAPES.map((s) => (
								<option key={s}>{s}</option>
							))}
						</select>
						{ANIMATED_SHAPES.includes(shape) && (
							<label className="row small">
								<input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> 4×4 flipbook (grows and fades)
							</label>
						)}
					</div>
				)}
				{(kind === "glow" || kind === "solid") && (
					<label className="field">
						<span>{kind === "glow" ? "What glows (generated on black: sparks, embers, flames, magic)" : "What it is (generated on white: leaves, coins, petals, debris)"}</span>
						<input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={kind === "glow" ? "a bright four-pointed sparkle" : "a single small autumn leaf"} />
					</label>
				)}
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={onClose}>Cancel</button>
					<button className="primary" disabled={busy || !ASSET_NAME.test(n) || ((kind === "glow" || kind === "solid") && !prompt.trim())} onClick={() => void create()} data-testid="effect-new-create">
						{busy ? "Working…" : "Create"}
					</button>
				</div>
			</div>
		</div>
	);
}
