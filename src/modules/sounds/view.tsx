// Sound Effects: browse sounds (main checkout + drafts), play every variant (and as the game would: a random
// variant, pitch jittered a little), audition and pick generated takes, make quick processing changes, and see
// where the game uses each sound. sound.json is the asset; edits and renders run in a session's worktree (the
// draft's session, or a Sound Designer workspace created without running the agent).
import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioRequestMethod } from "../../shared/host";
import type { ModuleInfo } from "../../shared/modules";
import { type Layer, layerName, parseSound, type Sound } from "../../shared/sound";
import { call, sha1, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { workspaceFor } from "../../renderer/workspace";
import { soundName } from "./info";

const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));
/** A take whose CLAP score is this far below its batch's median is flagged (as the pipeline does for agents). */
const OFF_PROMPT = 0.15;

interface TakeRecord {
	layer: string;
	prompt: string;
	seconds: number;
	seed: number;
	model: string;
	clap?: number;
	at: string;
}

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
			modifyPlaceholder="What should change? The Sound Designer edits sound.json: new takes or prompts, layers, processing, variants."
			emptyText="No sound effects yet. Start one with “New sound”: the Sound Designer generates takes and renders them."
			content={(props) => <SoundDetail key={`${props.asset.path}:${props.sessionId ?? ""}`} {...props} />}
		/>
	);
}

// --- Playback and waveforms ---------------------------------------------------------------------------------

/** One sound plays at a time across the section. */
let playingAudio: HTMLAudioElement | null = null;

function usePlayer() {
	const [playing, setPlaying] = useState<string | null>(null);
	useEffect(() => () => playingAudio?.pause(), []);
	const toggle = (url: string, opts: { rate?: number; loop?: boolean; id?: string } = {}) => {
		const id = opts.id ?? url;
		playingAudio?.pause();
		if (playing === id) {
			setPlaying(null);
			return;
		}
		const a = new Audio(url);
		a.preservesPitch = false; // a tape-style pitch change, as the engine's pitch does
		a.playbackRate = opts.rate ?? 1;
		a.loop = !!opts.loop;
		a.onended = () => setPlaying((p) => (p === id ? null : p));
		playingAudio = a;
		setPlaying(id);
		void a.play().catch(() => setPlaying(null));
	};
	return { playing, toggle };
}

interface Decoded {
	seconds: number;
	peakDb: number;
	/** Min and max of each of 240 columns, interleaved. */
	columns: Float32Array;
}

const decoded = new Map<string, Promise<Decoded>>();
let audioContext: AudioContext | undefined;

function decode(url: string): Promise<Decoded> {
	let p = decoded.get(url);
	if (!p) {
		p = fetch(url)
			.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
			.then((b) => (audioContext ??= new AudioContext()).decodeAudioData(b))
			.then((buf) => {
				const cols = 240;
				const columns = new Float32Array(cols * 2);
				const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
				const per = Math.max(1, Math.floor(buf.length / cols));
				let peak = 0;
				for (let c = 0; c < cols; c++) {
					let lo = 0;
					let hi = 0;
					for (let i = c * per; i < Math.min(buf.length, (c + 1) * per); i++) {
						for (const ch of chans) {
							lo = Math.min(lo, ch[i]);
							hi = Math.max(hi, ch[i]);
						}
					}
					columns[c * 2] = lo;
					columns[c * 2 + 1] = hi;
					peak = Math.max(peak, -lo, hi);
				}
				return { seconds: buf.duration, peakDb: 20 * Math.log10(Math.max(peak, 1e-9)), columns };
			});
		decoded.set(url, p);
		p.catch(() => decoded.delete(url));
	}
	return p;
}

function Waveform({ url, onDecoded }: { url: string; onDecoded?(d: Decoded): void }) {
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
				const cols = d.columns.length / 2;
				// sqrt scale, so quiet detail shows (the agents' images use the same)
				const y = (v: number) => height / 2 - Math.sign(v) * Math.sqrt(Math.abs(v)) * (height / 2);
				for (let i = 0; i < cols; i++) {
					const top = y(d.columns[i * 2 + 1]);
					g.fillRect((i / cols) * width, top, Math.max(1, width / cols - 0.5), Math.max(1, y(d.columns[i * 2]) - top));
				}
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [url, onDecoded]);
	return <canvas ref={canvas} className="waveform" width={480} height={56} />;
}

// --- The detail view ----------------------------------------------------------------------------------------

type RenderState = { kind: "loading" } | { kind: "none" } | { kind: "stale"; files: string[] } | { kind: "current"; files: string[] };

function SoundDetail({ asset, text, sessionId }: AssetContentProps) {
	const { showAsset, showError } = useStudio();
	const name = soundName(asset.path);
	const dir = `assets/sounds/${name}`;
	const { sound, problems } = useMemo(() => parseSound(text), [text]);
	const [render, setRender] = useState<RenderState>({ kind: "loading" });
	const [records, setRecords] = useState<Record<string, TakeRecord>>({});
	const [usages, setUsages] = useState<{ path: string; line: number; text: string }[] | null>(null);
	const [version, setVersion] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const player = usePlayer();
	const file = (path: string) => studioFile(sessionId, `${dir}/${path}`, `${version}`);

	useEffect(() => {
		let live = true;
		(async () => {
			const r = await fetch(studioFile(sessionId, `${dir}/render.json`, `${Date.now()}`)).catch(() => null);
			const t = await fetch(studioFile(sessionId, `${dir}/takes/takes.json`, `${Date.now()}`)).catch(() => null);
			if (!live) return;
			setRecords(t?.ok ? await t.json() : {});
			if (!r?.ok) return setRender({ kind: "none" });
			const info = (await r.json()) as { sound: string; files: string[] };
			setRender({ kind: info.sound === (await sha1(text)) ? "current" : "stale", files: info.files });
		})();
		call("sounds.usages", sessionId ?? null, name).then((u) => live && setUsages(u), showError);
		return () => {
			live = false;
		};
	}, [dir, name, sessionId, text, version, showError]);

	/** Runs a step in this draft's session, or the sound's open workspace, or a new one. */
	const run = async (label: string, method: StudioRequestMethod, params: Record<string, unknown>) => {
		setBusy(label);
		try {
			const target = await workspaceFor(asset, sessionId, "sound-designer", `Sound: ${name}`);
			await call("workspace.run", target.id, method, { name, ...params });
			if (target.id !== sessionId) showAsset({ path: asset.path, sessionId: target.id });
			bumpAssets();
			setVersion((v) => v + 1);
		} catch (err) {
			showError(err);
		} finally {
			setBusy(null);
		}
	};

	const files = render.kind === "current" || render.kind === "stale" ? render.files : [];
	const playInGame = () => {
		const f = files[Math.floor(Math.random() * files.length)];
		player.toggle(file(f), { rate: sound?.loop ? 1 : 0.96 + Math.random() * 0.08, loop: sound?.loop, id: "game" });
	};
	return (
		<div className="sound-detail" data-testid="sound-detail">
			<div className="row sound-head">
				<div className="grow col">
					<div className="muted">
						{[sound && (sound.loop ? "loop" : "one-shot"), files.length > 1 && `${files.length} variants`, sound && `${sound.layers.length} layer${sound.layers.length > 1 ? "s" : ""}`]
							.filter(Boolean)
							.join(" · ")}
					</div>
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
			{files.length > 0 && (
				<div className="card col" data-testid="variants">
					<div className="row">
						<h3 className="grow">{files.length > 1 ? "Variants" : "Sound"}</h3>
						<button className="primary" onClick={playInGame} data-testid="play-in-game" title="A random variant, pitch varied a little, as the game would play it">
							{player.playing === "game" ? "■ Stop" : "▶ Play as in game"}
						</button>
					</div>
					{files.map((f) => (
						<AudioRow key={f} label={f} url={file(f)} loop={!!sound?.loop} player={player} />
					))}
				</div>
			)}
			{sound?.layers.map((l, i) =>
				l.generate ? (
					<TakesBoard
						key={i}
						layer={l}
						name={layerName(l, i)}
						records={records}
						file={file}
						player={player}
						busy={busy}
						onTakes={(takes) => void run("Rendering…", "edit_sound", { layer: layerName(l, i), takes })}
						onMore={() => void run("Generating takes…", "generate_sound", { prompt: l.generate!.prompt, seconds: l.generate!.seconds, layer: layerName(l, i), count: 6 })}
					/>
				) : null,
			)}
			{sound && sound.layers.some((l) => l.synth) && <SynthLayers sound={sound} />}
			{sound && <QuickChanges sound={sound} busy={!!busy} onApply={(set) => void run("Rendering…", "edit_sound", { set })} />}
			<div className="card col" data-testid="usages">
				<h3>Used in</h3>
				{usages?.length ? (
					usages.map((u, i) => (
						<button key={i} className="usage" onClick={() => showAsset({ path: u.path, sessionId, line: u.line })}>
							<span className="muted">
								{u.path}:{u.line}
							</span>{" "}
							<code>{u.text}</code>
						</button>
					))
				) : (
					<div className="muted small">
						Not used in the game yet. Game code plays it with <code>{`engine.play_sound("sounds/${name}/${name}.ogg")`}</code>.
					</div>
				)}
			</div>
		</div>
	);
}

function AudioRow({ label, url, loop, player }: { label: string; url: string; loop: boolean; player: ReturnType<typeof usePlayer> }) {
	const [info, setInfo] = useState<Decoded>();
	return (
		<div className="row audio-row" data-testid="variant-row">
			<button className="icon" onClick={() => player.toggle(url, { loop })} title={loop ? "Play (loops)" : "Play"}>
				{player.playing === url ? "■" : "▶"}
			</button>
			<span className="mono audio-label">{label}</span>
			<Waveform url={url} onDecoded={setInfo} />
			<span className="muted mono">{info ? `${info.seconds.toFixed(2)} s` : ""}</span>
		</div>
	);
}

/** A generated layer's takes, newest first: play, compare and pick which ones the sound uses (one per variant). */
function TakesBoard(props: {
	layer: Layer;
	name: string;
	records: Record<string, TakeRecord>;
	file(path: string): string;
	player: ReturnType<typeof usePlayer>;
	busy: string | null;
	onTakes(takes: number[]): void;
	onMore(): void;
}) {
	const { layer, name, records, player, busy } = props;
	const used = layer.takes ?? [];
	const takes = useMemo(() => {
		const recs = Object.values(records).filter((r) => r.layer === name);
		// Off-prompt within each batch (one generation request): CLAP far below the batch's median.
		const batches = new Map<string, TakeRecord[]>();
		for (const r of recs) batches.set(r.at, [...(batches.get(r.at) ?? []), r]);
		const off = new Set<number>();
		for (const b of batches.values()) {
			const scores = b.map((r) => r.clap).filter((c): c is number => c !== undefined).sort((x, y) => x - y);
			if (scores.length > 2) for (const r of b) if (r.clap !== undefined && r.clap < scores[Math.floor(scores.length / 2)] - OFF_PROMPT) off.add(r.seed);
		}
		const list = recs.sort((a, b) => b.at.localeCompare(a.at) || a.seed - b.seed).map((r) => ({ seed: r.seed, record: r as TakeRecord | undefined, off: off.has(r.seed) }));
		// Takes named in sound.json without a record (written by hand) still show.
		for (const seed of used) if (!list.some((t) => t.seed === seed)) list.unshift({ seed, record: undefined, off: false });
		return list;
	}, [records, name, used]);
	const toggle = (seed: number) => props.onTakes(used.includes(seed) ? used.filter((s) => s !== seed) : [...used, seed]);
	return (
		<div className="card col" data-testid="takes">
			<div className="row">
				<div className="grow col">
					<h3>Takes{name !== "main" ? ` · ${name}` : ""}</h3>
					<div className="muted small">
						“{layer.generate!.prompt}” · {layer.generate!.seconds} s · {used.length} in use (one per variant, in order)
					</div>
				</div>
				<button disabled={!!busy} onClick={props.onMore} data-testid="more-takes">
					{busy === "Generating takes…" ? busy : "+ More takes"}
				</button>
			</div>
			<div className="takes-grid">
				{takes.map(({ seed, record, off }) => {
					const url = props.file(`takes/${name}-${seed}.wav`);
					const index = used.indexOf(seed);
					return (
						<div key={seed} className={`take ${index >= 0 ? "used" : ""}`} data-testid="take" data-seed={seed} data-used={index >= 0}>
							<div className="row">
								<button className="icon" onClick={() => player.toggle(url)}>
									{player.playing === url ? "■" : "▶"}
								</button>
								<span className="mono grow">#{seed}</span>
								{index >= 0 && <span className="badge">variant {index + 1}</span>}
								{off && (
									<span className="badge warn" title="CLAP scored it far below the rest of its batch: probably not the sound asked for">
										off-prompt
									</span>
								)}
							</div>
							<Waveform url={url} />
							<div className="row">
								<span className="muted small grow">{record?.clap !== undefined ? `CLAP ${record.clap.toFixed(2)}` : ""}</span>
								<button
									className="small"
									disabled={!!busy || (index >= 0 && used.length === 1)}
									onClick={() => toggle(seed)}
									data-testid="take-toggle"
								>
									{index >= 0 ? "Remove" : "Use"}
								</button>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function SynthLayers({ sound }: { sound: Sound }) {
	return (
		<div className="card col">
			<h3>Synth layers</h3>
			{sound.layers.map((l, i) =>
				l.synth ? (
					<div key={i} className="mono small">
						{layerName(l, i)}: {l.synth.wave}
						{l.synth.freq ? ` ${l.synth.freq}${l.synth.to ? `→${l.synth.to}` : ""} Hz` : ""}, {l.synth.seconds} s{l.gain ? `, ${l.gain} dB` : ""}
						{l.at ? `, at ${l.at} s` : ""}
					</div>
				) : null,
			)}
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

/** Processing fields and looping; applying writes sound.json and re-renders. Empty means the default. */
function QuickChanges({ sound, busy, onApply }: { sound: Sound; busy: boolean; onApply(set: Record<string, unknown>): void }) {
	const current = (k: Field) => (k === "fadeOut" ? sound.fade?.out : sound[k]);
	const [values, setValues] = useState<Record<Field, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, current(f.key)?.toString() ?? ""])) as Record<Field, string>);
	const [loop, setLoop] = useState(!!sound.loop);
	const changed = FIELDS.filter((f) => values[f.key] !== (current(f.key)?.toString() ?? ""));
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
			<summary>Quick changes</summary>
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
