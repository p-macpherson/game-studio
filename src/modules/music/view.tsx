// Music: browse pieces (main checkout + drafts), listen as the game will (looping), see the arrangement and the
// notes, and make simple edits. The score (song.json) is the asset; edits and renders run in a session's
// worktree (the draft's session, or a Music Composer workspace created without running the agent).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StudioRequestMethod } from "../../shared/host";
import type { ModuleInfo } from "../../shared/modules";
import { drumName, GM_PROGRAMS, gmProgram, parseSong, pitchName, type Song, type Space, SPACES, type Timeline, type TimelineTrack } from "../../shared/song";
import { findAgentType } from "../../shared/agents";
import { call, sha1, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { editCheckout, runInWorktree } from "../../renderer/workspace";
import { leafName } from "../../shared/asset-names";
import { addPartBrief, formatTime, GM_FAMILIES, pieceName, recomposeBrief, trackIdFor } from "./info";
import { useShallow } from "zustand/react/shallow";

const COLOURS = ["#e8a33d", "#5aa9e6", "#7bc47f", "#d8737f", "#b48ee8", "#4fc1b4", "#e6d45a", "#e58f5a"];
const bumpAssets = () => useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }));

export function MusicView({ module }: { module: ModuleInfo }) {
	return (
		<AssetBrowser
			module={module}
			newLabel="+ New piece"
			newPreset={{
				agentType: "music-composer",
				placeholder: "Describe the piece: what it plays under (exploring, combat, a menu, a victory jingle), the mood, tempo, instruments and length.",
			}}
			modifyLabel="Ask the composer"
			modifyPlaceholder="What should change? The Music Composer edits the score: sections, melody, harmony, instruments, tempo, length."
			emptyText="No music yet. Start a piece with “New piece”: the Music Composer writes a score and renders it."
			content={(props) => <PieceDetail key={`${props.asset.path}:${props.checkout ?? ""}`} {...props} />}
		/>
	);
}

type RenderState = { kind: "loading" } | { kind: "none" } | { kind: "stale" } | { kind: "current"; seconds: number };

/** The piece a theme sketch (`<name>-sketch-N`) is for, or null. */
const sketchOf = (name: string) => /^(.+)-sketch-\d+$/.exec(name)?.[1] ?? null;

function PieceDetail({ asset, text, checkout }: AssetContentProps) {
	const { showAsset, showError, openNewSession } = useStudio(
		useShallow((s) => ({
			showAsset: s.showAsset,
			showError: s.showError,
			openNewSession: s.openNewSession,
		})),
	);
	const name = pieceName(asset.path);
	const dir = `assets/music/${name}`;
	const parsed = useMemo(() => {
		try {
			return parseSong(JSON.parse(text));
		} catch (err) {
			return text
				? {
						song: null,
						timeline: null,
						errors: [{ at: "", message: `Not valid JSON: ${(err as Error).message}` }],
					}
				: null;
		}
	}, [text]);
	const song = parsed?.song ?? null;
	const timeline = parsed?.timeline ?? null;
	const [render, setRender] = useState<RenderState>({ kind: "loading" });
	const [version, setVersion] = useState(0);
	const [busy, setBusy] = useState(false);
	const [section, setSection] = useState(0);
	// The track (and bars) picked in the arrangement, for "Recompose".
	const [selection, setSelection] = useState<Selection | null>(null);
	const [adding, setAdding] = useState(false);
	// Muted tracks, and the stems that play while any are (loaded the first time something is muted).
	const [muted, setMuted] = useState<Set<string>>(new Set());
	const [stems, setStems] = useState<StemEngine | null>(null);
	const [stemsLoading, setStemsLoading] = useState(false);
	useEffect(() => {
		if (muted.size === 0 || stems || !parsed?.timeline) return;
		let live = true;
		setStemsLoading(true);
		call("music.stems", checkout ?? null, name)
			.then((list) => StemEngine.load(list, parsed.song?.loop !== false))
			.then((engine) => (live ? setStems(engine) : engine.dispose()), (err) => live && (showError(err), setMuted(new Set())))
			.finally(() => live && setStemsLoading(false));
		return () => {
			live = false;
		};
	}, [muted.size > 0, stems, text, checkout, name]);
	// A new score (or checkout) makes the stems stale: drop them; they're made again if something is still muted.
	useEffect(() => () => stems?.dispose(), [stems]);
	useEffect(() => setStems(null), [text, checkout]);
	const sessions = useStudio((s) => s.sessions);
	const working = useMemo(() => sessions.filter((x) => x.linkedAsset === asset.path && (x.status === "in_progress" || x.status === "starting")), [sessions, asset.path]);

	useEffect(() => {
		let live = true;
		(async () => {
			const r = await fetch(studioFile(checkout, `${dir}/render.json`, `${Date.now()}`)).catch(() => null);
			if (!live) return;
			if (!r?.ok) return setRender({ kind: "none" });
			const info = (await r.json()) as { song: string; seconds: number };
			setRender(info.song === (await sha1(text)) ? { kind: "current", seconds: info.seconds } : { kind: "stale" });
		})();
		return () => {
			live = false;
		};
	}, [dir, checkout, text, version]);

	/** Runs a step in this draft's session, or the piece's open workspace, or a new one. */
	const run = async (method: StudioRequestMethod, params: Record<string, unknown>) => {
		setBusy(true);
		try {
			await runInWorktree(`Music: ${name}`, method, { name, ...params });
			bumpAssets();
			setVersion((v) => v + 1);
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	/** Hands a brief to the Music Composer, working in this piece's worktree (a new one from main). */
	const compose = async (title: string, prompt: string) => {
		setBusy(true);
		try {
			const { agentTypes, models } = useStudio.getState();
			const preferred = findAgentType(agentTypes, "music-composer")?.defaultModel;
			const model = models.find((m) => m.ref === preferred)?.ref ?? models[0]?.ref;
			if (!model) throw new Error("No models available: sign in to an AI account first (Settings → Accounts)");
			const worktreeId = await editCheckout(`Music: ${name}`);
			await call("sessions.create", { agentType: "music-composer", target: "project", model, prompt, title, linkedAsset: asset.path, worktreeId });
			await useStudio.getState().refreshSessions();
			useStudio.getState().notify(`The composer is on it: ${title}`);
			setSelection(null);
			setAdding(false);
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	if (!parsed) return <div className="muted pad">Loading…</div>;
	return (
		<div className="music-detail" data-testid="music-detail">
			<div className="music-head row">
				<div className="grow col">
					<div className="music-facts muted">
						{[
							song?.key,
							song?.tempo && `${song.tempo} bpm`,
							song?.meter ? song.meter.join("/") : "4/4",
							timeline && `${formatTime(timeline.seconds)}${song?.loop === false ? "" : " loop"}`,
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
					{song?.style && <div className="music-style">{song.style}</div>}
				</div>
				{sketchOf(name) && (
					<button
						title="Start a Composer session that arranges this sketch into the full piece"
						data-testid="arrange-sketch"
						onClick={() =>
							openNewSession({
								agentType: "music-composer",
								target: "project",
								linkedAsset: asset.path,
								context: `Arrange ${name}`,
								prompt: `Arrange the theme sketch ${asset.path} into the full piece assets/music/${sketchOf(name)}/ (an intro, a contrasting section, variations, the full instrumentation), keeping its melody and character. Then delete the sketch folders.`,
							})
						}
					>
						Arrange this theme…
					</button>
				)}
				<RenderStatus state={render} busy={busy} disabled={!timeline} onRender={() => void run("render_song", {})} />
			</div>
			{working.length > 0 && (
				<div className="row music-working" data-testid="music-working">
					<span className="spinner" />
					<span className="grow ellipsis">
						The composer is working on this piece: <b>{working[0].title}</b>
					</span>
					<button className="small" onClick={() => useStudio.getState().selectSession(working[0].id)}>
						Open session
					</button>
				</div>
			)}
			{song && timeline && <MixBar song={song} busy={busy} onApply={(edit) => void run("edit_song", edit)} />}
			{parsed.errors.length > 0 && (
				<div className="card music-problems" data-testid="music-problems">
					<h3>Problems in the score</h3>
					{parsed.errors.map((e, i) => (
						<div key={i}>
							{e.at && <code>{e.at}</code>} {e.message}
						</div>
					))}
				</div>
			)}
			{render.kind !== "none" && render.kind !== "loading" && (
				<Player
					src={studioFile(checkout, `${dir}/${leafName(name)}.ogg`, `${version}:${render.kind}`)}
					loop={song?.loop !== false}
					timeline={timeline}
					onSection={setSection}
					stems={stems}
					muted={muted}
					region={selection?.range ?? null}
				/>
			)}
			{song && timeline && (
				<>
					<Arrangement
						song={song}
						timeline={timeline}
						selected={section}
						onSelect={setSection}
						selection={selection}
						onSelection={setSelection}
						onAdd={() => setAdding(true)}
						canAdd={!busy && working.length === 0}
						muted={muted}
						onMuted={setMuted}
						stemsLoading={stemsLoading}
					/>
					{selection?.track && (
						<RecomposePanel
							song={song}
							timeline={timeline}
							selection={selection as Selection & { track: string }}
							disabled={busy || working.length > 0}
							onClear={() => setSelection(null)}
							onRecompose={(feedback) =>
								void compose(
									`Recompose ${selection.track}${selection.range ? ` (${selection.range.to > selection.range.from ? `bars ${selection.range.from}-${selection.range.to}` : `bar ${selection.range.from}`})` : ""}`,
									recomposeBrief({ name, song, timeline, track: selection.track!, range: selection.range, feedback }),
								)
							}
						/>
					)}
					{adding && (
						<AddInstrumentDialog
							taken={Object.keys(song.instruments)}
							busy={busy}
							onClose={() => setAdding(false)}
							onCompose={(instrument, id, notes) => void compose(`Add ${instrument === "drums" ? "drums" : instrument}`, addPartBrief({ name, instrument, id, notes }))}
						/>
					)}
					<NoteView song={song} timeline={timeline} section={Math.min(section, timeline.sections.length - 1)} />
					<SimpleEdits song={song} busy={busy} onApply={(edit) => void run("edit_song", edit)} />
				</>
			)}
		</div>
	);
}

function RenderStatus({ state, busy, disabled, onRender }: { state: RenderState; busy: boolean; disabled: boolean; onRender(): void }) {
	const label = {
		loading: "",
		none: "Not rendered yet",
		stale: "The audio is older than the score",
		current: "Audio up to date",
	}[state.kind];
	return (
		<div className="row render-status" data-testid="render-status" data-state={state.kind}>
			<span className={`muted ${state.kind === "stale" ? "warn" : ""}`}>{label}</span>
			{(state.kind === "none" || state.kind === "stale") && (
				<button className="primary" disabled={busy || disabled} onClick={onRender}>
					{busy ? "Rendering…" : "Render"}
				</button>
			)}
		</div>
	);
}

/**
 * Plays a piece's stems together (Web Audio), each through its own gain so tracks mute instantly, then a limiter
 * standing in for the master's. Loops like the render: the stems are cut to the same loop.
 */
class StemEngine {
	private ctx = new AudioContext();
	private out: AudioNode;
	private gains = new Map<string, GainNode>();
	private sources: AudioBufferSourceNode[] = [];
	private startedAt = 0;
	private offset = 0;
	// Bars looping exactly (the sources' loopStart/loopEnd), or null for the whole piece.
	private region: { start: number; end: number } | null = null;
	playing = false;
	readonly duration: number;
	onEnded?: () => void;

	constructor(
		private buffers: Map<string, AudioBuffer>,
		private loop: boolean,
	) {
		const limiter = this.ctx.createDynamicsCompressor();
		limiter.threshold.value = -1;
		limiter.knee.value = 0;
		limiter.ratio.value = 20;
		limiter.attack.value = 0.003;
		limiter.release.value = 0.06;
		limiter.connect(this.ctx.destination);
		this.out = limiter;
		for (const track of buffers.keys()) {
			const g = this.ctx.createGain();
			g.connect(this.out);
			this.gains.set(track, g);
		}
		this.duration = Math.max(0, ...[...buffers.values()].map((b) => b.duration));
	}

	static async load(stems: { track: string; ogg: Uint8Array }[], loop: boolean): Promise<StemEngine> {
		const decoder = new AudioContext();
		const buffers = new Map<string, AudioBuffer>();
		for (const s of stems) buffers.set(s.track, await decoder.decodeAudioData(s.ogg.slice().buffer as ArrayBuffer));
		void decoder.close();
		return new StemEngine(buffers, loop);
	}

	time(): number {
		if (!this.playing) return this.offset;
		const t = this.ctx.currentTime - this.startedAt;
		const r = this.region;
		if (r && t >= r.end) return r.start + ((t - r.start) % (r.end - r.start));
		return this.loop ? t % this.duration : Math.min(t, this.duration);
	}

	/** Plays from `at`; with `region`, loops those seconds exactly instead of the whole piece. */
	play(at = this.offset, region: { start: number; end: number } | null = null): void {
		this.stopSources();
		void this.ctx.resume();
		const from = this.loop ? at % this.duration : Math.min(at, this.duration);
		this.region = region;
		for (const [track, buffer] of this.buffers) {
			const src = this.ctx.createBufferSource();
			src.buffer = buffer;
			src.loop = this.loop || !!region;
			if (region) {
				src.loopStart = region.start;
				src.loopEnd = region.end;
			}
			src.connect(this.gains.get(track)!);
			src.start(0, from);
			this.sources.push(src);
		}
		if (!this.loop && !region && this.sources[0]) this.sources[0].onended = () => this.playing && (this.pause(), (this.offset = 0), this.onEnded?.());
		this.startedAt = this.ctx.currentTime - from;
		this.playing = true;
	}

	pause(): void {
		this.offset = this.time();
		this.stopSources();
		this.playing = false;
	}

	seek(t: number): void {
		if (this.playing) this.play(t);
		else this.offset = t;
	}

	setMuted(muted: Set<string>): void {
		for (const [track, g] of this.gains) g.gain.setTargetAtTime(muted.has(track) ? 0 : 1, this.ctx.currentTime, 0.01);
	}

	dispose(): void {
		this.stopSources();
		void this.ctx.close();
	}

	private stopSources(): void {
		for (const s of this.sources) {
			s.onended = null;
			try {
				s.stop();
			} catch {
				// never started
			}
		}
		this.sources = [];
	}
}

/**
 * Plays the rendered OGG (as a blob, so seeking works), looping like the game; reports the section playing. While
 * tracks are muted it plays the stems instead (`stems`), picking up where the render was, and back.
 */
function Player({
	src,
	loop,
	timeline,
	onSection,
	stems,
	muted,
	region,
}: {
	src: string;
	loop: boolean;
	timeline: Timeline | null;
	onSection(i: number): void;
	stems: StemEngine | null;
	muted: Set<string>;
	/** Bars picked in the arrangement (1-based, inclusive): "▶ Bars" plays only them, looped if wanted. */
	region: { from: number; to: number } | null;
}) {
	const audio = useRef<HTMLAudioElement>(null);
	const [url, setUrl] = useState<string>();
	const [playing, setPlaying] = useState(false);
	const [time, setTime] = useState(0);
	const [duration, setDuration] = useState(0);
	useEffect(() => {
		let live = true;
		let made: string | undefined;
		fetch(src)
			.then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
			.then((b) => live && setUrl((made = URL.createObjectURL(b))))
			.catch(() => {});
		return () => {
			live = false;
			if (made) URL.revokeObjectURL(made);
		};
	}, [src]);
	const stemMode = !!stems && muted.size > 0;
	const active = useRef<"audio" | "stems">("audio");
	// Bars as seconds, and whether they're playing on their own (looped or once).
	const barSec = timeline ? timeline.seconds / (timeline.totalTicks / timeline.ticksPerBar) : 0;
	const span = region && timeline ? { start: (region.from - 1) * barSec, end: region.to * barSec } : null;
	const [loopRegion, setLoopRegion] = useState(false);
	const regionPlay = useRef(false);
	const spanRef = useRef(span);
	spanRef.current = span;
	const loopRef = useRef(loopRegion);
	loopRef.current = loopRegion;
	/** The region the stems should loop right now, if any. */
	const stemRegion = () => (regionPlay.current && loopRef.current ? spanRef.current : null);
	// Hand playback between the render and the stems at the same moment.
	useEffect(() => {
		const a = audio.current;
		const next = stemMode ? "stems" : "audio";
		if (!a || active.current === next) return;
		if (next === "stems" && stems) {
			const wasPlaying = !a.paused;
			const t = a.currentTime;
			a.pause();
			stems.setMuted(muted);
			stems.seek(t);
			if (wasPlaying) stems.play(t, stemRegion());
			setPlaying(wasPlaying);
		} else if (stems) {
			const wasPlaying = stems.playing;
			const t = stems.time();
			stems.pause();
			a.currentTime = t;
			if (wasPlaying) void a.play();
		}
		active.current = next;
	}, [stemMode, stems, muted]);
	useEffect(() => {
		if (stemMode) stems?.setMuted(muted);
	}, [stemMode, stems, muted]);
	useEffect(() => {
		if (stems) stems.onEnded = () => setPlaying(false);
		return () => {
			if (active.current === "stems") active.current = "audio";
		};
	}, [stems]);
	const now = () => (active.current === "stems" && stems ? stems.time() : (audio.current?.currentTime ?? 0));
	const seekTo = (t: number) => {
		if (active.current === "stems" && stems) {
			if (stems.playing) stems.play(t, stemRegion());
			else stems.seek(t);
		} else if (audio.current) audio.current.currentTime = t;
		setTime(t);
	};
	const pause = () => {
		if (active.current === "stems" && stems) stems.pause();
		else audio.current?.pause();
		setPlaying(false);
	};
	/** Plays the picked bars on their own (looped if Loop is on), from their start. */
	const playRegion = () => {
		const s = spanRef.current;
		if (!s) return;
		regionPlay.current = true;
		if (active.current === "stems" && stems) {
			stems.play(s.start, stemRegion());
			setPlaying(true);
		} else if (audio.current) {
			audio.current.currentTime = s.start;
			void audio.current.play();
		}
		setTime(s.start);
	};
	// A new pick, or Loop toggled, while the bars play: the stems pick up the new loop where they are.
	useEffect(() => {
		if (!regionPlay.current || active.current !== "stems" || !stems?.playing) return;
		const s = spanRef.current;
		const t = stems.time();
		stems.play(s && (t < s.start || t >= s.end) ? s.start : t, stemRegion());
	}, [span?.start, span?.end, loopRegion, stems]);
	/** To the start of this bar, or of the one before when already at the start (⏮); to the next bar (⏭). */
	const skip = (dir: -1 | 1) => {
		if (!barSec || !timeline) return;
		const t = now();
		const bar = Math.floor(t / barSec + 1e-6);
		let target = dir < 0 ? (t - bar * barSec < 0.3 && bar > 0 ? (bar - 1) * barSec : bar * barSec) : (bar + 1) * barSec;
		if (target >= timeline.seconds - 1e-3) target = loop ? 0 : bar * barSec;
		seekTo(target);
	};

	useEffect(() => {
		if (!playing) return;
		let frame = 0;
		const tick = () => {
			let t = now();
			const s = spanRef.current;
			if (regionPlay.current && s && t >= s.end - 0.005) {
				// The stems loop the bars themselves; the render's audio element is put back each time round.
				if (!loopRef.current) {
					regionPlay.current = false;
					pause();
					seekTo((t = s.start));
				} else if (active.current === "audio" && audio.current) audio.current.currentTime = t = s.start;
			}
			setTime(t);
			if (timeline) {
				const tick = (t / timeline.seconds) * timeline.totalTicks;
				const i = timeline.sections.findIndex((s) => tick >= s.tick && tick < s.tick + s.ticks);
				if (i >= 0) onSection(i);
			}
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [playing, timeline, onSection, stems]);
	const toggle = () => {
		regionPlay.current = false;
		if (active.current === "stems" && stems) {
			if (stems.playing) stems.pause();
			else stems.play();
			setPlaying(stems.playing);
			return;
		}
		const a = audio.current;
		if (!a) return;
		if (a.paused) void a.play();
		else a.pause();
	};
	return (
		<div className="music-player row" data-testid="music-player">
			<audio
				ref={audio}
				src={url}
				loop={loop}
				onPlay={() => setPlaying(true)}
				onPause={() => active.current === "audio" && setPlaying(false)}
				onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
				data-testid="music-audio"
			/>
			<button className="small" disabled={!url || !barSec} onClick={() => skip(-1)} title="To the start of this bar (twice: the bar before)" data-testid="music-bar-back">
				⏮
			</button>
			<button className="primary" disabled={!url} onClick={toggle} data-testid="music-play">
				{playing && !regionPlay.current ? "❚❚ Pause" : "▶ Play"}
			</button>
			<button className="small" disabled={!url || !barSec} onClick={() => skip(1)} title="To the start of the next bar" data-testid="music-bar-forward">
				⏭
			</button>
			{span && region && (
				<span className="row music-region">
					<button
						className={playing && regionPlay.current ? "primary" : ""}
						disabled={!url}
						onClick={() => (playing && regionPlay.current ? (regionPlay.current = false, pause()) : playRegion())}
						title="Play only the bars picked in the arrangement"
						data-testid="music-play-region"
					>
						{playing && regionPlay.current ? "❚❚" : "▶"} {region.from === region.to ? `Bar ${region.from}` : `Bars ${region.from}-${region.to}`}
					</button>
					<label className="row small" title="Play the picked bars round and round">
						<input type="checkbox" checked={loopRegion} onChange={(e) => setLoopRegion(e.target.checked)} data-testid="music-loop-region" /> Loop
					</label>
				</span>
			)}
			<input
				className="grow"
				type="range"
				min={0}
				max={duration || 1}
				step={0.01}
				value={time}
				onChange={(e) => seekTo(Number(e.target.value))}
			/>
			<span className="muted mono" data-testid="music-clock">
				{formatTime(time)} / {formatTime(duration)}
				{barSec > 0 && timeline && ` · bar ${Math.min(timeline.totalTicks / timeline.ticksPerBar, Math.floor(time / barSec + 1e-6) + 1)}`}
			</span>
			{loop && <span className="badge">loops</span>}
			{stemMode && (
				<span className="badge" title="Playing each track's stem, so muted tracks are left out" data-testid="stems-playing">
					{muted.size} muted
				</span>
			)}
			<PlayheadBridge time={time} timeline={timeline} />
		</div>
	);
}

/** Publishes the playback position for the arrangement's playhead (a CSS variable on the music view). */
function PlayheadBridge({ time, timeline }: { time: number; timeline: Timeline | null }) {
	useEffect(() => {
		const el = document.querySelector<HTMLElement>("[data-testid=music-detail]");
		if (el && timeline) el.style.setProperty("--playhead", String(Math.min(1, time / timeline.seconds)));
	}, [time, timeline]);
	return null;
}

const instrumentLabel = (t: TimelineTrack) => (t.drums ? "drums" : GM_PROGRAMS[t.program]);

/**
 * Bars picked in the arrangement (piece bars, 1-based, inclusive), on a track (for "Recompose") or on the ruler
 * (to play them on their own); a track alone is the whole track.
 */
type Selection = { track?: string; range?: { from: number; to: number } };

const ZOOM_MAX = 48;

/**
 * Tracks × sections: each cell a tiny piano roll of that track in that section. The wheel zooms the lanes (around
 * the cursor; they scroll sideways when wider than the view). Click a track's name to pick the whole track, or its
 * lane to pick a bar (drag or shift-click to pick several); the bar ruler picks bars to play on their own.
 */
function Arrangement({
	song,
	timeline,
	selected,
	onSelect,
	selection,
	onSelection,
	onAdd,
	canAdd,
	muted,
	onMuted,
	stemsLoading,
}: {
	song: Song;
	timeline: Timeline;
	selected: number;
	onSelect(i: number): void;
	selection: Selection | null;
	onSelection(s: Selection | null): void;
	onAdd(): void;
	canAdd: boolean;
	muted: Set<string>;
	onMuted(m: Set<string>): void;
	stemsLoading: boolean;
}) {
	const total = timeline.totalTicks;
	const bars = total / timeline.ticksPerBar;
	const audible = timeline.tracks.filter((t) => t.notes.length).map((t) => t.id);
	const allMuted = audible.length > 0 && audible.every((id) => muted.has(id));
	const toggleMute = (id: string) => {
		const next = new Set(muted);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onMuted(next);
	};

	// Zoom: the lanes are `zoom` × the view's width; the wheel zooms around the point under the cursor.
	const [zoom, setZoom] = useState(1);
	const [viewWidth, setViewWidth] = useState(800);
	const scroll = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ frac: number; x: number } | null>(null);
	useEffect(() => {
		const el = scroll.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // a sideways swipe scrolls
			e.preventDefault();
			const r = el.getBoundingClientRect();
			const x = e.clientX - r.left;
			anchor.current = { frac: (el.scrollLeft + x) / el.scrollWidth, x };
			setZoom((z) => Math.min(ZOOM_MAX, Math.max(1, z * Math.exp(-e.deltaY * 0.002))));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
		ro.observe(el);
		return () => {
			el.removeEventListener("wheel", onWheel);
			ro.disconnect();
		};
	}, []);
	useLayoutEffect(() => {
		const el = scroll.current;
		const a = anchor.current;
		if (!el || !a) return;
		el.scrollLeft = a.frac * el.scrollWidth - a.x;
		anchor.current = null;
	}, [zoom]);
	// While zoomed in, keep the playhead in view.
	useEffect(() => {
		if (zoom <= 1) return;
		let frame = 0;
		let last = "";
		const follow = () => {
			const el = scroll.current;
			const v = document.querySelector<HTMLElement>("[data-testid=music-detail]")?.style.getPropertyValue("--playhead") ?? "";
			if (el && v && v !== last) {
				last = v;
				const x = Number(v) * el.scrollWidth;
				if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth) el.scrollLeft = x - el.clientWidth * 0.1;
			}
			frame = requestAnimationFrame(follow);
		};
		frame = requestAnimationFrame(follow);
		return () => cancelAnimationFrame(frame);
	}, [zoom]);
	const barPx = (viewWidth * zoom) / bars;
	const labelEvery = [1, 2, 4, 8, 16, 32, 64].find((n) => n * barPx >= 26) ?? 128;

	// Picking bars: on a track's lane (for recomposing) or the ruler (to play them).
	const drag = useRef<{ track?: string; anchor: number } | null>(null);
	const barAt = (e: React.MouseEvent<HTMLElement>) => {
		const r = e.currentTarget.getBoundingClientRect();
		return Math.min(bars, Math.max(1, Math.floor(((e.clientX - r.left) / r.width) * bars) + 1));
	};
	const pick = (track: string | undefined, a: number, b: number) => onSelection({ track, range: { from: Math.min(a, b), to: Math.max(a, b) } });
	const startPick = (track: string | undefined) => (e: React.MouseEvent<HTMLElement>) => {
		const bar = barAt(e);
		const keep = e.shiftKey && selection?.track === track && selection?.range;
		const from = keep ? selection.range!.from : bar;
		drag.current = { track, anchor: from };
		pick(track, from, bar);
	};
	const movePick = (track: string | undefined) => (e: React.MouseEvent<HTMLElement>) =>
		drag.current && drag.current.track === track && e.buttons === 1 && pick(track, drag.current.anchor, barAt(e));
	useEffect(() => {
		const up = () => (drag.current = null);
		window.addEventListener("mouseup", up);
		return () => window.removeEventListener("mouseup", up);
	}, []);
	const pickBox = (s: Selection) =>
		s.range ? { left: `${((s.range.from - 1) / bars) * 100}%`, width: `${((s.range.to - s.range.from + 1) / bars) * 100}%` } : { left: 0, width: "100%" };
	const grid = barPx >= 8 ? { backgroundImage: "linear-gradient(to right, var(--border) 1px, transparent 1px)", backgroundSize: `${100 / bars}% 100%` } : undefined;

	return (
		<div className="arrangement" data-testid="arrangement">
			<div className="arr-grid">
				<div className="arr-labels">
					<div className="arr-label arr-h-header">
						<button
							className="small"
							onClick={() => onMuted(allMuted ? new Set() : new Set(audible))}
							title={allMuted ? "Hear every track again" : "Mute every track, then unmute the ones to hear on their own"}
							data-testid="mute-all"
						>
							{allMuted ? "Unmute all" : "Mute all"}
						</button>
						{stemsLoading && <span className="muted small">preparing stems…</span>}
					</div>
					<div className="arr-label arr-h-ruler muted small" title="Scroll on the lanes to zoom; drag on the ruler to pick bars to play">
						<span className="grow">Bars</span>
						{zoom > 1 && (
							<button className="small ghost" onClick={() => setZoom(1)} title="Fit the whole piece" data-testid="arr-zoom-fit">
								{Math.round(zoom * 100)}% ⤢
							</button>
						)}
					</div>
					{timeline.tracks.map((t, ti) => (
						<div
							key={t.id}
							className={`arr-label arr-h-track ${selection?.track === t.id ? "picked expanded" : ""} ${muted.has(t.id) ? "muted-track" : ""}`}
							title={`${instrumentLabel(t)}: click to pick the whole track`}
							onClick={() => onSelection(selection?.track === t.id && !selection.range ? null : { track: t.id })}
							data-testid="arr-track"
						>
							<button
								className={`mute ${muted.has(t.id) ? "on" : ""}`}
								disabled={!t.notes.length}
								title={muted.has(t.id) ? `Unmute ${t.id}` : `Mute ${t.id}`}
								onClick={(e) => (e.stopPropagation(), toggleMute(t.id))}
								data-testid="mute-track"
							>
								M
							</button>
							<span className="swatch" style={{ background: COLOURS[ti % COLOURS.length] }} />
							<span className="ellipsis">
								<b>{t.id}</b> <span className="muted">{instrumentLabel(t)}</span>
							</span>
							{selection?.track === t.id && t.notes.length > 0 && (
								<span className="arr-range muted small" data-testid="arr-range">
									{t.drums
										? [...new Set(t.notes.map((n) => n.pitch))].sort((a, b) => b - a).map(drumName).join(", ")
										: `${pitchName(Math.min(...t.notes.map((n) => n.pitch)))}–${pitchName(Math.max(...t.notes.map((n) => n.pitch)))}`}
								</span>
							)}
						</div>
					))}
				</div>
				<div className="arr-scroll" ref={scroll} data-testid="arr-scroll">
					<div className="arr-lanes" style={{ width: `${zoom * 100}%` }}>
						<div className="arr-lane arr-h-header">
							{timeline.sections.map((s, i) => (
								<button
									key={i}
									className={`arr-section ${i === selected ? "on" : ""}`}
									style={{ left: `${(s.tick / total) * 100}%`, width: `${(s.ticks / total) * 100}%` }}
									onClick={() => onSelect(i)}
									title={`${s.name}: ${s.ticks / timeline.ticksPerBar} bars`}
								>
									{s.name}
								</button>
							))}
							<div className="arr-playhead" />
						</div>
						<div className="arr-lane arr-h-ruler arr-ruler pickable" onMouseDown={startPick(undefined)} onMouseMove={movePick(undefined)} data-testid="arr-ruler">
							{selection?.range && !selection.track && <div className="arr-pick" style={pickBox(selection)} />}
							{Array.from({ length: Math.ceil(bars / labelEvery) }, (_, k) => k * labelEvery).map((b) => (
								<span key={b} className="arr-bar-number" style={{ left: `${(b / bars) * 100}%` }}>
									{b + 1}
								</span>
							))}
							<div className="arr-playhead" />
						</div>
						{timeline.tracks.map((t, ti) => {
							const pitches = t.notes.map((n) => n.pitch);
							const lo = Math.min(...pitches, 127);
							const hi = Math.max(...pitches, 0);
							// The picked track stretches: a row per pitch (per drum), octaves marked at each C.
							const big = selection?.track === t.id && pitches.length > 0;
							const rows = t.drums ? [...new Set(pitches)].sort((a, b) => b - a) : Array.from({ length: hi - lo + 1 }, (_, k) => hi - k);
							const rowH = 100 / Math.max(1, rows.length);
							return (
								<div
									key={t.id}
									className={`arr-lane arr-h-track pickable ${big ? "picked expanded" : selection?.track === t.id ? "picked" : ""} ${muted.has(t.id) ? "muted-track" : ""}`}
									title="Click a bar to pick it; drag or shift-click to pick several"
									onMouseDown={startPick(t.id)}
									onMouseMove={movePick(t.id)}
									data-testid="arr-track-lane"
								>
									{selection?.track === t.id && <div className="arr-pick" data-testid="arr-pick" style={pickBox(selection)} />}
									{timeline.sections.map((s, i) => (
										<div
											key={i}
											className={`arr-cell ${i === selected ? "on" : ""}`}
											style={{ left: `${(s.tick / total) * 100}%`, width: `${(s.ticks / total) * 100}%` }}
										/>
									))}
									{grid && <div className="arr-bars" style={grid} />}
									<svg className="arr-notes" viewBox={`0 0 ${total} 100`} preserveAspectRatio="none">
										{big &&
											rows.map((p, r) =>
												t.drums ? (
													r % 2 === 1 && <rect key={`r${p}`} x={0} y={r * rowH} width={total} height={rowH} className="arr-row-shade" />
												) : (
													p % 12 === 0 && <rect key={`r${p}`} x={0} y={r * rowH + rowH - 0.35} width={total} height={0.35} className="arr-octave" />
												),
											)}
										{t.notes.map((n, i) => (
											<rect
												key={i}
												x={n.tick}
												width={Math.max(n.ticks - (big ? total / 2000 : 0), total / 800)}
												y={big ? rows.indexOf(n.pitch) * rowH + rowH * 0.1 : hi === lo ? 45 : 90 - ((n.pitch - lo) / (hi - lo)) * 80}
												height={big ? rowH * 0.8 : 10}
												fill={COLOURS[ti % COLOURS.length]}
												opacity={big ? 0.45 + (n.velocity / 127) * 0.55 : 1}
											>
												{big && <title>{`${t.drums ? drumName(n.pitch) : pitchName(n.pitch)} · bar ${Math.floor(n.tick / timeline.ticksPerBar) + 1}`}</title>}
											</rect>
										))}
									</svg>
									<div className="arr-playhead" />
								</div>
							);
						})}
					</div>
				</div>
			</div>
			<div className="row">
				<span className="muted small grow">
					{song.arrangement.length} sections · {bars} bars. Scroll on the lanes to zoom. Click a section to see its notes; click a track or its bars to recompose them;
					drag on the ruler to pick bars to play.
				</span>
				<button className="small" disabled={!canAdd} onClick={onAdd} data-testid="add-instrument">
					+ Add instrument
				</button>
			</div>
		</div>
	);
}

/** One arrangement entry's notes, all tracks, on a pitch grid (drums in their own lane at the bottom). */
function NoteView({ timeline, section }: { song: Song; timeline: Timeline; section: number }) {
	const s = timeline.sections[section];
	const tracks = timeline.tracks.map((t, i) => ({
		t,
		i,
		notes: t.notes.filter((n) => n.tick >= s.tick && n.tick < s.tick + s.ticks),
	}));
	const tonal = tracks.filter((x) => !x.t.drums).flatMap((x) => x.notes.map((n) => n.pitch));
	const drums = [...new Set(tracks.filter((x) => x.t.drums).flatMap((x) => x.notes.map((n) => n.pitch)))].sort((a, b) => b - a);
	const lo = Math.min(...tonal, 60) - 1;
	const hi = Math.max(...tonal, 72) + 1;
	const rowH = 7;
	const tonalRows = hi - lo + 1;
	const height = (tonalRows + drums.length) * rowH + 4;
	const width = 1000;
	const x = (tick: number) => ((tick - s.tick) / s.ticks) * width;
	const bars = s.ticks / timeline.ticksPerBar;
	return (
		<div className="note-view" data-testid="note-view">
			<div className="row muted small">
				<b className="note-view-title">{s.name}</b> bar {s.tick / timeline.ticksPerBar + 1}-{s.tick / timeline.ticksPerBar + bars} · {pitchName(lo + 1)}-
				{pitchName(hi - 1)}
				{drums.length > 0 && ` · drums: ${drums.map(drumName).join(", ")}`}
			</div>
			<div className="note-frame">
				<div className="note-labels">
					{Array.from({ length: tonalRows }, (_, r) => hi - r)
						.filter((p) => p % 12 === 0)
						.map((p) => (
							<span
								key={p}
								style={{
									top: `${(((hi - p) * rowH + rowH / 2) / height) * 100}%`,
								}}
							>
								{pitchName(p)}
							</span>
						))}
				</div>
				<svg viewBox={`0 0 ${width} ${height}`} className="note-svg" preserveAspectRatio="none" style={{ height: Math.min(360, height * 1.6) }}>
					{Array.from({ length: tonalRows }, (_, r) => {
						const pitch = hi - r;
						return (
							<rect
								key={r}
								x={0}
								y={r * rowH}
								width={width}
								height={rowH}
								className={[1, 3, 6, 8, 10].includes(pitch % 12) ? "key-black" : pitch % 12 === 0 ? "key-c" : "key-white"}
							/>
						);
					})}
					{drums.map((d, r) => (
						<rect key={`d${d}`} x={0} y={(tonalRows + r) * rowH + 4} width={width} height={rowH} className="key-drum" />
					))}
					{Array.from({ length: bars + 1 }, (_, b) => (
						<line key={b} x1={(b / bars) * width} x2={(b / bars) * width} y1={0} y2={height} className="bar-line" />
					))}
					{tracks.map(({ t, i, notes }) =>
						notes.map((n, k) => {
							const y = t.drums ? (tonalRows + drums.indexOf(n.pitch)) * rowH + 4 : (hi - n.pitch) * rowH;
							return (
								<rect
									key={`${t.id}${k}`}
									x={x(n.tick)}
									y={y + 0.5}
									width={Math.max(2, x(n.tick + n.ticks) - x(n.tick) - 1)}
									height={rowH - 1}
									rx={1.5}
									fill={COLOURS[i % COLOURS.length]}
									opacity={0.4 + (n.velocity / 127) * 0.6}
								>
									<title>{`${t.id}: ${t.drums ? drumName(n.pitch) : pitchName(n.pitch)}`}</title>
								</rect>
							);
						}),
					)}
				</svg>
			</div>
		</div>
	);
}

/** Each instrument's sound and volume; applying writes song.json and re-renders. */
function SimpleEdits({
	song,
	busy,
	onApply,
}: {
	song: Song;
	busy: boolean;
	onApply(edit: { instruments?: Record<string, { program?: string; volume?: number }> }): void;
}) {
	const [inst, setInst] = useState<Record<string, { program?: string; volume?: number }>>({});
	const changed = Object.keys(inst).length > 0;
	return (
		<details className="card simple-edits">
			<summary>Instruments: sound and volume</summary>
			<div className="col">
				{Object.entries(song.instruments).map(([id, i]) =>
					i.drums ? null : (
						<label key={id} className="row">
							<b style={{ width: 90 }}>{id}</b>
							<select
								value={inst[id]?.program ?? GM_PROGRAMS[gmProgram(i.program) ?? 0]}
								onChange={(e) =>
									setInst({
										...inst,
										[id]: { ...inst[id], program: e.target.value },
									})
								}
							>
								{GM_PROGRAMS.map((p) => (
									<option key={p}>{p}</option>
								))}
							</select>
							<input
								type="range"
								min={0}
								max={1}
								step={0.05}
								value={inst[id]?.volume ?? i.volume ?? 0.8}
								onChange={(e) =>
									setInst({
										...inst,
										[id]: { ...inst[id], volume: Number(e.target.value) },
									})
								}
								title="Volume"
							/>
						</label>
					),
				)}
				<div className="row">
					<span className="grow muted small">Changes are written to the score in a session and re-rendered. For anything musical, ask the composer.</span>
					<button
						className="primary"
						disabled={!changed || busy}
						onClick={() =>
							onApply({ instruments: inst })
						}
					>
						Apply
					</button>
				</div>
			</div>
		</details>
	);
}

const SPACE_LABEL: Record<Space, { label: string; hint: string }> = {
	dry: { label: "Dry", hint: "Close and tight: no room around it" },
	room: { label: "Room", hint: "A small room (the default)" },
	hall: { label: "Hall", hint: "A big, soft hall: long, lush reverb" },
};

/** Tempo, the room it plays in and how loosely it's played: tried by ear, each applied to the score and re-rendered. */
function MixBar({ song, busy, onApply }: { song: Song; busy: boolean; onApply(edit: { tempo?: number; space?: Space; humanize?: number }): void }) {
	const [tempo, setTempo] = useState(song.tempo);
	const [feel, setFeel] = useState(song.humanize ?? 0.4);
	useEffect(() => setTempo(song.tempo), [song.tempo]);
	useEffect(() => setFeel(song.humanize ?? 0.4), [song.humanize]);
	const space = song.space ?? "room";
	const changed = tempo !== song.tempo || feel !== (song.humanize ?? 0.4);
	const validTempo = tempo >= 20 && tempo <= 300;
	return (
		<div className="row music-mixbar" data-testid="music-mixbar">
			<label className="row" title="Quarter notes per minute">
				<span className="muted">Tempo</span>
				<button className="small" disabled={busy} onClick={() => setTempo((t) => Math.max(20, t - 4))}>
					−
				</button>
				<input type="number" min={20} max={300} value={tempo} onChange={(e) => setTempo(Number(e.target.value))} style={{ width: 64 }} data-testid="music-tempo" />
				<button className="small" disabled={busy} onClick={() => setTempo((t) => Math.min(300, t + 4))}>
					+
				</button>
				<span className="muted">bpm</span>
			</label>
			<div className="row" role="group" aria-label="Space">
				<span className="muted">Space</span>
				<div className="segmented">
					{SPACES.map((s) => (
						<button
							key={s}
							className={s === space ? "on" : ""}
							disabled={busy}
							title={SPACE_LABEL[s].hint}
							onClick={() => s !== space && onApply({ space: s })}
							data-testid={`music-space-${s}`}
						>
							{SPACE_LABEL[s].label}
						</button>
					))}
				</div>
			</div>
			<label className="row" title="0: exactly on the grid; higher: looser timing and dynamics, like people playing">
				<span className="muted">Feel</span>
				<span className="small muted">tight</span>
				<input type="range" min={0} max={1} step={0.05} value={feel} disabled={busy} onChange={(e) => setFeel(Number(e.target.value))} data-testid="music-feel" />
				<span className="small muted">loose</span>
			</label>
			<span className="grow" />
			{changed && (
				<>
					<button className="small" disabled={busy} onClick={() => (setTempo(song.tempo), setFeel(song.humanize ?? 0.4))}>
						Reset
					</button>
					<button
						className="primary small"
						disabled={busy || !validTempo}
						onClick={() => onApply({ ...(tempo !== song.tempo ? { tempo } : {}), ...(feel !== (song.humanize ?? 0.4) ? { humanize: feel } : {}) })}
						data-testid="music-mix-apply"
					>
						{busy ? "Rendering…" : "Apply"}
					</button>
				</>
			)}
		</div>
	);
}

/** What's picked in the arrangement, and a brief for the composer to rewrite it, with the user's own feedback. */
function RecomposePanel({
	song,
	timeline,
	selection,
	disabled,
	onClear,
	onRecompose,
}: {
	song: Song;
	timeline: Timeline;
	selection: Selection & { track: string };
	disabled: boolean;
	onClear(): void;
	onRecompose(feedback: string): void;
}) {
	const [feedback, setFeedback] = useState("");
	const inst = song.instruments[selection.track];
	const sound = inst?.drums ? "drums" : GM_PROGRAMS[gmProgram(inst?.program) ?? 0];
	const r = selection.range;
	const where = r ? (r.from === r.to ? `bar ${r.from}` : `bars ${r.from}-${r.to}`) : "the whole piece";
	// Sections the picked bars fall in that play more than once: their patterns are shared.
	const repeated = r
		? [...new Set(timeline.sections.filter((s) => s.tick / timeline.ticksPerBar + 1 <= r.to && (s.tick + s.ticks) / timeline.ticksPerBar >= r.from).map((s) => s.name))].filter(
				(n) => song.arrangement.filter((a) => a === n).length > 1,
			)
		: [];
	return (
		<div className="card col recompose" data-testid="recompose">
			<div className="row">
				<b className="grow">
					Recompose <code>{selection.track}</code> <span className="muted">({sound})</span> · {where}
				</b>
				<button className="small ghost" onClick={onClear} title="Clear the selection">
					✕
				</button>
			</div>
			{repeated.length > 0 && (
				<span className="muted small" data-testid="recompose-shared">
					{repeated.map((n) => `“${n}”`).join(", ")} play{repeated.length === 1 ? "s" : ""} more than once: the composer changes {repeated.length === 1 ? "it" : "them"} everywhere,
					unless you ask for only this place (it then copies the section).
				</span>
			)}
			<textarea
				rows={2}
				placeholder="Optional: what should change? (“busier, more playful”, “follow the bass”, “end on a question”…)"
				value={feedback}
				onChange={(e) => setFeedback(e.target.value)}
				data-testid="recompose-feedback"
			/>
			<div className="row">
				<span className="muted small grow">The Music Composer rewrites only this, renders and tells you what it changed. Undo with the worktree's history or discard.</span>
				<button className="primary" disabled={disabled} onClick={() => onRecompose(feedback)} data-testid="recompose-go">
					Recompose
				</button>
			</div>
		</div>
	);
}

/** Every General MIDI instrument by family (and the drum kit), each previewable, for a part the composer then writes. */
function AddInstrumentDialog({ taken, busy, onClose, onCompose }: { taken: string[]; busy: boolean; onClose(): void; onCompose(instrument: string, id: string, notes: string): void }) {
	const { showError } = useStudio(useShallow((s) => ({ showError: s.showError })));
	const [search, setSearch] = useState("");
	const [chosen, setChosen] = useState<string | null>(null);
	const [notes, setNotes] = useState("");
	const [playing, setPlaying] = useState<string | null>(null);
	const [loading, setLoading] = useState<string | null>(null);
	const audio = useRef<HTMLAudioElement | null>(null);
	const urls = useRef(new Map<string, string>());
	useEffect(
		() => () => {
			audio.current?.pause();
			for (const u of urls.current.values()) URL.revokeObjectURL(u);
		},
		[],
	);
	const preview = async (instrument: string) => {
		audio.current?.pause();
		if (playing === instrument) return setPlaying(null);
		try {
			let url = urls.current.get(instrument);
			if (!url) {
				setLoading(instrument);
				const bytes = await call("music.previewInstrument", instrument);
				url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/ogg" }));
				urls.current.set(instrument, url);
			}
			const a = new Audio(url);
			audio.current = a;
			a.onended = () => setPlaying((p) => (p === instrument ? null : p));
			setPlaying(instrument);
			await a.play();
		} catch (err) {
			showError(err);
		} finally {
			setLoading(null);
		}
	};
	const q = search.trim().toLowerCase();
	const families = [
		...GM_FAMILIES.map((family, f) => ({ family, names: GM_PROGRAMS.slice(f * 8, f * 8 + 8) })),
		{ family: "Drums", names: ["drums"] },
	]
		.map((g) => ({ ...g, names: g.names.filter((n) => !q || n.includes(q) || g.family.toLowerCase().includes(q)) }))
		.filter((g) => g.names.length);
	const id = chosen ? trackIdFor(chosen === "drums" ? "drums" : chosen, taken) : "";
	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="modal col add-instrument" style={{ width: 760 }} onClick={(e) => e.stopPropagation()} data-testid="add-instrument-dialog">
				<h3>Add an instrument</h3>
				<input autoFocus placeholder="Search: cello, synth, brass…" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="instrument-search" />
				<div className="instrument-families">
					{families.map((g) => (
						<div key={g.family} className="instrument-family">
							<div className="muted small">{g.family}</div>
							{g.names.map((n) => (
								<div key={n} className={`row instrument-row ${chosen === n ? "on" : ""}`} onClick={() => setChosen(n)} data-testid="instrument-option">
									<button
										className="small ghost"
										title={`Hear a ${n} phrase`}
										onClick={(e) => (e.stopPropagation(), void preview(n))}
										data-testid="instrument-preview"
									>
										{loading === n ? "…" : playing === n ? "■" : "▶"}
									</button>
									<span className="grow ellipsis">{n}</span>
								</div>
							))}
						</div>
					))}
				</div>
				{chosen && (
					<>
						<div className="muted small">
							New track <code>{id}</code> playing <b>{chosen}</b>. The Music Composer writes its part to fit the others and renders it.
						</div>
						<textarea
							rows={2}
							placeholder="Optional: what should it play? (“a countermelody in the B section”, “sustained pads under the chorus”…)"
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							data-testid="instrument-notes"
						/>
					</>
				)}
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={onClose}>Cancel</button>
					<button className="primary" disabled={!chosen || busy} onClick={() => chosen && onCompose(chosen, id, notes)} data-testid="instrument-compose">
						Compose a part
					</button>
				</div>
			</div>
		</div>
	);
}
