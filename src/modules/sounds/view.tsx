// Sound Effects: generated takes first (the raw material: audition them levelled, generate more from any prompt),
// then the variants the game plays (each a mix of its own layers: usually one take), composed from the takes
// here, then processing shared by the variants, and where the game uses the sound. sound.json is the asset;
// edits and renders run in a session's worktree (the draft's session, or a Sound Designer workspace).
import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioRequestMethod } from "../../shared/host";
import type { ModuleInfo } from "../../shared/modules";
import { composeVariants, type Layer, parseSound, type Sound, type TakeRecord, type Variant, variantFile } from "../../shared/sound";
import { call, sha1, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { runInWorktree } from "../../renderer/workspace";
import { leafName } from "../../shared/asset-names";
import { soundName } from "./info";
import { useShallow } from "zustand/react/shallow";
import { type Decoded, decode, type Player, usePlayer } from "./audio";
import { LiveEffects } from "./live-effects";

export { type Player, usePlayer };

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
/** A take whose CLAP score is this far below its batch's median is flagged (as the pipeline does for agents). */
const OFF_PROMPT = 0.15;

export function SoundsView({ module }: { module: ModuleInfo }) {
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New sound"
			newPreset={{
				agentType: "sound-designer",
				placeholder:
					"Describe the sound: what makes it and what it's made of, where it plays (UI, in the world, an ambience), how long, whether it loops, and how many variants (footsteps and hits need several).",
			}}
			modifyLabel="Ask the sound designer"
			modifyPlaceholder="What should change? The Sound Designer edits sound.json: new takes, which takes make the variants, layers, processing."
			emptyText="No sound effects yet. Start one with “New sound”: the Sound Designer generates takes and makes the variants the game plays."
			content={(props) => <SoundDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />}
		/>
	);
}

// --- Waveforms -------------------------------------------------------------------------------------------
/** A waveform (sqrt scale, as the agents' images); `level` draws only the trimmed part, scaled to its peak. */
export function Waveform({ url, level, onDecoded }: { url: string; level?: boolean; onDecoded?(d: Decoded): void }) {
	const canvas = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		let live = true;
		decode(url).then(
			(d) => {
				const c = canvas.current;
				if (!live || !c) return;
				onDecoded?.(d);
				const g = c.getContext("2d")!;
				const { width, height } = c;
				g.clearRect(0, 0, width, height);
				g.fillStyle = getComputedStyle(c).color;
				const [from, to] = level ? [d.start, d.end] : [0, d.mono.length];
				const scale = level && d.peak > 1e-6 ? 1 / d.peak : 1;
				const cols = 240;
				const per = Math.max(1, (to - from) / cols);
				const y = (v: number) => height / 2 - Math.sign(v) * Math.sqrt(Math.min(1, Math.abs(v) * scale)) * (height / 2);
				for (let i = 0; i < cols; i++) {
					let lo = 0;
					let hi = 0;
					for (let j = Math.floor(from + i * per); j < Math.min(to, from + (i + 1) * per); j++) {
						lo = Math.min(lo, d.mono[j]);
						hi = Math.max(hi, d.mono[j]);
					}
					const top = y(hi);
					g.fillRect((i / cols) * width, top, Math.max(1, width / cols - 0.5), Math.max(1, y(lo) - top));
				}
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [url, level, onDecoded]);
	return <canvas ref={canvas} className="waveform" width={480} height={56} />;
}

// --- The detail view ----------------------------------------------------------------------------------------

type RenderState = { kind: "loading" } | { kind: "none" } | { kind: "stale"; files: string[] } | { kind: "current"; files: string[] };

interface Take {
	id: string;
	record?: TakeRecord;
	off: boolean;
}

function SoundDetail({ asset, text, checkout }: AssetContentProps) {
	const { showAsset, showError } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, showError: s.showError })));
	const name = soundName(asset.path);
	const dir = `assets/sounds/${name}`;
	const { sound, problems } = useMemo(() => parseSound(text), [text]);
	const [render, setRender] = useState<RenderState>({ kind: "loading" });
	const [records, setRecords] = useState<Record<string, TakeRecord>>({});
	const [usages, setUsages] = useState<{ path: string; line: number; text: string }[] | null>(null);
	const [version, setVersion] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const player = usePlayer();
	const file = (path: string) => studioFile(checkout, `${dir}/${path}`, `${version}`);

	useEffect(() => {
		let live = true;
		(async () => {
			const r = await fetch(studioFile(checkout, `${dir}/render.json`, `${Date.now()}`)).catch(() => null);
			const t = await fetch(studioFile(checkout, `${dir}/takes/takes.json`, `${Date.now()}`)).catch(() => null);
			if (!live) return;
			setRecords(t?.ok ? await t.json() : {});
			if (!r?.ok) return setRender({ kind: "none" });
			const info = (await r.json()) as { sound: string; files: string[] };
			setRender({ kind: info.sound === (await sha1(text)) ? "current" : "stale", files: info.files });
		})();
		// Where it's used is a nicety: a draft whose session just ended can't be searched any more.
		call("sounds.usages", checkout ?? null, name).then(
			(u) => live && setUsages(u),
			() => live && setUsages([]),
		);
		return () => {
			live = false;
		};
	}, [dir, name, checkout, text, version, showError]);

	/** Runs a step in this draft's session, or the sound's open workspace, or a new one. */
	const run = async (label: string, method: StudioRequestMethod, params: Record<string, unknown>) => {
		setBusy(label);
		try {
			await runInWorktree(`Sound: ${name}`, method, { name, ...params });
			bumpAssets();
			setVersion((v) => v + 1);
		} catch (err) {
			showError(err);
		} finally {
			setBusy(null);
		}
	};
	const setVariants = (variants: Variant[]) => void run("Rendering…", "edit_sound", { variants });

	// Takes grouped by the prompt they came from, newest prompt first; off-prompt within each batch.
	const groups = useMemo(() => {
		const byPrompt = new Map<string, { prompt: string; seconds: number; group: string; latest: string; takes: Take[] }>();
		const batches = new Map<string, TakeRecord[]>();
		for (const r of Object.values(records)) batches.set(r.at, [...(batches.get(r.at) ?? []), r]);
		const off = new Set<string>();
		for (const b of batches.values()) {
			const scores = b.map((r) => r.clap).filter((c): c is number => c !== undefined).sort((x, y) => x - y);
			if (scores.length > 2) for (const r of b) if (r.clap !== undefined && r.clap < scores[Math.floor(scores.length / 2)] - OFF_PROMPT) off.add(`${r.group}-${r.seed}`);
		}
		for (const [fileName, r] of Object.entries(records)) {
			const key = `${r.seconds}|${r.prompt}`;
			const g = byPrompt.get(key) ?? { prompt: r.prompt, seconds: r.seconds, group: r.group, latest: r.at, takes: [] };
			const id = fileName.replace(/\.wav$/, "");
			g.takes.push({ id, record: r, off: off.has(id) });
			if (r.at > g.latest) g.latest = r.at;
			byPrompt.set(key, g);
		}
		const list = [...byPrompt.values()].sort((a, b) => b.latest.localeCompare(a.latest));
		for (const g of list) g.takes.sort((a, b) => (a.record?.seed ?? 0) - (b.record?.seed ?? 0));
		// Takes a variant uses without a record (written by hand) still show.
		const known = new Set(list.flatMap((g) => g.takes.map((t) => t.id)));
		const loose = (sound?.variants ?? []).flatMap((v) => v.layers.flatMap((l) => ("take" in l && !known.has(l.take) ? [l.take] : [])));
		if (loose.length) list.push({ prompt: "(no record)", seconds: 0, group: "", latest: "", takes: [...new Set(loose)].map((id) => ({ id, off: false })) });
		return list;
	}, [records, sound]);

	const usedIn = (id: string) => (sound?.variants ?? []).flatMap((v, i) => (v.layers.some((l) => "take" in l && l.take === id) ? [i + 1] : []));
	const files = render.kind === "current" || render.kind === "stale" ? render.files : [];
	const playInGame = () => {
		const f = files[Math.floor(Math.random() * files.length)];
		void player.toggle(file(f), { rate: sound?.loop ? 1 : 0.96 + Math.random() * 0.08, loop: sound?.loop, id: "game" });
	};
	const toggleSelect = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

	return (
		<div className="sound-detail" data-testid="sound-detail">
			<div className="row sound-head">
				<div className="grow col">
					<div className="muted">{sound && [sound.loop ? "loop" : "one-shot", `${sound.variants.length} variant${sound.variants.length > 1 ? "s" : ""}`].join(" · ")}</div>
					{sound?.notes && <div className="sound-notes">{sound.notes}</div>}
				</div>
				<div className="row render-status" data-testid="render-status" data-state={render.kind}>
					<span className={`muted ${render.kind === "stale" ? "warn" : ""}`}>
						{busy ?? { loading: "", none: "Not rendered yet", stale: "The audio is older than sound.json", current: "Audio up to date" }[render.kind]}
					</span>
					{(render.kind === "none" || render.kind === "stale") && (
						<button className="primary" disabled={!!busy || !sound} onClick={() => void run("Rendering…", "render_sound", {})}>
							Render
						</button>
					)}
				</div>
			</div>
			{problems.length > 0 && (
				<div className="card music-problems" data-testid="sound-problems">
					<h3>Problems in sound.json</h3>
					{problems.map((p, i) => (
						<div key={i}>
							{p.at && <code>{p.at}</code>} {p.message}
						</div>
					))}
				</div>
			)}

			<div className="card col" data-testid="takes">
				<div className="col" style={{ gap: 2 }}>
					<h3>Takes</h3>
					<div className="muted small">
						What the model generated: raw material, played and drawn trimmed and levelled. Tick takes, or use one as a variant.
					</div>
				</div>
				<GenerateTakes
					defaults={groups[0] ? { prompt: groups[0].prompt, seconds: groups[0].seconds } : undefined}
					busy={busy}
					onGenerate={(p) => void run("Generating takes…", "generate_sound", { ...p, group: groups.find((g) => g.prompt === p.prompt)?.group })}
				/>
				{groups.map((g) => (
					<div key={`${g.seconds}|${g.prompt}`} className="col take-group">
						<div className="row">
							<div className="grow muted small">
								“{g.prompt}”{g.seconds ? ` · ${g.seconds} s` : ""} · {g.takes.length} take{g.takes.length > 1 ? "s" : ""}
							</div>
							{g.seconds > 0 && (
								<button className="small" disabled={!!busy} data-testid="more-takes" onClick={() => void run("Generating takes…", "generate_sound", { prompt: g.prompt, seconds: g.seconds, group: g.group, count: 6 })}>
									+ More takes
								</button>
							)}
						</div>
						<div className="takes-grid">
							{g.takes.map((t) => (
								<TakeTile
									key={t.id}
									take={t}
									url={file(`takes/${t.id}.wav`)}
									usedIn={usedIn(t.id)}
									selected={selected.includes(t.id)}
									busy={!!busy}
									player={player}
									onSelect={() => toggleSelect(t.id)}
									onUse={() => sound && setVariants([...sound.variants, { layers: [{ take: t.id }] }])}
								/>
							))}
						</div>
					</div>
				))}
				{selected.length > 0 && sound && <ComposeBar selected={selected} sound={sound} busy={!!busy} onCompose={(v) => (setVariants(v), setSelected([]))} onClear={() => setSelected([])} />}
			</div>

			{sound && (
				<div className="card col" data-testid="variants">
					<div className="row">
						<div className="grow col" style={{ gap: 2 }}>
							<h3>Variants</h3>
							<div className="muted small">The files the game plays: it picks one at random each time. Each mixes its own layers, then the processing below.</div>
						</div>
						{files.length > 0 && (
							<button className="primary" onClick={playInGame} data-testid="play-in-game" title="A random variant, pitch varied a little, as the game would play it">
								{player.current === "game" ? "■ Stop" : "▶ Play as in game"}
							</button>
						)}
					</div>
					{sound.variants.map((v, i) => (
						<VariantCard
							key={i}
							variant={v}
							sound={sound}
							url={files[i] ? file(files[i]) : undefined}
							fileName={variantFile(leafName(name), i)}
							records={records}
							selected={selected}
							busy={!!busy}
							player={player}
							onChange={(next) => setVariants(next ? sound.variants.map((x, j) => (j === i ? next : x)) : sound.variants.filter((_, j) => j !== i))}
						/>
					))}
				</div>
			)}
			{sound && files.length > 0 && (
				<LiveEffects files={files.map(file)} assetPath={asset.path} gamePath={`${dir.replace(/^assets\//, "")}/${files[0]}`} loop={!!sound.loop} />
			)}
			{sound && <Processing sound={sound} busy={!!busy} onApply={(set) => void run("Rendering…", "edit_sound", { set })} />}
			<div className="card col" data-testid="usages">
				<h3>Used in</h3>
				{usages?.length ? (
					usages.map((u, i) => (
						<button key={i} className="usage" onClick={() => showAsset({ path: u.path, checkout, line: u.line })}>
							<span className="muted">
								{u.path}:{u.line}
							</span>{" "}
							<code>{u.text}</code>
						</button>
					))
				) : (
					<div className="muted small">
						Not used in the game yet. Game code plays it with <code>{`engine.play_sound("sounds/${name}/${leafName(name)}.ogg")`}</code> (or a random variant).
					</div>
				)}
			</div>
		</div>
	);
}

function GenerateTakes({ defaults, busy, onGenerate }: { defaults?: { prompt: string; seconds: number }; busy: string | null; onGenerate(p: { prompt: string; seconds: number; count: number }): void }) {
	const [open, setOpen] = useState(false);
	const [prompt, setPrompt] = useState(defaults?.prompt ?? "");
	const [seconds, setSeconds] = useState(defaults?.seconds ?? 2);
	const [count, setCount] = useState(6);
	if (!open)
		return (
			<div className="row">
				<button className="small" onClick={() => setOpen(true)} data-testid="new-takes">
					+ New takes from a prompt…
				</button>
			</div>
		);
	return (
		<div className="col generate-takes">
			<textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="One sound, what makes it, how it's recorded: “a wooden door creaking open, close-up foley, dry”" />
			<div className="row">
				<label className="row small">
					Seconds <input type="number" min={0.1} max={11} step={0.1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
				</label>
				<label className="row small">
					Takes <input type="number" min={1} max={12} value={count} onChange={(e) => setCount(Number(e.target.value))} />
				</label>
				<span className="grow" />
				<button onClick={() => setOpen(false)}>Cancel</button>
				<button className="primary" disabled={!!busy || !prompt.trim()} onClick={() => (onGenerate({ prompt: prompt.trim(), seconds, count }), setOpen(false))}>
					{busy === "Generating takes…" ? busy : "Generate"}
				</button>
			</div>
		</div>
	);
}

function TakeTile(props: { take: Take; url: string; usedIn: number[]; selected: boolean; busy: boolean; player: Player; onSelect(): void; onUse(): void }) {
	const { take, url, usedIn, player } = props;
	return (
		<div className={`take ${props.selected ? "selected" : ""} ${usedIn.length ? "used" : ""}`} data-testid="take" data-take={take.id} data-used={usedIn.length > 0}>
			<div className="row">
				<input type="checkbox" checked={props.selected} onChange={props.onSelect} title="Select, to compose variants from several takes" data-testid="take-select" />
				<button className="icon" onClick={() => void player.toggle(url, { level: true })} title="Play (trimmed and levelled)">
					{player.current === url ? "■" : "▶"}
				</button>
				<span className="mono grow" title={take.id}>
					#{take.record?.seed ?? take.id}
				</span>
				{take.off && (
					<span className="badge warn" title="CLAP scored it far below the rest of its batch: probably not the sound asked for">
						off-prompt
					</span>
				)}
			</div>
			<Waveform url={url} level />
			<div className="row">
				<span className="muted small grow">
					{[take.record?.clap !== undefined && `CLAP ${take.record.clap.toFixed(2)}`, usedIn.length > 0 && `in variant ${usedIn.join(", ")}`].filter(Boolean).join(" · ")}
				</span>
				<button className="small" disabled={props.busy} onClick={props.onUse} data-testid="take-use" title="Add a variant made of just this take">
					+ Variant
				</button>
			</div>
		</div>
	);
}

/** With takes ticked: make X variants mixing Y of them each (spread evenly), replacing or adding to the variants. */
function ComposeBar({ selected, sound, busy, onCompose, onClear }: { selected: string[]; sound: Sound; busy: boolean; onCompose(v: Variant[]): void; onClear(): void }) {
	// The count follows the selection (one variant per take) until it's typed.
	const [typed, setCount] = useState<number | null>(null);
	const count = typed ?? selected.length;
	const [layers, setLayers] = useState(1);
	const made = composeVariants(selected, count, layers);
	return (
		<div className="row compose-bar" data-testid="compose-bar">
			<span>{selected.length} selected · make</span>
			<input type="number" min={1} max={16} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value)))} data-testid="compose-count" />
			<span>variant{count > 1 ? "s" : ""} using</span>
			<input type="number" min={1} max={selected.length} value={layers} onChange={(e) => setLayers(Math.max(1, Number(e.target.value)))} data-testid="compose-layers" />
			<span>take{layers > 1 ? "s" : ""} each</span>
			<span className="grow" />
			<button className="small" onClick={onClear}>
				Clear
			</button>
			<button disabled={busy} onClick={() => onCompose([...sound.variants, ...made])}>
				Add
			</button>
			<button className="primary" disabled={busy} onClick={() => onCompose(made)} data-testid="compose-replace">
				Replace variants
			</button>
		</div>
	);
}

function layerLabel(l: Layer, records: Record<string, TakeRecord>): string {
	if ("take" in l) {
		const r = records[`${l.take}.wav`];
		return r ? `take #${r.seed} · “${r.prompt.length > 48 ? `${r.prompt.slice(0, 47)}…` : r.prompt}”` : `take ${l.take}`;
	}
	const s = l.synth;
	return `synth ${s.wave}${s.freq ? ` ${s.freq}${s.to ? `→${s.to}` : ""} Hz` : ""} · ${s.seconds} s`;
}

function VariantCard(props: {
	variant: Variant;
	sound: Sound;
	url?: string;
	fileName: string;
	records: Record<string, TakeRecord>;
	selected: string[];
	busy: boolean;
	player: Player;
	onChange(next: Variant | null): void;
}) {
	const { variant: v, url, player, busy } = props;
	const [seconds, setSeconds] = useState<number>();
	const onDecoded = useMemo(() => (d: Decoded) => setSeconds(d.buffer.duration), []);
	const layers = (layers: Layer[]) => props.onChange({ ...v, layers });
	const override = (k: "length" | "pitch", raw: string) => {
		const { [k]: _, ...rest } = v;
		props.onChange(raw.trim() === "" ? (rest as Variant) : { ...v, [k]: Number(raw) });
	};
	return (
		<div className="variant col" data-testid="variant-row">
			<div className="row audio-row">
				<button className="icon" disabled={!url} onClick={() => url && void player.toggle(url, { loop: props.sound.loop })} title={props.sound.loop ? "Play (loops)" : "Play"}>
					{url && player.current === url ? "■" : "▶"}
				</button>
				<span className="mono audio-label">{props.fileName}</span>
				{url ? <Waveform url={url} onDecoded={onDecoded} /> : <span className="grow muted small">Not rendered yet</span>}
				<span className="muted mono">{seconds !== undefined ? `${seconds.toFixed(2)} s` : ""}</span>
				<button className="icon" disabled={busy || props.sound.variants.length === 1} onClick={() => props.onChange(null)} title="Remove this variant">
					✕
				</button>
			</div>
			<div className="variant-layers">
				{v.layers.map((l, li) => (
					<div key={li} className="row layer-row small" data-testid="variant-layer">
						<span className="grow ellipsis">{layerLabel(l, props.records)}</span>
						<label className="row">
							<input
								type="number"
								step={1}
								defaultValue={l.gain ?? 0}
								title="Gain against the other layers (each levelled first)"
								onBlur={(e) => Number(e.target.value) !== (l.gain ?? 0) && layers(v.layers.map((x, j) => (j === li ? { ...x, gain: Number(e.target.value) || undefined } : x)))}
							/>
							dB
						</label>
						<button className="icon" disabled={busy || v.layers.length === 1} onClick={() => layers(v.layers.filter((_, j) => j !== li))} title="Remove this layer">
							✕
						</button>
					</div>
				))}
				<div className="row small">
					{props.selected.length > 0 && (
						<button className="small" disabled={busy} onClick={() => layers([...v.layers, ...props.selected.map((take) => ({ take }))])} data-testid="add-layers">
							+ Layer the {props.selected.length} selected take{props.selected.length > 1 ? "s" : ""}
						</button>
					)}
					<span className="grow" />
					<label className="row muted" title="This variant's own length (seconds), instead of the shared one">
						Length
						<input type="number" step={0.05} placeholder={props.sound.length?.toString() ?? "all"} defaultValue={v.length ?? ""} onBlur={(e) => e.target.value !== (v.length?.toString() ?? "") && override("length", e.target.value)} />
					</label>
					<label className="row muted" title="This variant's own pitch (semitones), instead of the shared one">
						Pitch
						<input type="number" step={0.5} placeholder={props.sound.pitch?.toString() ?? "0"} defaultValue={v.pitch ?? ""} onBlur={(e) => e.target.value !== (v.pitch?.toString() ?? "") && override("pitch", e.target.value)} />
					</label>
				</div>
			</div>
		</div>
	);
}

type Field = "length" | "pitch" | "highpass" | "lowpass" | "reverb" | "peak" | "fadeOut";
const FIELDS: { key: Field; label: string; unit: string; step: number; placeholder: string }[] = [
	{ key: "length", label: "Length", unit: "s", step: 0.05, placeholder: "all" },
	{ key: "pitch", label: "Pitch", unit: "semitones", step: 0.5, placeholder: "0" },
	{ key: "highpass", label: "High-pass", unit: "Hz", step: 10, placeholder: "off" },
	{ key: "lowpass", label: "Low-pass", unit: "Hz", step: 100, placeholder: "off" },
	{ key: "reverb", label: "Reverb", unit: "0-1", step: 0.05, placeholder: "0" },
	{ key: "peak", label: "Peak", unit: "dBFS", step: 0.5, placeholder: "-1" },
	{ key: "fadeOut", label: "Fade out", unit: "s", step: 0.01, placeholder: "0.05" },
];

/** Processing shared by every variant, and looping; applying writes sound.json and re-renders. Empty means the default. */
function Processing({ sound, busy, onApply }: { sound: Sound; busy: boolean; onApply(set: Record<string, unknown>): void }) {
	const current = (k: Field) => (k === "fadeOut" ? sound.fade?.out : sound[k]);
	const [values, setValues] = useState<Record<Field, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, current(f.key)?.toString() ?? ""])) as Record<Field, string>);
	const [loop, setLoop] = useState(!!sound.loop);
	const changed = FIELDS.filter((f) => values[f.key] !== (current(f.key)?.toString() ?? ""));
	const summary = FIELDS.filter((f) => current(f.key) !== undefined).map((f) => `${f.label.toLowerCase()} ${current(f.key)} ${f.unit}`);
	const apply = () => {
		const set: Record<string, unknown> = {};
		for (const f of changed) {
			const v = values[f.key].trim() === "" ? null : Number(values[f.key]);
			if (f.key === "fadeOut") set.fade = v === null ? (sound.fade?.in !== undefined ? { in: sound.fade.in } : null) : { ...sound.fade, out: v };
			else set[f.key] = v;
		}
		if (loop !== !!sound.loop) set.loop = loop || null;
		onApply(set);
	};
	return (
		<details className="card simple-edits" data-testid="sound-quick-changes">
			<summary>
				Processing <span className="muted small">· every variant{summary.length ? `: ${summary.join(", ")}` : ": defaults"}</span>
			</summary>
			<div className="quick-grid">
				{FIELDS.map((f) => (
					<label key={f.key} className="row">
						<span className="quick-label">{f.label}</span>
						<input type="number" step={f.step} placeholder={f.placeholder} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} data-field={f.key} />
						<span className="muted small">{f.unit}</span>
					</label>
				))}
				<label className="row">
					<input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Seamless loop
				</label>
			</div>
			<div className="row">
				<button className="primary" disabled={busy || (!changed.length && loop === !!sound.loop)} onClick={apply}>
					Apply
				</button>
			</div>
		</details>
	);
}
