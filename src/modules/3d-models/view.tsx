// 3D Models: browse models (main checkout + drafts), a concept board, a 3D viewer and the in-engine view.
// Buttons run generation steps in a session's worktree: the draft's session, or a new 3D Modeller session
// created as a workspace (no agent run, so no account needed). Merging that session lands the model.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConceptImage, GenJob, ModelManifest } from "../../shared/gen";
import type { StudioRequestMethod } from "../../shared/host";
import type { AssetSummary, ModuleInfo } from "../../shared/modules";
import { call, onEvent, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { editCheckout, runInWorktree } from "../../renderer/workspace";
import { leafName } from "../../shared/asset-names";
import { modelName } from "./info";
import { ModelViewer, type ViewerOptions } from "./ModelViewer";
import { useShallow } from "zustand/react/shallow";

const parse = (text: string): ModelManifest | null => {
	try {
		return text ? (JSON.parse(text) as ModelManifest) : null;
	} catch {
		return null;
	}
};
const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
const toName = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((w) => !["a", "an", "the", "of", "with", "and"].includes(w))
		.slice(0, 3)
		.join("-");

/** Generation jobs a session started, kept live from `gen_job` events. */
export function useSessionJobs(checkout: string | undefined): GenJob[] {
	const [jobs, setJobs] = useState<GenJob[]>([]);
	useEffect(() => {
		if (!checkout) return setJobs([]);
		call("gen.jobs").then((all) => setJobs(all.filter((j) => j.sessionId === checkout)), () => {});
		return onEvent((e) => {
			if (e.type !== "gen_job" || e.job.sessionId !== checkout) return;
			setJobs((list) => (list.some((j) => j.id === e.job.id) ? list.map((j) => (j.id === e.job.id ? e.job : j)) : [...list, e.job]));
		});
	}, [checkout]);
	return jobs;
}

export function JobProgress({ jobs }: { jobs: GenJob[] }) {
	const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
	if (!active.length) return null;
	const running = active.find((j) => j.status === "running");
	return (
		<div className="gen-progress" data-testid="gen-progress">
			<span className="dot gen-busy" />
			<span className="grow ellipsis">
				{running ? `${running.label}: ${running.progress?.message ?? "starting"}` : `${active[0].label}: queued`}
				{active.length > 1 && <span className="muted"> · {active.length - 1} more queued</span>}
			</span>
			{typeof running?.progress?.fraction === "number" && <progress value={running.progress.fraction} max={1} />}
			<button className="ghost" onClick={() => active.forEach((j) => void call("gen.cancel", j.id))}>
				Cancel
			</button>
		</div>
	);
}

export function ModelsView({ module }: { module: ModuleInfo }) {
	const [creating, setCreating] = useState(false);
	return (
		<>
			<AssetBrowser
				module={module}
				newLabel="+ New model"
				onNew={() => setCreating(true)}
				modifyLabel="Ask the modeller"
				modifyPlaceholder="What should change? The 3D Modeller agent can regenerate, re-texture, rig, or edit precisely in Blender."
				emptyText="No models yet. Start one with “New model”."
				itemPreview={(asset, checkout) => <Thumbnail asset={asset} checkout={checkout} />}
				content={(props) => <ModelDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />}
			/>
			{creating && <NewModelDialog onClose={() => setCreating(false)} />}
		</>
	);
}

function Thumbnail({ asset, checkout }: { asset: AssetSummary; checkout?: string }) {
	const [failed, setFailed] = useState(false);
	const dir = asset.path.slice(0, asset.path.lastIndexOf("/"));
	// Drafts have no mtime; the summary changes when a model (and so a thumbnail) appears or is regenerated.
	const version = `${asset.updatedAt ?? ""}:${asset.excerpt}`;
	useEffect(() => setFailed(false), [version, checkout]);
	// No model yet (so no thumbnail): show the newest concept instead.
	const [concept, setConcept] = useState<string | null>();
	useEffect(() => {
		if (!failed) return;
		let live = true;
		call("models3d.concepts", checkout ?? null, modelName(asset.path)).then(
			(images) => live && setConcept(images[0]?.path ?? null),
			() => live && setConcept(null),
		);
		return () => {
			live = false;
		};
	}, [failed, version, checkout, asset.path]);
	if (failed && concept)
		return (
			<div className="model-thumb concept" data-testid="concept-thumb">
				<img src={studioFile(checkout, concept)} alt="" />
				<span>concept</span>
			</div>
		);
	return failed ? (
		<div className="model-thumb empty">{concept === null ? "no concepts yet" : ""}</div>
	) : (
		<img className="model-thumb" src={studioFile(checkout, `${dir}/thumbnail.png`, version)} alt="" onError={() => setFailed(true)} />
	);
}

function NewModelDialog({ onClose }: { onClose(): void }) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const [description, setDescription] = useState("");
	const [name, setName] = useState("");
	const [count, setCount] = useState(4);
	const [checkout, setCheckout] = useState<string>();
	const jobs = useSessionJobs(checkout);
	const finalName = name || toName(description);

	const create = async () => {
		try {
			const id = await editCheckout(`Model: ${finalName}`);
			setCheckout(id);
			await call("worktrees.run", id, "generate_concepts", { model: finalName, prompt: description.trim(), count });
			bumpAssets();
			showAsset({ path: `assets/models/${finalName}/model.json` });
			onClose();
		} catch (err) {
			showError(err);
			setCheckout(undefined);
		}
	};

	return (
		<div className="modal-backdrop">
			<div className="modal col">
				<h2>New 3D model</h2>
				<label className="field">
					<span>What is it?</span>
					<textarea
						data-testid="new-model-description"
						rows={3}
						autoFocus
						placeholder="A stylised wooden treasure chest with iron bands and a brass lock"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
					<small className="muted">One object and its style. Concepts are drawn on a plain white background, ready for 3D.</small>
				</label>
				<div className="row">
					<label className="field grow">
						<span>Name</span>
						<input data-testid="new-model-name" placeholder={toName(description) || "treasure-chest"} value={name} onChange={(e) => setName(e.target.value)} />
					</label>
					<label className="field">
						<span>Concepts</span>
						<select value={count} onChange={(e) => setCount(Number(e.target.value))}>
							{[1, 2, 4, 6, 8].map((n) => (
								<option key={n}>{n}</option>
							))}
						</select>
					</label>
				</div>
				<small className="muted">
					This starts a 3D Modeller session as the model's workspace: everything is made in its worktree, and merging the session adds the model to
					the project.
				</small>
				<JobProgress jobs={jobs} />
				<div className="row">
					<span className="grow" />
					<button onClick={onClose} disabled={!!checkout}>
						Cancel
					</button>
					<button className="primary" disabled={!description.trim() || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(finalName) || !!checkout} onClick={create}>
						{checkout ? "Generating…" : "Generate concepts"}
					</button>
				</div>
			</div>
		</div>
	);
}

type Tab = "model" | "concepts" | "engine";

function ModelDetail({ asset, text, checkout }: AssetContentProps) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	// The name comes from the path: right after switching models, `text` can still be the previous model's
	// manifest until the new one loads, so a manifest for another model is ignored.
	const name = modelName(asset.path);
	const parsed = parse(text);
	const manifest = parsed?.name === name ? parsed : null;
	const dir = `assets/models/${name}`;
	const hasModel = !!manifest?.stats;
	// The manifest loads after the first render, so the default tab follows it until the user picks one.
	const [chosenTab, setTab] = useState<Tab | null>(null);
	const tab: Tab = chosenTab ?? (hasModel ? "model" : "concepts");
	const [running, setRunning] = useState(false);
	const jobs = useSessionJobs(checkout);

	/** Runs a generation step in this draft's session, or in a new workspace session for a merged model. */
	const run = async (method: StudioRequestMethod, params: Record<string, unknown>, then?: Tab) => {
		setRunning(true);
		try {
			await runInWorktree(`Model: ${name}`, method, { model: name, ...params });
			bumpAssets();
			if (then) setTab(then);
		} catch (err) {
			showError(err);
		} finally {
			setRunning(false);
		}
	};

	return (
		<div className="model-detail">
			<div className="tabs">
				{(["model", "concepts", "engine"] as const).map((t) => (
					<button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
						{t === "model" ? "Model" : t === "concepts" ? "Concepts" : "In engine"}
					</button>
				))}
			</div>
			<JobProgress jobs={jobs} />
			{tab === "model" &&
				(hasModel ? (
					<ModelTab manifest={manifest!} dir={dir} checkout={checkout} busy={running} run={run} />
				) : (
					<div className="empty">
						No 3D model yet. Pick a concept and generate one on the <a onClick={() => setTab("concepts")}>Concepts</a> tab.
					</div>
				))}
			{tab === "concepts" && <ConceptsTab manifest={manifest} name={name} dir={dir} checkout={checkout} busy={running} run={run} />}
			{tab === "engine" && (hasModel ? <EngineTab name={name} checkout={checkout} /> : <div className="empty">No 3D model yet.</div>)}
		</div>
	);
}

interface TabProps {
	manifest: ModelManifest;
	dir: string;
	checkout?: string;
	busy: boolean;
	run(method: StudioRequestMethod, params: Record<string, unknown>, then?: Tab): Promise<void>;
}

function ModelTab({ manifest, dir, checkout, busy, run }: TabProps) {
	const [options, setOptions] = useState<ViewerOptions>({ wireframe: false, skeleton: false, scaleReference: true, clip: null });
	const [clips, setClips] = useState<string[]>([]);
	const [loadError, setLoadError] = useState<string>();
	const version = manifest.steps.at(-1)?.at;
	// The file is named for the last part of the model's name: `cave/boulder-a` is `cave/boulder-a/boulder-a.glb`.
	const url = studioFile(checkout, `${dir}/${leafName(manifest.name)}.glb`, version);
	const onLoaded = useCallback((info: { clips: string[]; error?: string }) => {
		setClips(info.clips);
		setLoadError(info.error);
	}, []);
	const stats = manifest.stats ?? {};
	const size = stats.size as number[] | undefined;
	const toggle = (key: "wireframe" | "skeleton" | "scaleReference") => setOptions((o) => ({ ...o, [key]: !o[key] }));

	return (
		<div className="model-tab">
			<div className="viewer-wrap">
				<ModelViewer url={url} options={options} onLoaded={onLoaded} />
				{loadError && <div className="msg error viewer-error">Couldn't load the model: {loadError}</div>}
			</div>
			<div className="model-side col">
				<h3>Model</h3>
				<dl className="model-stats">
					<dt>Height</dt>
					<dd>{manifest.height} m</dd>
					{size && (
						<>
							<dt>Size</dt>
							<dd>{size.map((v) => v.toFixed(2)).join(" × ")} m</dd>
						</>
					)}
					<dt>Triangles</dt>
					<dd>{String(stats.triangles ?? "?")}</dd>
					<dt>Vertices</dt>
					<dd>{String(stats.vertices ?? "?")}</dd>
					<dt>Texture</dt>
					<dd>{manifest.textured ? "yes" : "no"}</dd>
					<dt>Rig</dt>
					<dd>{manifest.rigged ? `${String(stats.bones)} bones` : "none"}</dd>
				</dl>
				<h3>View</h3>
				<label className="check">
					<input type="checkbox" checked={options.wireframe} onChange={() => toggle("wireframe")} /> Wireframe
				</label>
				<label className="check">
					<input type="checkbox" checked={options.scaleReference} onChange={() => toggle("scaleReference")} /> 1.75 m person for scale
				</label>
				{manifest.rigged && (
					<label className="check">
						<input type="checkbox" checked={options.skeleton} onChange={() => toggle("skeleton")} /> Skeleton
					</label>
				)}
				{clips.length > 0 && (
					<label className="field">
						<span>Animation</span>
						<select value={options.clip ?? ""} onChange={(e) => setOptions((o) => ({ ...o, clip: e.target.value || null }))}>
							<option value="">Rest pose</option>
							{clips.map((c) => (
								<option key={c}>{c}</option>
							))}
						</select>
					</label>
				)}
				<h3>Change</h3>
				<RigActions manifest={manifest} busy={busy} run={run} />
				<small className="muted">Re-texture or regenerate from the Concepts tab. For precise edits, ask the modeller agent.</small>
				{manifest.conceptSource && (
					<>
						<h3>Made from</h3>
						<small className="muted">{manifest.conceptSource.prompt}</small>
					</>
				)}
			</div>
		</div>
	);
}

/** Rigging and animation: a character rig (UniRig) plus clips, or a hinge rig for props. */
function RigActions({ manifest, busy, run }: Pick<TabProps, "manifest" | "busy" | "run">) {
	const [prop, setProp] = useState(manifest.propRig ?? { split: 0.6, hinge: "back", angle: 100 });
	const [editingProp, setEditingProp] = useState(false);
	const rigProp = () => run("rig_prop", prop).then(() => setEditingProp(false));
	return (
		<>
			{manifest.rig === "prop" && manifest.propRig && (
				<small className="muted" data-testid="prop-rig">
					Prop rig: hinged at the {manifest.propRig.hinge}, cut at {Math.round(manifest.propRig.split * 100)}% height, opens {manifest.propRig.angle}°.
				</small>
			)}
			{manifest.rig !== "prop" && manifest.rigged && !manifest.clips?.length && (
				<button disabled={busy} onClick={() => run("animate_model", {})} title="Name the bones by role and add idle, walk and wave clips (two-legged characters)">
					Add animations
				</button>
			)}
			{manifest.clips?.length ? <small className="muted">Clips: {manifest.clips.join(", ")} (play them above).</small> : null}
			{!manifest.rigged && (
				<button disabled={busy} onClick={() => run("rig_model", {})} title="Skeleton and skin weights for characters and creatures (UniRig)">
					Rig as character
				</button>
			)}
			{manifest.rig !== "auto" && !editingProp && (
				<button disabled={busy} onClick={() => setEditingProp(true)} title="A hinge for a lid, door or hatch, with open and close clips">
					{manifest.rig === "prop" ? "Change the prop rig" : "Rig as prop (hinge)"}
				</button>
			)}
			{editingProp && (
				<div className="col prop-form">
					<label className="row">
						Hinge
						<select value={prop.hinge} onChange={(e) => setProp({ ...prop, hinge: e.target.value })}>
							{["back", "front", "left", "right"].map((h) => (
								<option key={h}>{h}</option>
							))}
						</select>
					</label>
					<label className="row" title="Where the moving part starts, as a share of the model's height">
						Cut at
						<input type="number" min={5} max={95} step={1} value={Math.round(prop.split * 100)} onChange={(e) => setProp({ ...prop, split: Number(e.target.value) / 100 })} style={{ width: 64 }} />%
					</label>
					<label className="row">
						Opens
						<input type="number" min={10} max={180} step={5} value={prop.angle} onChange={(e) => setProp({ ...prop, angle: Number(e.target.value) })} style={{ width: 64 }} />°
					</label>
					<div className="row">
						<button className="primary" disabled={busy} onClick={rigProp}>
							Rig prop
						</button>
						<button className="ghost" onClick={() => setEditingProp(false)}>
							Cancel
						</button>
					</div>
				</div>
			)}
		</>
	);
}

function ConceptsTab({ manifest, name, dir, checkout, busy, run }: Omit<TabProps, "manifest"> & { manifest: ModelManifest | null; name: string }) {
	const { assetsVersion, showError, openNewSession } = useStudio(
		useShallow((s) => ({
			assetsVersion: s.assetsVersion,
			showError: s.showError,
			openNewSession: s.openNewSession,
		})),
	);
	const [concepts, setConcepts] = useState<ConceptImage[]>([]);
	// Click selects one concept; Ctrl/Cmd-click adds more (e.g. a back view) to hand over together.
	const [picked, setPicked] = useState<string[]>([]);
	const selected = picked[0] ?? null;
	const [prompt, setPrompt] = useState(manifest?.description ?? "");
	const [edited, setEdited] = useState(false);
	// Follow the manifest (it loads after the first render, and changes when concepts are made) until edited.
	useEffect(() => {
		if (!edited && manifest?.description) setPrompt(manifest.description);
	}, [manifest?.description, edited]);
	const [count, setCount] = useState(4);
	const [height, setHeight] = useState(manifest?.height ?? 1);
	useEffect(() => {
		if (manifest?.height) setHeight(manifest.height);
	}, [manifest?.height]);
	const [texture, setTexture] = useState(true);
	const [rig, setRig] = useState(manifest?.rigged ?? false);

	useEffect(() => {
		call("models3d.concepts", checkout ?? null, name).then(setConcepts, showError);
	}, [name, checkout, assetsVersion, showError]);
	const current = manifest?.concept ? `${dir}/${manifest.concept}` : null;
	const chosen = selected ?? current ?? concepts[0]?.path ?? null;
	const records = useMemo(() => new Map(concepts.map((c) => [c.path, c.record])), [concepts]);

	return (
		<div className="concepts-tab">
			<div className="concept-controls col">
				<textarea
					rows={2}
					value={prompt}
					placeholder="Describe the object…"
					onChange={(e) => {
						setEdited(true);
						setPrompt(e.target.value);
					}}
					data-testid="concept-prompt"
				/>
				<div className="row" style={{ flexWrap: "wrap" }}>
					<select value={count} onChange={(e) => setCount(Number(e.target.value))} title="How many images">
						{[1, 2, 4, 6, 8].map((n) => (
							<option key={n} value={n}>
								{n} image{n > 1 ? "s" : ""}
							</option>
						))}
					</select>
					<button disabled={busy || !prompt.trim()} onClick={() => run("generate_concepts", { prompt: prompt.trim(), count })}>
						Generate
					</button>
					<button
						disabled={busy || !prompt.trim() || !chosen}
						title="Use the selected concept as a reference: variations, edits ('with silver bands'), or other views ('seen from behind')"
						onClick={() => run("generate_concepts", { prompt: prompt.trim(), count, references: [chosen] })}
					>
						Generate from selected
					</button>
				</div>
			</div>
			<div className="concept-grid" data-testid="concept-grid">
				{concepts.length === 0 && <div className="muted">No concepts yet.</div>}
				{concepts.map((c) => (
					<figure
						key={c.path}
						className={`concept ${c.path === chosen || picked.includes(c.path) ? "selected" : ""}`}
						data-testid="concept"
						onClick={(e) => setPicked((p) => (e.ctrlKey || e.metaKey ? (p.includes(c.path) ? p.filter((x) => x !== c.path) : [...p, c.path]) : [c.path]))}
						title={c.record ? `${c.record.prompt}\nseed ${c.record.seed}${c.record.references ? ` · from ${c.record.references.join(", ")}` : ""}` : c.path}
					>
						<img src={studioFile(checkout, c.path)} alt="" />
						<figcaption>
							{c.path === current && <span className="badge draft">used for the model</span>}
							<span className="muted ellipsis">{c.record?.references ? "edit · " : ""}{c.path.split("/").pop()}</span>
						</figcaption>
					</figure>
				))}
			</div>
			{chosen && (
				<div className="make-model row" data-testid="make-model">
					<span className="grow muted ellipsis" title={`${records.get(chosen)?.prompt ?? ""}\nCtrl-click to select more (e.g. a back view)`}>
						Selected: {(picked.length ? picked : [chosen]).map((p) => p.split("/").pop()).join(", ")}
					</span>
					<label className="row">
						Height
						<input type="number" min={0.05} step={0.05} value={height} onChange={(e) => setHeight(Number(e.target.value))} style={{ width: 80 }} /> m
					</label>
					<label className="check">
						<input type="checkbox" checked={texture} onChange={() => setTexture(!texture)} /> Texture
					</label>
					<label className="check" title="Characters and creatures. They rig best from concepts with the arms held clear of the body and props (hands resting on a bag bind the bag to the hands).">
						<input type="checkbox" checked={rig} onChange={() => setRig(!rig)} /> Rig
					</label>
					{manifest?.stats && (
						<button disabled={busy} onClick={() => run("retexture_model", { image: chosen }, "model")} title="Keep the shape; paint a new texture from this concept">
							Re-texture
						</button>
					)}
					<button
						disabled={busy}
						title="Start a 3D Modeller session with the selected concept(s): it makes the model and checks it in the engine"
						data-testid="hand-to-modeller"
						onClick={() => {
							const images = picked.length ? picked : [chosen];
							openNewSession({
								agentType: "3d-modeller",
								target: "project",
								linkedAsset: `${dir}/model.json`,
								context: `Hand to the 3D Modeller: ${name}`,
								prompt:
									`Make the 3D model "${name}" from the chosen concept ${images[0]}${images.length > 1 ? ` (also chosen: ${images.slice(1).join(", ")}; use a back view as \`back\`)` : ""}. ` +
									`Height ${height} m${texture ? ", textured" : ", untextured"}${rig ? ", rigged (a character or creature)" : ""}. ` +
									`The concepts were made from: "${records.get(images[0])?.prompt ?? manifest?.description ?? name}". Check it in the engine with preview_model.`,
							});
						}}
					>
						Hand to the 3D Modeller…
					</button>
					<button className="primary" disabled={busy || !(height > 0)} onClick={() => run("generate_model", { image: chosen, height, texture, rig }, "model")}>
						{manifest?.stats ? "Regenerate 3D model" : "Generate 3D model"}
					</button>
				</div>
			)}
		</div>
	);
}

function EngineTab({ name, checkout }: { name: string; checkout?: string }) {
	const { showError } = useStudio(useShallow((s) => ({ showError: s.showError })));
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ images: string[]; errors: string[] } | null>(null);
	const render = async () => {
		setBusy(true);
		try {
			setResult(await call("models3d.preview", checkout ?? null, name));
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="engine-tab col">
			<div className="row">
				<span className="muted grow">
					The model as the game's engine draws it, with the game's lighting and shaders: the final word on how it looks in-game.
				</span>
				<button className="primary" disabled={busy} onClick={render} data-testid="render-in-engine">
					{busy ? "Rendering…" : result ? "Render again" : "Render in engine"}
				</button>
			</div>
			{result?.errors.map((e) => (
				<div key={e} className="msg error">
					{e}
				</div>
			))}
			<div className="engine-shots">
				{result?.images.map((src, i) => (
					<figure key={i} className="shot">
						<img src={src} alt="" data-testid="engine-shot" />
						<figcaption className="muted">{["Front", "Three-quarter", "Back"][i]}</figcaption>
					</figure>
				))}
			</div>
		</div>
	);
}
