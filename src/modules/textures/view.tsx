// Textures: tileable surfaces (ground, paths, walls, floors). A candidate board (generated seamless images, each
// shown tiled 2x2), the made texture tiled 3x3 with its normal and roughness maps, on a plane and a sphere in three.js
// and in the engine, and its settings. Steps run in the selected worktree (or a new one), like other sections.
import { useEffect, useState } from "react";
import { leafName } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { ASSET_NAME } from "../../shared/asset-names";
import { type CandidateRecord, parseTexture, TEXTURE_DEFAULTS } from "../../shared/texture";
import { call, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { editCheckout, runInWorktree } from "../../renderer/workspace";
import { JobProgress, useSessionJobs } from "../3d-models/view";
import { TexturePreview3D } from "./TexturePreview3D";
import { textureName } from "./info";
import { useShallow } from "zustand/react/shallow";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
type MapKind = "colour" | "normal" | "roughness";
const SUFFIX: Record<MapKind, string> = { colour: "", normal: "_normal", roughness: "_roughness" };

/** An image repeated n×n in a square (CSS), to show how it tiles. */
function Tiled({ url, n, size, testid }: { url: string; n: number; size?: number; testid?: string }) {
	return (
		<div
			className="tiled"
			data-testid={testid}
			style={{ backgroundImage: `url("${url}")`, backgroundSize: `${100 / n}% ${100 / n}%`, ...(size ? { width: size, height: size } : {}) }}
		/>
	);
}

export function TexturesView({ module }: { module: ModuleInfo }) {
	const [creating, setCreating] = useState(false);
	const { assetsVersion } = useStudio(useShallow((s) => ({ assetsVersion: s.assetsVersion })));
	return (
		<>
			<AssetBrowser
				module={module}
				newLabel="+ New texture"
				onNew={() => setCreating(true)}
				modifyLabel="Ask the texture artist"
				modifyPlaceholder="What should change? The Texture Artist makes tileable surfaces in the game's style, checks their seams, and sets their size."
				emptyText="No textures yet. Start one with “New texture”."
				itemPreview={(a, checkout) => {
					const name = textureName(a.path);
					return <Tiled url={studioFile(checkout, `assets/textures/${name}/${leafName(name)}.png`, `${assetsVersion}`)} n={2} />;
				}}
				content={(props) => <TextureDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />}
			/>
			{creating && <NewTextureDialog onClose={() => setCreating(false)} />}
		</>
	);
}

function TextureDetail({ asset, text, checkout }: AssetContentProps) {
	const { showError, assetsVersion } = useStudio(useShallow((s) => ({ showError: s.showError, assetsVersion: s.assetsVersion })));
	const name = textureName(asset.path);
	const dir = `assets/textures/${name}`;
	const leaf = leafName(name);
	const { texture, problems } = text ? parseTexture(text) : { texture: null, problems: [] };
	const [candidates, setCandidates] = useState<({ source: string } & CandidateRecord)[]>([]);
	const [shown, setShown] = useState<MapKind>("colour");
	const [busy, setBusy] = useState(false);
	const [engine, setEngine] = useState<{ images: { view: string; image: string }[]; warnings: string[] } | "loading" | null>(null);
	const [prompt, setPrompt] = useState("");
	const [draft, setDraft] = useState({ tile: 2, normal_strength: TEXTURE_DEFAULTS.normal_strength, rmin: 0.55, rmax: 0.95 });
	const jobs = useSessionJobs(checkout);
	const v = `${assetsVersion}`;
	const url = (k: MapKind) => studioFile(checkout, `${dir}/${leaf}${SUFFIX[k]}.png`, v);

	useEffect(() => {
		let live = true;
		call("textures.candidates", checkout ?? null, name).then((c) => live && setCandidates(c), () => {});
		return () => {
			live = false;
		};
	}, [name, checkout, assetsVersion]);
	useEffect(() => {
		if (!texture) return;
		setDraft({ tile: texture.tile, normal_strength: texture.normal_strength ?? TEXTURE_DEFAULTS.normal_strength, rmin: (texture.roughness ?? TEXTURE_DEFAULTS.roughness)[0], rmax: (texture.roughness ?? TEXTURE_DEFAULTS.roughness)[1] });
		setPrompt((p) => p || texture.prompt || "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [text]);

	const run = async (method: "generate_texture" | "make_texture", params: Record<string, unknown>) => {
		setBusy(true);
		try {
			await runInWorktree(`Texture: ${name}`, method, { name, ...params });
			bumpAssets();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};
	const settings = { tile: draft.tile, normal_strength: draft.normal_strength, roughness: [draft.rmin, draft.rmax] };

	return (
		<div className="doc-view col texture-detail" data-testid="texture-detail">
			{problems.length > 0 && (
				<div className="problems">
					{problems.map((p, i) => (
						<div key={i}>
							{p.at && <code>{p.at}</code>} {p.message}
						</div>
					))}
				</div>
			)}
			<JobProgress jobs={jobs} />
			{texture?.source ? (
				<section className="col">
					<div className="row">
						<h3 className="grow">Texture</h3>
						<div className="seg">
							{(["colour", "normal", "roughness"] as MapKind[]).map((k) => (
								<button key={k} className={shown === k ? "on" : ""} onClick={() => setShown(k)}>
									{k}
								</button>
							))}
						</div>
					</div>
					<div className="row texture-previews">
						<Tiled url={url(shown)} n={3} testid="texture-tiled" />
						<TexturePreview3D colour={url("colour")} normal={url("normal")} roughness={url("roughness")} tile={texture.tile} />
					</div>
					<span className="muted small">
						Tiled 3×3 (look for seams and repeating spots) · on a 6 m plane and a sphere at {texture.tile} m per repeat · from <code>{texture.source}</code>
					</span>
					<div className="row">
						<button
							disabled={engine === "loading"}
							onClick={() => {
								setEngine("loading");
								call("textures.preview", checkout ?? null, name).then(setEngine, (err) => (showError(err), setEngine(null)));
							}}
						>
							{engine === "loading" ? "Rendering…" : "In the engine"}
						</button>
					</div>
					{engine && engine !== "loading" && (
						<div className="row engine-shots">
							{engine.images.map((i) => (
								<img key={i.view} src={i.image} alt="" />
							))}
						</div>
					)}
				</section>
			) : (
				texture && <div className="empty">Not made yet: choose a candidate below.</div>
			)}
			{texture && (
				<section className="col">
					<h3>Settings</h3>
					<div className="row texture-settings">
						<label className="field">
							<span>Tile (m)</span>
							<input type="number" min={0.1} step={0.1} value={draft.tile} onChange={(e) => setDraft({ ...draft, tile: Number(e.target.value) })} data-testid="texture-tile" />
						</label>
						<label className="field">
							<span>Relief</span>
							<input type="number" min={0} max={20} step={0.5} value={draft.normal_strength} onChange={(e) => setDraft({ ...draft, normal_strength: Number(e.target.value) })} />
						</label>
						<label className="field">
							<span>Roughness</span>
							<span className="row">
								<input type="number" min={0} max={1} step={0.05} value={draft.rmin} onChange={(e) => setDraft({ ...draft, rmin: Number(e.target.value) })} />
								–
								<input type="number" min={0} max={1} step={0.05} value={draft.rmax} onChange={(e) => setDraft({ ...draft, rmax: Number(e.target.value) })} />
							</span>
						</label>
						<button disabled={busy || !texture.source} onClick={() => void run("make_texture", settings)} data-testid="texture-remake">
							Apply
						</button>
					</div>
				</section>
			)}
			<section className="col">
				<div className="row">
					<h3 className="grow">Candidates</h3>
					<span className="muted small">Each tiled 2×2. Two per seed: made seamless while generating (roll) or by cutting afterwards (quilt).</span>
				</div>
				<div className="candidate-grid">
					{candidates.map((c) => (
						<div key={c.source} className={`candidate ${texture?.source === c.source ? "chosen" : ""}`} data-testid="texture-candidate">
							<Tiled url={studioFile(checkout, `${dir}/${c.source}`, v)} n={2} />
							<div className="row">
								<span className="grow muted small">
									{c.method} · seed {c.seed}
								</span>
								{texture?.source === c.source ? (
									<span className="small">In use</span>
								) : (
									<button className="small" disabled={busy} onClick={() => void run("make_texture", { ...settings, source: c.source })} data-testid="candidate-use">
										Use this
									</button>
								)}
							</div>
						</div>
					))}
				</div>
				<div className="row">
					<input className="grow" value={prompt} placeholder="The surface: e.g. mossy cobblestone path, rounded grey stones" onChange={(e) => setPrompt(e.target.value)} />
					<button disabled={busy || !prompt.trim()} onClick={() => void run("generate_texture", { prompt: prompt.trim(), count: 2 })} data-testid="texture-more">
						More candidates
					</button>
				</div>
			</section>
		</div>
	);
}

function NewTextureDialog({ onClose }: { onClose(): void }) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const [prompt, setPrompt] = useState("");
	const [name, setName] = useState("");
	const [count, setCount] = useState(2);
	const [checkout, setCheckout] = useState<string>();
	const jobs = useSessionJobs(checkout);
	const guess = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 2).join("-");
	const finalName = name || guess;
	const create = async () => {
		try {
			const id = await editCheckout(`Texture: ${finalName}`);
			setCheckout(id);
			await call("worktrees.run", id, "generate_texture", { name: finalName, prompt: prompt.trim(), count });
			bumpAssets();
			showAsset({ path: `assets/textures/${finalName}/texture.json` });
			onClose();
		} catch (err) {
			showError(err);
			setCheckout(undefined);
		}
	};
	return (
		<div className="modal-backdrop">
			<div className="modal col" data-testid="new-texture">
				<h2>New texture</h2>
				<label className="field">
					<span>What surface?</span>
					<textarea
						rows={3}
						autoFocus
						value={prompt}
						placeholder="short stylised grass with small clover leaves, hand-painted, calm palette"
						onChange={(e) => setPrompt(e.target.value)}
						data-testid="new-texture-prompt"
					/>
					<small className="muted">The surface and its style; the studio adds top-down, flat-lit and seamless.</small>
				</label>
				<div className="row">
					<label className="field grow">
						<span>Name</span>
						<input placeholder={guess || "grass"} value={name} onChange={(e) => setName(e.target.value)} data-testid="new-texture-name" />
					</label>
					<label className="field">
						<span>Seeds</span>
						<select value={count} onChange={(e) => setCount(Number(e.target.value))}>
							{[1, 2, 3, 4].map((n) => (
								<option key={n}>{n}</option>
							))}
						</select>
					</label>
				</div>
				<small className="muted">Two candidates per seed, about 25 s each on the GPU. They're made in the selected worktree (or a new one).</small>
				<JobProgress jobs={jobs} />
				<div className="row">
					<span className="grow" />
					<button onClick={onClose} disabled={!!checkout}>
						Cancel
					</button>
					<button className="primary" disabled={!prompt.trim() || !ASSET_NAME.test(finalName) || !!checkout} onClick={create} data-testid="new-texture-create">
						{checkout ? "Generating…" : "Generate candidates"}
					</button>
				</div>
			</div>
		</div>
	);
}
