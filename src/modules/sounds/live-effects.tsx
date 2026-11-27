// "Try live effects": the sound played through the engine's per-sound effects (pitch, filters, the comb's hollow ring)
// as the game can change them while it runs, between two ends (at 0 and at 1 of something in the game: heat, speed),
// with a slider for that value and the Odin that does the same. Plays through an AudioWorklet running the engine's
// effects, ported (src/shared/sound-fx.ts), so it sounds as the game will. Kept per sound in localStorage.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SoundEffects } from "../../shared/sound-fx";
import { ac, decode, takeOverPlayback } from "./audio";
import workletUrl from "./fx-worklet.ts?worker&url";
import { emptyEnds, LIVE_FIELDS, LIVE_PRESETS, type LiveEnds, type LiveField, liveAt, liveCode } from "./live";

const LABELS: Record<LiveField, [string, string]> = {
	pitch: ["Pitch", "Playback speed: 2 is an octave up and twice as fast. Blank: 1"],
	lowpass: ["Low-pass (Hz)", "Cut above this: muffled, behind a wall, underwater"],
	highpass: ["High-pass (Hz)", "Cut below this: thin, a small speaker"],
	bandpass: ["Band-pass (Hz)", "Keep only around this: radio, boxy"],
	resonance: ["Resonance", "The filters' peak at their frequency, 0.1 to 20. Blank: none"],
	comb_ms: ["Ring delay (ms)", "The hollow ring's note: 1000 / this Hz, and its multiples. 0.5 to 20"],
	comb_feedback: ["Ring feedback", "How long and strong it rings, -0.95 to 0.95 (negative: hollower)"],
	comb_mix: ["Ring mix", "How much of the ring is heard, 0 to 1"],
};

let workletLoaded: Promise<void> | undefined;
const loadWorklet = () => (workletLoaded ??= ac().audioWorklet.addModule(workletUrl));

interface Saved {
	ends: LiveEnds;
	variable: string;
	amount: number;
}

function load(key: string): Saved {
	try {
		const s = JSON.parse(localStorage.getItem(key) ?? "null") as Saved | null;
		if (s?.ends) return { ...s, ends: { ...emptyEnds(), ...s.ends } };
	} catch {
		// nothing kept, or storage unavailable
	}
	return { ends: emptyEnds(), variable: "heat", amount: 0.5 };
}

/** One shot (or the loop) playing through its own effects node. */
interface Shot {
	src: AudioBufferSourceNode;
	node: AudioWorkletNode;
}

export function LiveEffects({ files, assetPath, gamePath, loop }: { files: string[]; assetPath: string; gamePath: string; loop: boolean }) {
	const key = `live-fx:${assetPath}`;
	const [saved, setSaved] = useState<Saved>(() => load(key));
	const { ends, variable, amount } = saved;
	const [playing, setPlaying] = useState(false);
	/** Heard: the worklet loaded and the first shot started ("playing" alone is only the button pressed). */
	const [heard, setHeard] = useState(false);
	const [repeat, setRepeat] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const shots = useRef(new Set<Shot>());
	const stopRef = useRef<() => void>(() => {});
	const now = useMemo(() => liveAt(ends, amount), [ends, amount]);
	const nowRef = useRef(now);
	nowRef.current = now;
	const repeatRef = useRef(repeat);
	repeatRef.current = repeat;
	const code = useMemo(() => liveCode(ends, gamePath, variable, loop), [ends, gamePath, variable, loop]);

	const update = (next: Partial<Saved>) =>
		setSaved((s) => {
			const merged = { ...s, ...next };
			try {
				localStorage.setItem(key, JSON.stringify(merged));
			} catch {
				// not kept: fine
			}
			return merged;
		});

	// While playing, changes are heard at once: pitch now, effects gliding (as set_voice_pitch / set_voice_effects).
	useEffect(() => {
		for (const s of shots.current) {
			s.src.playbackRate.value = now.pitch;
			s.node.port.postMessage(now.effects);
		}
	}, [now]);
	useEffect(() => () => stopRef.current(), []);

	const shoot = async (alive: () => boolean) => {
		const url = files[Math.floor(Math.random() * files.length)];
		const d = await decode(url);
		if (!alive()) return;
		const ctx = ac();
		const { pitch, effects } = nowRef.current;
		const src = ctx.createBufferSource();
		src.buffer = d.buffer;
		src.loop = loop;
		src.playbackRate.value = pitch;
		// A sound starts with its effects already on, as play_sound's do.
		const node = new AudioWorkletNode(ctx, "sound-fx", { outputChannelCount: [2], processorOptions: { effects: effects satisfies SoundEffects } });
		src.connect(node).connect(ctx.destination);
		const shot = { src, node };
		shots.current.add(shot);
		src.onended = () => {
			shots.current.delete(shot);
			// Keep the ring's tail: let the node run a moment before it goes.
			setTimeout(() => node.disconnect(), 500);
			if (alive() && !loop && repeatRef.current) setTimeout(() => alive() && void shoot(alive), 250);
			else if (alive() && shots.current.size === 0) stopRef.current();
		};
		src.start();
	};

	const play = async () => {
		if (playing) return stopRef.current();
		setError(null);
		let live = true;
		const stop = () => {
			live = false;
			for (const s of shots.current) {
				s.src.onended = null;
				s.src.stop();
				s.node.disconnect();
			}
			shots.current.clear();
			setPlaying(false);
			setHeard(false);
		};
		stopRef.current = stop;
		takeOverPlayback(stop);
		setPlaying(true);
		try {
			await ac().resume();
			await loadWorklet();
			await shoot(() => live);
			if (live) setHeard(true);
		} catch (err) {
			stop();
			setError(`Can't play it here: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const setEnd = (f: LiveField, i: 0 | 1, value: string) => update({ ends: { ...ends, [f]: (i === 0 ? [value, ends[f][1]] : [ends[f][0], value]) as [string, string] } });
	const applyPreset = (p: (typeof LIVE_PRESETS)[number]) => {
		const next = emptyEnds();
		for (const f of LIVE_FIELDS) next[f] = [p.at0?.[f] ?? "", p.at1[f] ?? ""];
		update({ ends: next });
	};
	const copy = () => {
		void navigator.clipboard.writeText(code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	const shown = (f: LiveField) => {
		const v = f === "pitch" ? now.pitch : (now.effects[f] ?? 0);
		return f === "pitch" || v ? String(Number(v.toFixed(f === "lowpass" || f === "highpass" || f === "bandpass" ? 0 : 2))) : "off";
	};

	return (
		<details className="card live-effects" data-testid="live-effects">
			<summary>
				<h3>Try live effects</h3>
				<span className="muted small">Pitch, filters and a hollow ring the game can change while it plays (heat, speed, health)</span>
			</summary>
			<div className="col">
				<div className="muted small">
					Set each at 0 and at 1 of a value in the game, then move the slider while it plays. Blank is off; a filter that should fade in needs both ends (20000 → 800 for a low-pass).
					Heard here exactly as the engine will do it.
				</div>
				<div className="row live-presets">
					<span className="muted small">Start from:</span>
					{LIVE_PRESETS.map((p) => (
						<button key={p.label} className="small" title={p.title} onClick={() => applyPreset(p)}>
							{p.label}
						</button>
					))}
					<button className="small ghost" onClick={() => update({ ends: emptyEnds() })}>
						Clear
					</button>
				</div>
				<div className="row live-play">
					<button className="primary" onClick={() => void play()} data-testid="live-play" data-state={heard ? "playing" : playing ? "starting" : "stopped"}>
						{playing ? "■ Stop" : "▶ Play"}
					</button>
					{!loop && (
						<label className="row small">
							<input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat
						</label>
					)}
					<input className="live-variable" value={variable} onChange={(e) => update({ variable: e.target.value })} title="The value's name in the game code" aria-label="Value name" />
					<input
						type="range"
						className="grow"
						min={0}
						max={1}
						step={0.01}
						value={amount}
						onChange={(e) => update({ amount: Number(e.target.value) })}
						data-testid="live-amount"
						aria-label={variable}
					/>
					<span className="mono live-amount">{amount.toFixed(2)}</span>
				</div>
				{error && <div className="msg error">{error}</div>}
				<table className="live-table">
					<thead>
						<tr>
							<th />
							<th>At 0</th>
							<th>At 1</th>
							<th>Now</th>
						</tr>
					</thead>
					<tbody>
						{LIVE_FIELDS.map((f) => (
							<tr key={f} title={LABELS[f][1]}>
								<td>{LABELS[f][0]}</td>
								<td>
									<input value={ends[f][0]} onChange={(e) => setEnd(f, 0, e.target.value)} placeholder={f === "pitch" ? "1" : "off"} data-testid={`live-${f}-0`} />
								</td>
								<td>
									<input value={ends[f][1]} onChange={(e) => setEnd(f, 1, e.target.value)} placeholder={f === "pitch" ? "1" : "off"} data-testid={`live-${f}-1`} />
								</td>
								<td className="mono muted">{shown(f)}</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className="row">
					<span className="grow muted small">In the game:</span>
					<button className="small" onClick={copy} data-testid="live-copy">
						{copied ? "Copied" : "Copy as code"}
					</button>
				</div>
				<pre className="live-code" data-testid="live-code">
					{code}
				</pre>
			</div>
		</details>
	);
}
