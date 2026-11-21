// Shaders (M11): material shaders, edited as GLSL beside a live engine view of the shader on a preview mesh. The
// engine checks the text as it's typed (errors on their lines, nothing saved), Save writes it (an undo step), and
// controls built from its @params try values live; "Make these the defaults" writes them into the header.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ASSET_NAME } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { parseShader, SHADER_DIR, SHADER_TEMPLATES, type ShaderParamDecl, type ShaderParamValue, setParamDefaults } from "../../shared/shader";
import { isEditorRun } from "../../shared/run";
import { call } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { runInWorktree } from "../../renderer/workspace";
import { shaderNameOf } from "./info";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
const quiet = <T,>(p: Promise<T>) => p.catch(() => undefined);
const MESHES = ["sphere", "cube", "cylinder", "cone", "grid", "plane"];
interface ShaderError {
	line: number;
	message: string;
}

export function ShadersView({ module }: { module: ModuleInfo }) {
	const [creating, setCreating] = useState(false);
	return (
		<>
			<AssetBrowser
				module={module}
				newLabel="+ New shader"
				onNew={() => setCreating(true)}
				modifyLabel="Ask the shader author"
				modifyPlaceholder="What should it look like, or how should it move? The Shader Author writes material shaders and judges them over time in the engine."
				emptyText="No shaders yet. Start one with “New shader”."
				content={(props) => <ShaderDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />}
			/>
			{creating && <NewShaderDialog onClose={() => setCreating(false)} />}
		</>
	);
}

function ShaderDetail({ asset, text, checkout: shownCheckout }: AssetContentProps) {
	const { run, frame, showError, project } = useStudio(useShallow((s) => ({ run: s.run, frame: s.frame, showError: s.showError, project: s.project })));
	const name = shaderNameOf(asset.path);
	const checkout = shownCheckout ?? null;
	const ours = !!run && run.shader === name && run.sessionId === checkout;
	const live = ours && run.state === "running";
	const otherGame = !!run && !ours && !isEditorRun(run) && ["building", "starting", "running"].includes(run.state);
	const [draft, setDraft] = useState(text ?? "");
	const synced = useRef(text ?? "");
	const [errors, setErrors] = useState<ShaderError[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [mesh, setMesh] = useState<string | undefined>();
	const [playing, setPlaying] = useState(true);
	const [time, setTime] = useState(0);
	const [bloom, setBloom] = useState(false);
	const storeKey = `shader-values:${project?.path ?? ""}:${name}`;
	const [values, setValuesState] = useState<Record<string, ShaderParamValue>>(() => {
		try {
			return JSON.parse(localStorage.getItem(storeKey) ?? "{}");
		} catch {
			return {};
		}
	});
	const info = useMemo(() => parseShader(draft), [draft]);
	const dirty = draft !== synced.current;

	// The file changed (a save, an agent, an undo): take it unless there are unsaved edits.
	useEffect(() => {
		if (text === undefined || text === synced.current) return;
		if (draft === synced.current) setDraft(text);
		synced.current = text;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text]);

	const start = useCallback(
		(m = mesh) => quiet(call("run.start", checkout, "hidden", { shader: { name, ...(m ? { mesh: m } : {}) } }).catch(showError)),
		[checkout, name, mesh, showError],
	);
	useEffect(() => {
		if (!ours && !otherGame) void start();
		void quiet(call("run.stream", true));
		return () => void quiet(call("run.stream", false));
		// Only when the shader opens: later runs are started from the buttons.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// The engine compiles the text as it is (unsaved too) a moment after typing stops.
	useEffect(() => {
		if (!live) return;
		const t = setTimeout(() => {
			call("run.call", "shader_check", { source: draft }).then((r) => setErrors((r as { errors: ShaderError[] }).errors), () => {});
		}, 400);
		return () => clearTimeout(t);
	}, [draft, live]);

	// Tried values go to the preview mesh (the file isn't touched); time runs or stands at the scrubbed moment.
	const applyValues = useCallback(
		(v: Record<string, ShaderParamValue>) => {
			const params: Record<string, ShaderParamValue | null> = {};
			for (const p of info.params) params[p.name] = v[p.name] ?? null;
			return quiet(call("run.call", "set", { entity: "Subject", component: "Mesh_Renderer", value: { material: { params } } }));
		},
		[info.params],
	);
	useEffect(() => {
		if (!live) return;
		void applyValues(values);
		void quiet(call("run.call", "shader_time", playing ? { mode: "real" } : { value: time }));
		if (bloom) void quiet(call("run.call", "environment", { value: { post: { bloom: 0.6 } } }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [live, run?.id]);
	const setValues = (next: Record<string, ShaderParamValue>) => {
		setValuesState(next);
		localStorage.setItem(storeKey, JSON.stringify(next));
		if (live) void applyValues(next);
	};
	const setClock = (play: boolean, t = time) => {
		setPlaying(play);
		setTime(t);
		if (live) void quiet(call("run.call", "shader_time", play ? { mode: "real" } : { value: t }));
	};
	const pause = async () => {
		const r = (await quiet(call("run.call", "shader_time"))) as { time: number } | undefined;
		setClock(false, Math.round((r?.time ?? 0) * 100) / 100);
	};

	const save = async (source = draft) => {
		if (busy) return;
		setBusy(true);
		try {
			await runInWorktree(`Shader: ${name}`, "write_shader", { shader: name, source });
			synced.current = source;
			setDraft(source);
			bumpAssets();
			if (live) await quiet(call("run.call", "shaders", { reload: true }));
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	const shown = errors ?? info.problems;
	return (
		<div className="shader-editor" data-testid="shader-editor">
			<div className="shader-code">
				<div className="row scene-toolbar">
					<span className="muted small grow">{dirty ? "Unsaved changes · Ctrl+S saves" : "Saved"}</span>
					<button className="primary" disabled={!dirty || busy} onClick={() => void save()} data-testid="shader-save">
						{busy ? "Saving…" : "Save"}
					</button>
				</div>
				<CodeEditor value={draft} onChange={setDraft} errors={shown} onSave={() => void save()} />
				<div className={`card shader-errors ${shown.length ? "bad" : ""}`} data-testid="shader-errors">
					{!live && !errors ? (
						<span className="muted small">Compile errors show here once the live view is running.</span>
					) : shown.length ? (
						shown.map((e, i) => (
							<div key={i}>
								{e.line > 0 && <code>line {e.line}</code>} {e.message}
							</div>
						))
					) : (
						<span className="small">Compiles.</span>
					)}
				</div>
			</div>
			<div className="scene-main">
				<div className="row scene-toolbar">
					<select
						value={mesh ?? ""}
						onChange={(e) => {
							const m = e.target.value || undefined;
							setMesh(m);
							void start(m);
						}}
						title="What the shader is shown on"
						data-testid="shader-mesh"
					>
						<option value="">{info.hasVertex ? "grid (default)" : "sphere (default)"}</option>
						{MESHES.map((m) => (
							<option key={m}>{m}</option>
						))}
					</select>
					<button onClick={() => (playing ? void pause() : setClock(true))} disabled={!live} data-testid="shader-play">
						{playing ? "⏸ Pause" : "▶ Play"}
					</button>
					<input
						type="range"
						min={0}
						max={10}
						step={0.05}
						value={time}
						disabled={!live || playing}
						onChange={(e) => setClock(false, Number(e.target.value))}
						title="Shader time (s) while paused"
						data-testid="shader-time"
					/>
					<span className="muted small grow">{playing ? "time running" : `t = ${time.toFixed(2)} s`}</span>
					<label className="row small" title="Bloom on the preview, as a scene with post-processing would glow (emission above 1)">
						<input
							type="checkbox"
							checked={bloom}
							onChange={(e) => {
								setBloom(e.target.checked);
								if (live) void quiet(call("run.call", "environment", { value: { post: { bloom: e.target.checked ? 0.6 : 0 } } }));
							}}
							data-testid="shader-bloom"
						/>
						Bloom
					</label>
				</div>
				<div className="viewport scene-viewport" data-testid="shader-viewport">
					{live && frame?.runId === run?.id ? (
						<img src={frame.src} alt="" draggable={false} />
					) : otherGame ? (
						<div className="col" style={{ alignItems: "center" }}>
							<span>The game is running in Play &amp; Test.</span>
							<button className="primary" onClick={() => void start()}>
								Show this shader here (stops it)
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
				<div className="shader-params col" data-testid="shader-params">
					<h3>Parameters</h3>
					{info.params.length === 0 && <div className="muted small">No @params. Declare one in the header: // @param float speed = 1 [0, 5]</div>}
					{info.params.map((p) => (
						<ParamControl key={p.name} decl={p} value={values[p.name]} onChange={(v) => setValues({ ...values, [p.name]: v })} onReset={() => {
							const { [p.name]: _, ...rest } = values;
							setValues(rest);
						}} />
					))}
					{info.params.length > 0 && (
						<div className="row">
							<button disabled={!Object.keys(values).length} onClick={() => setValues({})}>
								Reset all
							</button>
							<button
								disabled={busy || !info.params.some((p) => values[p.name] !== undefined)}
								onClick={() => {
									const next = setParamDefaults(draft, values);
									setValues({});
									void save(next);
								}}
								title="Write the tried values into the header as the defaults, and save"
								data-testid="shader-make-defaults"
							>
								Make these the defaults
							</button>
						</div>
					)}
					<div className="muted small">
						Tried values show on the preview only. A material sets its own in a scene: <code>"params": {"{"}"name": value{"}"}</code>. Post-processing (bloom,
						grading, outlines) is set per scene, in the Scenes section's environment.
					</div>
				</div>
			</div>
		</div>
	);
}

/** A plain-text editor with line numbers; lines with errors are marked, and Ctrl+S saves. */
function CodeEditor({ value, onChange, errors, onSave }: { value: string; onChange(v: string): void; errors: ShaderError[]; onSave(): void }) {
	const gutter = useRef<HTMLDivElement>(null);
	const lines = value.split("\n").length;
	const bad = new Map(errors.filter((e) => e.line > 0).map((e) => [e.line, e.message]));
	return (
		<div className="code-edit">
			<div className="code-gutter" ref={gutter}>
				{Array.from({ length: lines }, (_, i) => (
					<div key={i} className={bad.has(i + 1) ? "bad" : ""} title={bad.get(i + 1)}>
						{i + 1}
					</div>
				))}
			</div>
			<textarea
				spellCheck={false}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onScroll={(e) => {
					if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
				}}
				onKeyDown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "s") {
						e.preventDefault();
						onSave();
					} else if (e.key === "Tab") {
						e.preventDefault();
						const t = e.currentTarget;
						const { selectionStart: a, selectionEnd: b } = t;
						onChange(`${value.slice(0, a)}    ${value.slice(b)}`);
						requestAnimationFrame(() => t.setSelectionRange(a + 4, a + 4));
					}
				}}
				data-testid="shader-source"
			/>
		</div>
	);
}

const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff");

function ParamControl({ decl: p, value, onChange, onReset }: { decl: ShaderParamDecl; value?: ShaderParamValue; onChange(v: ShaderParamValue): void; onReset(): void }) {
	const v = value ?? p.default;
	const set = value !== undefined;
	const ranged = p.min !== undefined && p.max !== undefined && p.max > p.min;
	let control;
	if (p.kind === "float") {
		const n = Number(v);
		control = ranged ? (
			<span className="row">
				<input type="range" className="grow" min={p.min} max={p.max} step={(p.max! - p.min!) / 200} value={n} onChange={(e) => onChange(Number(e.target.value))} data-testid={`shader-param-${p.name}`} />
				<span className="small param-value">{Math.round(n * 1000) / 1000}</span>
			</span>
		) : (
			<input type="number" step={0.01} value={n} onChange={(e) => onChange(Number(e.target.value))} data-testid={`shader-param-${p.name}`} />
		);
	} else if (p.kind === "color") {
		control = <input type="color" value={hex(v)} onChange={(e) => onChange(e.target.value)} data-testid={`shader-param-${p.name}`} />;
	} else if (p.kind === "texture") {
		control = <input value={String(v)} placeholder="textures/…png" onChange={(e) => onChange(e.target.value)} data-testid={`shader-param-${p.name}`} />;
	} else {
		const arr = Array.isArray(v) ? v : [];
		control = (
			<span className="vec">
				{arr.map((x, i) => (
					<input key={i} type="number" step={0.01} value={x} onChange={(e) => onChange(arr.map((y, j) => (j === i ? Number(e.target.value) : y)))} />
				))}
			</span>
		);
	}
	return (
		<div className="field-row" title={`${p.kind} · line ${p.line}${ranged ? ` · [${p.min}, ${p.max}]` : ""}`}>
			<span className={`field-name ${set ? "" : "muted"}`}>{p.name}</span>
			{control}
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

function NewShaderDialog({ onClose }: { onClose(): void }) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const [name, setName] = useState("");
	const [template, setTemplate] = useState(SHADER_TEMPLATES[0].id);
	const [busy, setBusy] = useState(false);
	const create = async () => {
		const n = name.trim();
		setBusy(true);
		try {
			const source = SHADER_TEMPLATES.find((t) => t.id === template)!.source;
			await runInWorktree(`Shader: ${n}`, "write_shader", { shader: n, source, create: true });
			bumpAssets();
			showAsset({ path: `${SHADER_DIR}/${n}.glsl` });
			onClose();
		} catch (err) {
			showError(err);
			setBusy(false);
		}
	};
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal col" style={{ width: 480 }} onClick={(e) => e.stopPropagation()} data-testid="shader-new">
				<h3>New shader</h3>
				<label className="field">
					<span>Name (materials use it as "shaders/&lt;name&gt;.glsl")</span>
					<input autoFocus value={name} placeholder="water, nature/wind, lantern-glow" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ASSET_NAME.test(name.trim()) && void create()} data-testid="shader-new-name" />
				</label>
				<label className="field">
					<span>Start from</span>
					<select value={template} onChange={(e) => setTemplate(e.target.value)} data-testid="shader-new-template">
						{SHADER_TEMPLATES.map((t) => (
							<option key={t.id} value={t.id}>
								{t.label}
							</option>
						))}
					</select>
				</label>
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={onClose}>Cancel</button>
					<button className="primary" disabled={busy || !ASSET_NAME.test(name.trim())} onClick={() => void create()} data-testid="shader-new-create">
						Create
					</button>
				</div>
			</div>
		</div>
	);
}
