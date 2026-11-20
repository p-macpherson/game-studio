// Music: browse pieces (main checkout + drafts), listen as the game will (looping), see the arrangement and the
// notes, and make simple edits. The score (song.json) is the asset; edits and renders run in a session's
// worktree (the draft's session, or a Music Composer workspace created without running the agent).
import { useEffect, useMemo, useRef, useState } from "react";
import type { StudioRequestMethod } from "../../shared/host";
import type { ModuleInfo } from "../../shared/modules";
import { drumName, GM_PROGRAMS, gmProgram, parseSong, pitchName, type Song, type Timeline, type TimelineTrack } from "../../shared/song";
import { call, sha1, studioFile } from "../../renderer/api";
import { useStudio } from "../../renderer/store";
import { AssetBrowser, type AssetContentProps } from "../../renderer/views/AssetBrowser";
import { runInWorktree } from "../../renderer/workspace";
import { formatTime, pieceName } from "./info";

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
	const { showAsset, showError, openNewSession } = useStudio();
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
					src={studioFile(checkout, `${dir}/${name}.ogg`, `${version}:${render.kind}`)}
					loop={song?.loop !== false}
					timeline={timeline}
					onSection={setSection}
				/>
			)}
			{song && timeline && (
				<>
					<Arrangement song={song} timeline={timeline} selected={section} onSelect={setSection} />
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

/** Plays the rendered OGG (as a blob, so seeking works), looping like the game; reports the section playing. */
function Player({ src, loop, timeline, onSection }: { src: string; loop: boolean; timeline: Timeline | null; onSection(i: number): void }) {
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
	useEffect(() => {
		if (!playing) return;
		let frame = 0;
		const tick = () => {
			const t = audio.current?.currentTime ?? 0;
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
	}, [playing, timeline, onSection]);
	const toggle = () => {
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
				onPause={() => setPlaying(false)}
				onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
				data-testid="music-audio"
			/>
			<button className="primary" disabled={!url} onClick={toggle} data-testid="music-play">
				{playing ? "❚❚ Pause" : "▶ Play"}
			</button>
			<input
				className="grow"
				type="range"
				min={0}
				max={duration || 1}
				step={0.01}
				value={time}
				onChange={(e) => {
					if (audio.current) audio.current.currentTime = Number(e.target.value);
					setTime(Number(e.target.value));
				}}
			/>
			<span className="muted mono">
				{formatTime(time)} / {formatTime(duration)}
			</span>
			{loop && <span className="badge">loops</span>}
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

/** Tracks × sections: each cell a tiny piano roll of that track in that section. */
function Arrangement({ song, timeline, selected, onSelect }: { song: Song; timeline: Timeline; selected: number; onSelect(i: number): void }) {
	const total = timeline.totalTicks;
	return (
		<div className="arrangement" data-testid="arrangement">
			<div className="arr-row arr-header">
				<div className="arr-label" />
				<div className="arr-lane">
					{timeline.sections.map((s, i) => (
						<button
							key={i}
							className={`arr-section ${i === selected ? "on" : ""}`}
							style={{
								left: `${(s.tick / total) * 100}%`,
								width: `${(s.ticks / total) * 100}%`,
							}}
							onClick={() => onSelect(i)}
							title={`${s.name}: ${s.ticks / timeline.ticksPerBar} bars`}
						>
							{s.name}
						</button>
					))}
					<div className="arr-playhead" />
				</div>
			</div>
			{timeline.tracks.map((t, ti) => {
				const pitches = t.notes.map((n) => n.pitch);
				const lo = Math.min(...pitches, 127);
				const hi = Math.max(...pitches, 0);
				return (
					<div className="arr-row" key={t.id} data-testid="arr-track">
						<div className="arr-label" title={instrumentLabel(t)}>
							<span className="swatch" style={{ background: COLOURS[ti % COLOURS.length] }} />
							<span className="ellipsis">
								<b>{t.id}</b> <span className="muted">{instrumentLabel(t)}</span>
							</span>
						</div>
						<div className="arr-lane">
							{timeline.sections.map((s, i) => (
								<div
									key={i}
									className={`arr-cell ${i === selected ? "on" : ""}`}
									style={{
										left: `${(s.tick / total) * 100}%`,
										width: `${(s.ticks / total) * 100}%`,
									}}
								/>
							))}
							<svg className="arr-notes" viewBox={`0 0 ${total} 100`} preserveAspectRatio="none">
								{t.notes.map((n, i) => (
									<rect
										key={i}
										x={n.tick}
										width={Math.max(n.ticks, total / 800)}
										y={hi === lo ? 45 : 90 - ((n.pitch - lo) / (hi - lo)) * 80}
										height={10}
										fill={COLOURS[ti % COLOURS.length]}
									/>
								))}
							</svg>
							<div className="arr-playhead" />
						</div>
					</div>
				);
			})}
			<div className="muted small">
				{song.arrangement.length} sections · {timeline.totalTicks / timeline.ticksPerBar} bars. Click a section to see its notes.
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

/** Tempo and each instrument's sound and volume; applying writes song.json and re-renders. */
function SimpleEdits({
	song,
	busy,
	onApply,
}: {
	song: Song;
	busy: boolean;
	onApply(edit: { tempo?: number; instruments?: Record<string, { program?: string; volume?: number }> }): void;
}) {
	const [tempo, setTempo] = useState(song.tempo);
	const [inst, setInst] = useState<Record<string, { program?: string; volume?: number }>>({});
	const changed = tempo !== song.tempo || Object.keys(inst).length > 0;
	return (
		<details className="card simple-edits">
			<summary>Quick changes</summary>
			<div className="col">
				<label className="row">
					Tempo <input type="number" min={20} max={300} value={tempo} onChange={(e) => setTempo(Number(e.target.value))} style={{ width: 72 }} /> bpm
				</label>
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
							onApply({
								...(tempo !== song.tempo ? { tempo } : {}),
								...(Object.keys(inst).length ? { instruments: inst } : {}),
							})
						}
					>
						Apply
					</button>
				</div>
			</div>
		</details>
	);
}
