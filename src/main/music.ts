// Music: renders a song (assets/music/<name>/song.json, the studio's score format in src/shared/song.ts) to audio.
//   song.json      the score (the asset)
//   <name>.ogg     what the game plays (`engine.play_music`); a seamless loop unless the song says loop: false
//   render.json    which song.json the OGG was rendered from, so a stale render shows
// Rendering is FluidSynth with a General MIDI SoundFont, one stem per track, mixed in music-mix.ts and mastered
// with ffmpeg. A loop is rendered three times in a row and the middle pass kept: its start already holds the reverb
// and release tails of the bars before it.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drumName, gmProgram, GM_PROGRAMS, type Note, parseSong, pitchName, type Space, TICKS_PER_BEAT, type Song, type Timeline, type TimelineTrack } from "../shared/song";
import { ASSET_NAME, leafName } from "../shared/asset-names";
import { safeJoin } from "./assets";
import { decodeWav } from "./audio-dsp";
import { handler, type StudioRequestHandlers } from "./studio-requests";
import { encodeFloatWav, impulse, StemBus, unit } from "./music-mix";

export const MUSIC_DIR = "assets/music";
const RATE = 44100;
/** A song that doesn't loop gets this much room for its last notes to ring out. */
const TAIL_SECONDS = 3;

export interface RenderInfo {
	/** sha1 of the song.json it was rendered from. */
	song: string;
	seconds: number;
	loop: boolean;
	renderedAt: string;
}

export interface RenderResult {
	ogg: string;
	seconds: number;
	loop: boolean;
	tempo: number;
	sections: { name: string; bars: number; seconds: number }[];
	tracks: { id: string; instrument: string; notes: number; range?: string }[];
}

export class SongError extends Error {
	constructor(readonly problems: { at: string; message: string }[]) {
		super(`song.json has ${problems.length} problem(s):\n${problems.map((p) => `- ${p.at ? `${p.at}: ` : ""}${p.message}`).join("\n")}`);
	}
}

export const songHash = (text: string) => createHash("sha1").update(text).digest("hex");

export class MusicPipeline {
	constructor(private readonly deps: { soundfont(): string; fluidsynth?: string; ffmpeg?: string }) {}

	dir(cwd: string, name: string): string {
		if (!ASSET_NAME.test(name)) throw new Error(`A piece's name is lower-kebab-case, with "/" for folders (e.g. "goblin-theme", "themes/goblin"), not "${name}"`);
		return safeJoin(cwd, `${MUSIC_DIR}/${name}`);
	}

	/**
	 * The Music section's simple edits (tempo, an instrument's sound or volume), written into song.json and
	 * rendered. Bigger changes are the composer's job.
	 */
	async edit(
		ctx: { cwd: string; progress?(text: string): void },
		p: { name: string; tempo?: number; space?: Space; humanize?: number; instruments?: Record<string, { program?: string | number; volume?: number }> },
	): Promise<RenderResult> {
		const file = join(this.dir(ctx.cwd, p.name), "song.json");
		const song = JSON.parse(readFileSync(file, "utf8")) as Song;
		if (p.tempo !== undefined) song.tempo = p.tempo;
		if (p.space !== undefined) song.space = p.space;
		if (p.humanize !== undefined) song.humanize = p.humanize;
		for (const [id, change] of Object.entries(p.instruments ?? {})) {
			if (!song.instruments[id]) throw new Error(`No instrument "${id}"`);
			Object.assign(song.instruments[id], change);
		}
		const { errors } = parseSong(song);
		if (errors.length) throw new SongError(errors);
		writeFileSync(file, `${JSON.stringify(song, null, 2)}\n`);
		return this.render(ctx, { name: p.name });
	}

	/**
	 * The mixed, mastered render (all passes) as a 16-bit WAV in `tmp`: each track a stem (FluidSynth, reverb off),
	 * low-cut, summed, its reverb send through the song's space (convolution), then levelled to TARGET_LUFS, glued
	 * with a gentle compressor and EQ, and limited to -1 dBFS.
	 */
	private async mix(ctx: { progress?(text: string): void }, tmp: string, soundfont: string, song: Song, timeline: Timeline, passes: number, tail: number): Promise<string> {
		const ffmpeg = this.deps.ffmpeg ?? "ffmpeg";
		const bus = new StemBus();
		const tracks = timeline.tracks.filter((tr) => tr.notes.length);
		ctx.progress?.(`Rendering ${tracks.length} track(s) with FluidSynth`);
		for (const [i, wav] of (await this.stemWavs(tmp, soundfont, song, timeline, passes, tail, tracks)).entries()) {
			bus.add(decodeWav(readFileSync(wav)).audio, tracks[i]);
			rmSync(wav);
		}
		if (!bus.dry.length) bus.dry = bus.send = [new Float32Array(Math.round(timeline.seconds * passes * RATE)), new Float32Array(Math.round(timeline.seconds * passes * RATE))];

		ctx.progress?.("Mixing");
		const mixed = join(tmp, "mix.wav");
		await this.room(bus, song.space ?? "room", tmp, mixed);
		ctx.progress?.("Mastering");
		// Glue and tone at a known level (the compressor's threshold assumes it), then level to the target and limit.
		const pre = Math.max(-30, Math.min(30, TARGET_LUFS - (await loudness(ffmpeg, mixed))));
		const glued = join(tmp, "glued.wav");
		await run(ffmpeg, ["-y", "-loglevel", "error", "-i", mixed, "-af",
			[`volume=${pre.toFixed(2)}dB`, "acompressor=threshold=0.1:ratio=1.8:attack=25:release=300:knee=4", "equalizer=f=280:t=q:w=1:g=-1.5", "treble=g=1.5:f=9000"].join(","),
			"-c:a", "pcm_f32le", glued]);
		const gain = Math.max(-30, Math.min(30, TARGET_LUFS - (await loudness(ffmpeg, glued))));
		const out = join(tmp, "master.wav");
		await run(ffmpeg, ["-y", "-loglevel", "error", "-i", glued, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:attack=5:release=60:level=0`, "-c:a", "pcm_s16le", "-ar", String(RATE), out]);
		return out;
	}

	/** Each track rendered on its own by FluidSynth (its reverb off), a few at once: the WAV files, in `tracks` order. */
	private async stemWavs(tmp: string, soundfont: string, song: Song, timeline: Timeline, passes: number, tail: number, tracks: TimelineTrack[]): Promise<string[]> {
		const wavs = tracks.map((_, i) => join(tmp, `stem-${i}.wav`));
		let next = 0;
		const worker = async () => {
			for (let i = next++; i < tracks.length; i = next++) {
				const mid = join(tmp, `stem-${i}.mid`);
				writeFileSync(mid, toMidi(song, timeline, passes, tail, tracks[i].id));
				await run(this.deps.fluidsynth ?? "fluidsynth", ["-ni", "-q", "-R", "0", "-C", "1", "-a", "file", "-g", "0.6", "-r", String(RATE), "-F", wavs[i], soundfont, mid]);
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, tracks.length) }, worker));
		return wavs;
	}

	/**
	 * Dry plus the reverb send through the song's space, to a float WAV at `out`. afir's dry/wet are its input and
	 * output gains (not a mix: dry=0 is silence); irnorm=-1 keeps the IR as made, so its unit energy sets the
	 * reverb's level. Zero latency.
	 */
	private async room(bus: StemBus, space: Space, tmp: string, out: string, tag = "mix"): Promise<void> {
		if (space === "dry") return writeFileSync(out, encodeFloatWav(bus.dry));
		const ir = join(tmp, `ir-${space}.wav`);
		if (!existsSync(ir)) writeFileSync(ir, encodeFloatWav(impulse(space)));
		const dry = join(tmp, `${tag}-dry.wav`);
		const send = join(tmp, `${tag}-send.wav`);
		writeFileSync(dry, encodeFloatWav(bus.dry));
		writeFileSync(send, encodeFloatWav(bus.send));
		await run(this.deps.ffmpeg ?? "ffmpeg", ["-y", "-loglevel", "error", "-i", dry, "-i", send, "-i", ir, "-filter_complex",
			"[1:a][2:a]afir=dry=1:wet=1:irnorm=-1[w];[0:a][w]amix=inputs=2:normalize=0:duration=first[m]", "-map", "[m]", "-c:a", "pcm_f32le", out]);
		rmSync(dry);
		rmSync(send);
	}

	/**
	 * Each track of a piece on its own, as the mix has it (its low cut and its share of the room, at the mix's level,
	 * before the master's glue and limiter), cut to the same loop: for muting tracks while listening. Rendered once
	 * per score into `cacheDir` (outside the project: they're for listening, not for the game).
	 */
	async stems(ctx: { cwd: string; progress?(text: string): void }, name: string, cacheDir: string): Promise<{ track: string; file: string }[]> {
		const text = readFileSync(join(this.dir(ctx.cwd, name), "song.json"), "utf8");
		const { song, timeline, errors } = parseSong(JSON.parse(text));
		if (errors.length || !song || !timeline) throw new SongError(errors);
		const group = join(cacheDir, name.replace(/\//g, "~"));
		const out = join(group, `v${STEMS_VERSION}-${songHash(text).slice(0, 16)}`);
		const index = join(out, "stems.json");
		if (existsSync(index)) return JSON.parse(readFileSync(index, "utf8"));
		const soundfont = this.deps.soundfont();
		if (!existsSync(soundfont)) throw new Error(`The SoundFont isn't installed (${soundfont}); run Settings → Asset generation → Install`);
		// Stems of the score's older versions go.
		if (existsSync(group)) for (const d of readdirSync(group)) rmSync(join(group, d), { recursive: true, force: true });
		mkdirSync(out, { recursive: true });
		const ffmpeg = this.deps.ffmpeg ?? "ffmpeg";
		const loop = song.loop !== false;
		const [passes, tail] = loop ? [3, 0] : [1, TAIL_SECONDS];
		const tmp = mkdtempSync(join(tmpdir(), "gs-stems-"));
		try {
			const tracks = timeline.tracks.filter((tr) => tr.notes.length);
			ctx.progress?.(`Rendering ${tracks.length} stem(s)`);
			const wavs = await this.stemWavs(tmp, soundfont, song, timeline, passes, tail, tracks);
			// Each in its room, summed to find the mix's level.
			const sum: Float32Array[] = [];
			const roomed: string[] = [];
			for (const [i, tr] of tracks.entries()) {
				const bus = new StemBus();
				bus.add(decodeWav(readFileSync(wavs[i])).audio, tr);
				rmSync(wavs[i]);
				roomed.push(join(tmp, `track-${i}.wav`));
				await this.room(bus, song.space ?? "room", tmp, roomed[i], `track-${i}`);
				const a = decodeWav(readFileSync(roomed[i])).audio;
				for (let c = 0; c < 2; c++) {
					sum[c] ??= new Float32Array(a[c].length);
					for (let k = 0; k < Math.min(a[c].length, sum[c].length); k++) sum[c][k] += a[c][k];
				}
			}
			const summed = join(tmp, "sum.wav");
			writeFileSync(summed, encodeFloatWav(sum.length ? sum : [new Float32Array(1), new Float32Array(1)]));
			const gain = Math.max(-30, Math.min(30, TARGET_LUFS - (await loudness(ffmpeg, summed))));
			const loopFrames = Math.round(timeline.seconds * RATE);
			const list: { track: string; file: string }[] = [];
			for (const [i, tr] of tracks.entries()) {
				const s16 = join(tmp, `track-${i}-s16.wav`);
				await run(ffmpeg, ["-y", "-loglevel", "error", "-i", roomed[i], "-af", `volume=${gain.toFixed(2)}dB`, "-c:a", "pcm_s16le", s16]);
				let pcm = readWav(readFileSync(s16));
				pcm = loop ? loopFromPasses(pcm, loopFrames) : sliceFrames(pcm, 0, loopFrames + TAIL_SECONDS * RATE);
				const cut = join(tmp, `track-${i}-cut.wav`);
				writeFileSync(cut, writeWav(pcm));
				const file = join(out, `${i}.ogg`);
				await run(ffmpeg, ["-y", "-loglevel", "error", "-i", cut, "-c:a", "libvorbis", "-q:a", "4", file]);
				list.push({ track: tr.id, file });
			}
			writeFileSync(index, JSON.stringify(list));
			return list;
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	/** Validates and renders assets/music/<name>/song.json to <name>.ogg. */
	async render(ctx: { cwd: string; progress?(text: string): void }, p: { name: string }): Promise<RenderResult> {
		const dir = this.dir(ctx.cwd, p.name);
		const file = join(dir, "song.json");
		if (!existsSync(file)) throw new Error(`No ${MUSIC_DIR}/${p.name}/song.json yet: write the score first`);
		const text = readFileSync(file, "utf8");
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch (err) {
			throw new SongError([{ at: "", message: `Not valid JSON: ${(err as Error).message}` }]);
		}
		const { song, timeline, errors } = parseSong(json);
		if (errors.length || !song || !timeline) throw new SongError(errors);
		const soundfont = this.deps.soundfont();
		if (!existsSync(soundfont)) throw new Error(`The SoundFont isn't installed (${soundfont}); run Settings → Asset generation → Install`);

		const loop = song.loop !== false;
		const ogg = join(dir, `${leafName(p.name)}.ogg`);
		const seconds = await this.renderTo(ctx, soundfont, song, timeline, loop, ogg);
		const info: RenderInfo = { song: songHash(text), seconds: Math.round(seconds * 1000) / 1000, loop, renderedAt: new Date().toISOString() };
		writeFileSync(join(dir, "render.json"), `${JSON.stringify(info, null, "\t")}\n`);
		return summarize(song, timeline, `${MUSIC_DIR}/${p.name}/${leafName(p.name)}.ogg`, info);
	}

	/** Renders a parsed song to `ogg` (a seamless loop, or ringing out); resolves its length in seconds. */
	private async renderTo(ctx: { progress?(text: string): void }, soundfont: string, song: Song, timeline: Timeline, loop: boolean, ogg: string): Promise<number> {
		const tmp = mkdtempSync(join(tmpdir(), "gs-music-"));
		try {
			const wav = await this.mix(ctx, tmp, soundfont, song, timeline, loop ? 3 : 1, loop ? 0 : TAIL_SECONDS);
			let audio = readWav(readFileSync(wav));
			const loopFrames = Math.round(timeline.seconds * RATE);
			audio = loop ? loopFromPasses(audio, loopFrames) : sliceFrames(audio, 0, loopFrames + TAIL_SECONDS * RATE);
			const cut = join(tmp, "cut.wav");
			writeFileSync(cut, writeWav(audio));
			ctx.progress?.("Encoding OGG");
			await run(this.deps.ffmpeg ?? "ffmpeg", ["-y", "-loglevel", "error", "-i", cut, "-c:a", "libvorbis", "-q:a", "5", ogg]);
			return audio.frames / RATE;
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	/**
	 * A short phrase on one instrument (a General MIDI name, or "drums"), mixed like a song, for choosing an
	 * instrument by ear. Cached in `cacheDir`.
	 */
	async preview(instrument: string, cacheDir: string): Promise<Buffer> {
		const song = previewSong(instrument);
		const file = join(cacheDir, `v${PREVIEW_VERSION}-${songHash(JSON.stringify(song)).slice(0, 12)}.ogg`);
		if (existsSync(file)) return readFileSync(file);
		const soundfont = this.deps.soundfont();
		if (!existsSync(soundfont)) throw new Error(`The SoundFont isn't installed (${soundfont}); run Settings → Asset generation → Install`);
		const { timeline } = parseSong(song);
		mkdirSync(cacheDir, { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.ogg`;
		await this.renderTo({}, soundfont, song, timeline!, false, tmp);
		renameSync(tmp, file);
		return readFileSync(file);
	}
}

/** Bumped when previews would sound different, so cached ones are rendered again. */
const PREVIEW_VERSION = 1;
/** Bumped when stems would sound different. */
const STEMS_VERSION = 1;

/** The octave an instrument's preview phrase starts in: where it sounds like itself. */
export function previewOctave(program: number): number {
	if ((program >= 32 && program <= 39) || [43, 47, 58].includes(program)) return 2; // basses, contrabass, timpani, tuba
	if ([42, 57, 67, 70].includes(program)) return 3; // cello, trombone, baritone sax, bassoon
	if ((program >= 72 && program <= 79) || program === 40) return 5; // pipes, violin
	return 4;
}

/** A two-bar phrase showing off an instrument: a run up, then a held chord (drums: a short groove). */
export function previewSong(instrument: string): Song {
	const base = { title: `Preview: ${instrument}`, tempo: 104, loop: false, space: "room" as const, humanize: 0.3 };
	if (instrument === "drums") {
		return {
			...base,
			instruments: { kit: { drums: true } },
			sections: { A: { bars: 2, tracks: { kit: "kick:e hat snare hat kick kick snare openhat | kick:e hat snare hat kick:e tom2:s tom3 snare:q" } } },
			arrangement: ["A"],
		};
	}
	const program = gmProgram(instrument);
	if (program === null) throw new Error(`"${instrument}" isn't a General MIDI instrument`);
	const o = previewOctave(program);
	return {
		...base,
		instruments: { part: { program } },
		sections: { A: { bars: 2, tracks: { part: `C${o}:e D${o} E${o} G${o} C${o + 1}:q G${o}:e E${o} | [C${o} E${o} G${o}]:h. r:q` } } },
		arrangement: ["A"],
	};
}

export interface MixOptions {
	fluidsynth?: string;
	ffmpeg?: string;
}

/** Integrated loudness every render is levelled to (a little under the usual -16 for music, to sit under effects). */
export const TARGET_LUFS = -18;

/** ffmpeg's EBU R128 integrated loudness (LUFS) of a file, from its summary. */
export async function loudness(ffmpeg: string, file: string): Promise<number> {
	const out = await run(ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"]);
	const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(out);
	return m && m[1] !== "-inf" ? Number(m[1]) : -70;
}

/** What was rendered, in words an agent can check against its intent (it can't listen). */
function summarize(song: Song, t: Timeline, ogg: string, info: RenderInfo): RenderResult {
	const secPerTick = 60 / song.tempo / TICKS_PER_BEAT;
	return {
		ogg,
		seconds: info.seconds,
		loop: info.loop,
		tempo: song.tempo,
		sections: t.sections.map((s) => ({ name: s.name, bars: s.ticks / t.ticksPerBar, seconds: Math.round(s.ticks * secPerTick * 100) / 100 })),
		tracks: t.tracks.map((tr) => {
			const pitches = tr.notes.map((n) => n.pitch);
			const name = tr.drums ? "drums" : GM_PROGRAMS[tr.program];
			if (!pitches.length) return { id: tr.id, instrument: name, notes: 0 };
			const lo = Math.min(...pitches);
			const hi = Math.max(...pitches);
			return { id: tr.id, instrument: name, notes: tr.notes.length, range: tr.drums ? [...new Set(pitches)].map(drumName).join(" ") : `${pitchName(lo)}-${pitchName(hi)}` };
		}),
	};
}

// --- MIDI ---------------------------------------------------------------------------------------------------

const vlq = (n: number): number[] => {
	const out = [n & 0x7f];
	while ((n >>= 7)) out.unshift(0x80 | (n & 0x7f));
	return out;
};

function chunk(type: string, data: number[]): number[] {
	const len = data.length;
	return [...Buffer.from(type, "ascii"), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data];
}

function trackChunk(events: { tick: number; bytes: number[]; order: number }[]): number[] {
	events.sort((a, b) => a.tick - b.tick || a.order - b.order);
	const data: number[] = [];
	let now = 0;
	for (const e of events) {
		data.push(...vlq(e.tick - now), ...e.bytes);
		now = e.tick;
	}
	data.push(0, 0xff, 0x2f, 0);
	return chunk("MTrk", data);
}

/**
 * Where a note is played and how hard, humanised by `amount` (0-1): a timing nudge shared by a chord's notes (drums
 * and bass keep tighter time), a velocity wobble, and the bar's shape (downbeats lean in, off-beats fall back). It
 * depends only on the note, so every pass of a loop plays the same.
 */
export function humanizeNote(track: { id: string; drums: boolean; program: number }, n: Note, ticksPerBar: number, amount: number): { tick: number; velocity: number } {
	if (!amount) return { tick: n.tick, velocity: n.velocity };
	const tight = track.drums || (track.program >= 32 && track.program <= 39) ? 0.5 : 1;
	const nudge = (unit(`${track.id}@${n.tick}`) * 2 - 1) * 14 * amount * tight + (unit(`${track.id}@${n.tick}:${n.pitch}`) * 2 - 1) * 2 * amount;
	const inBar = n.tick % ticksPerBar;
	const shape = inBar === 0 ? 10 : inBar % TICKS_PER_BEAT === 0 ? 4 : inBar % (TICKS_PER_BEAT / 2) === 0 ? -2 : -6;
	const wobble = (unit(`${track.id}#${n.tick}:${n.pitch}`) * 2 - 1) * 12;
	return { tick: n.tick + Math.round(nudge), velocity: Math.round(n.velocity + (shape + wobble) * amount) };
}

/**
 * A Standard MIDI File (format 1) of the song, repeated `passes` times, with `tailSeconds` of silence after:
 * every track, or only `track` (a stem). Humanised by the song's `humanize` (default 0.4).
 */
export function toMidi(song: Song, t: Timeline, passes = 1, tailSeconds = 0, only?: string): Uint8Array {
	const amount = song.humanize ?? 0.4;
	const usPerBeat = Math.round(60_000_000 / song.tempo);
	const meter = song.meter ?? [4, 4];
	const end = t.totalTicks * passes + Math.round(tailSeconds * (song.tempo / 60) * TICKS_PER_BEAT);
	const conductor = [
		{ tick: 0, order: 0, bytes: [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255] },
		{ tick: 0, order: 0, bytes: [0xff, 0x58, 4, meter[0], Math.log2(meter[1]), 24, 8] },
		// A marker at the very end keeps FluidSynth rendering through the tail.
		{ tick: end, order: 0, bytes: [0xff, 0x06, 3, ...Buffer.from("end")] },
	];
	const chunks = [trackChunk(conductor)];
	for (const tr of t.tracks) {
		if (only !== undefined && tr.id !== only) continue;
		const ch = tr.channel;
		const ev: { tick: number; bytes: number[]; order: number }[] = [
			{ tick: 0, order: 0, bytes: [0xc0 | ch, tr.program] },
			{ tick: 0, order: 0, bytes: [0xb0 | ch, 7, Math.round(tr.volume * 127)] },
			{ tick: 0, order: 0, bytes: [0xb0 | ch, 10, Math.round((tr.pan + 1) * 63.5)] },
			{ tick: 0, order: 0, bytes: [0xb0 | ch, 91, Math.round(tr.reverb * 127)] },
			{ tick: 0, order: 0, bytes: [0xb0 | ch, 93, Math.round(tr.chorus * 127)] },
		];
		const played: { on: number; off: number; pitch: number; velocity: number }[] = [];
		for (let p = 0; p < passes; p++) {
			const offset = p * t.totalTicks;
			for (const n of tr.notes) {
				const h = humanizeNote(tr, n, t.ticksPerBar, amount);
				const on = Math.max(0, offset + h.tick);
				played.push({ on, off: Math.max(on + 1, offset + h.tick + n.ticks), pitch: n.pitch, velocity: h.velocity });
			}
		}
		// A note nudged early mustn't start before the same pitch's previous note ends (its note-off would cut it).
		played.sort((a, b) => a.pitch - b.pitch || a.on - b.on);
		for (let i = 1; i < played.length; i++) {
			const prev = played[i - 1];
			if (prev.pitch === played[i].pitch && prev.off > played[i].on) prev.off = Math.max(prev.on + 1, played[i].on);
		}
		for (const n of played) {
			// Note-offs sort before note-ons at the same tick, so repeated notes retrigger.
			ev.push({ tick: n.on, order: 2, bytes: [0x90 | ch, n.pitch, Math.min(127, Math.max(1, n.velocity))] });
			ev.push({ tick: n.off, order: 1, bytes: [0x80 | ch, n.pitch, 0] });
		}
		chunks.push(trackChunk(ev));
	}
	const header = chunk("MThd", [0, 1, 0, chunks.length, (TICKS_PER_BEAT >> 8) & 255, TICKS_PER_BEAT & 255]);
	return Uint8Array.from([...header, ...chunks.flat()]);
}

// --- WAV ----------------------------------------------------------------------------------------------------

interface Pcm {
	channels: number;
	rate: number;
	bits: number;
	frames: number;
	data: Buffer;
}

export function readWav(buf: Buffer): Pcm {
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
	let fmt: { channels: number; rate: number; bits: number } | null = null;
	for (let i = 12; i + 8 <= buf.length; ) {
		const id = buf.toString("ascii", i, i + 4);
		const size = buf.readUInt32LE(i + 4);
		if (id === "fmt ") fmt = { channels: buf.readUInt16LE(i + 10), rate: buf.readUInt32LE(i + 12), bits: buf.readUInt16LE(i + 22) };
		if (id === "data") {
			if (!fmt) throw new Error("WAV data before its format");
			const data = buf.subarray(i + 8, Math.min(buf.length, i + 8 + size));
			return { ...fmt, data, frames: Math.floor(data.length / ((fmt.bits / 8) * fmt.channels)) };
		}
		i += 8 + size + (size & 1);
	}
	throw new Error("WAV without data");
}

/** Frames [from, to), padded with silence past the end. */
function sliceFrames(pcm: Pcm, from: number, to: number): Pcm {
	const frame = (pcm.bits / 8) * pcm.channels;
	const out = Buffer.alloc((to - from) * frame);
	pcm.data.copy(out, 0, Math.min(pcm.data.length, from * frame), Math.min(pcm.data.length, to * frame));
	return { ...pcm, data: out, frames: to - from };
}

const SEAM_FADE_SECONDS = 0.03;

/**
 * A seamless loop from three rendered passes: the middle pass, whose first 30 ms are crossfaded from what
 * really followed the middle pass (the start of pass three) into its own start. FluidSynth starts notes on
 * 64-sample block boundaries, so unless the loop is a whole number of blocks, passes two and three differ by up
 * to a block; the crossfade makes the jump from the loop's end back to its start land on the true continuation.
 */
export function loopFromPasses(pcm: Pcm, loopFrames: number): Pcm {
	if (pcm.bits !== 16) throw new Error(`Expected 16-bit audio from FluidSynth, got ${pcm.bits}-bit`);
	const loop = sliceFrames(pcm, loopFrames, 2 * loopFrames);
	const next = sliceFrames(pcm, 2 * loopFrames, 2 * loopFrames + Math.round(SEAM_FADE_SECONDS * pcm.rate));
	const fade = next.frames;
	for (let i = 0; i < fade; i++) {
		const t = ((i + 0.5) / fade) * (Math.PI / 2); // equal-power
		for (let c = 0; c < pcm.channels; c++) {
			const at = (i * pcm.channels + c) * 2;
			const v = next.data.readInt16LE(at) * Math.cos(t) + loop.data.readInt16LE(at) * Math.sin(t);
			loop.data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), at);
		}
	}
	return loop;
}

export function writeWav(pcm: Pcm): Buffer {
	const h = Buffer.alloc(44);
	const frame = (pcm.bits / 8) * pcm.channels;
	h.write("RIFF", 0, "ascii");
	h.writeUInt32LE(36 + pcm.data.length, 4);
	h.write("WAVEfmt ", 8, "ascii");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(pcm.bits === 32 ? 3 : 1, 20);
	h.writeUInt16LE(pcm.channels, 22);
	h.writeUInt32LE(pcm.rate, 24);
	h.writeUInt32LE(pcm.rate * frame, 28);
	h.writeUInt16LE(frame, 32);
	h.writeUInt16LE(pcm.bits, 34);
	h.write("data", 36, "ascii");
	h.writeUInt32LE(pcm.data.length, 40);
	return Buffer.concat([h, pcm.data]);
}

/** Runs a command; resolves the end of its stderr (where ffmpeg's measurements go). */
function run(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
		proc.on("error", (e) => reject(new Error(`${cmd} isn't available: ${e.message}`)));
		proc.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} failed (exit ${code}): ${err.trim().split("\n").slice(-3).join(" ")}`))));
	});
}

/** The Music section's requests (see studio-requests.ts). */
export function musicRequests(music: MusicPipeline): StudioRequestHandlers {
	type Edit = Parameters<MusicPipeline["edit"]>[1];
	const scopes = (name: string) => [{ path: `assets/music/${name}` }];
	return {
		render_song: handler((ctx, p: { name: string }) => music.render(ctx, p), (p) => ({ label: `Music ${p.name}: rendered`, scopes: scopes(p.name) })),
		edit_song: handler((ctx, p: Edit) => music.edit(ctx, p), (p) => ({ label: `Music ${p.name}: ${describeSongEdit(p)}`, scopes: scopes(p.name) })),
	};
}

/** What an edit_song changed, for the history ("space hall, tempo 96"). */
function describeSongEdit(p: Parameters<MusicPipeline["edit"]>[1]): string {
	const parts = [
		p.space !== undefined && `space ${p.space}`,
		p.tempo !== undefined && `tempo ${p.tempo}`,
		p.humanize !== undefined && `feel ${p.humanize}`,
		...Object.entries(p.instruments ?? {}).map(
			([id, c]) => `${id} ${[c.program !== undefined && String(c.program), c.volume !== undefined && `volume ${c.volume}`].filter(Boolean).join(", ")}`,
		),
	].filter(Boolean);
	return parts.join(", ") || "edited";
}
