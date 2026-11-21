/**
 * The studio's song format (`assets/music/<name>/song.json`): a multi-track score an agent writes and the studio
 * renders. See the vault note "M5 Music" and skills/music-composition/SKILL.md (the format reference agents read).
 *
 * Shared by the renderer (arrangement view), the main process (MIDI + rendering) and agents' tools, so everyone
 * gets the same validation errors.
 */

export interface Song {
	title: string;
	/** Quarter notes per minute. */
	tempo: number;
	/** [beats, beat unit], default [4, 4]. */
	meter?: [number, number];
	/** Informational, e.g. "D minor". */
	key?: string;
	/** Rendered as a seamless loop (default true). */
	loop?: boolean;
	/** How a produced version should sound (a caption for the audio model), e.g. "whimsical folk, wooden flute". */
	style?: string;
	/**
	 * How much it's played like people rather than a sequencer, 0-1 (default 0.4): notes a little early or late, uneven
	 * velocities, downbeats leaning in. 0 is exactly on the grid.
	 */
	humanize?: number;
	/** The room it's played in (the reverb tracks' `reverb` sends reach): "dry", "room" (default) or "hall". */
	space?: Space;
	/** Track id → instrument. Track order is this object's key order. */
	instruments: Record<string, Instrument>;
	/** Section name → its bars and each track's pattern. */
	sections: Record<string, Section>;
	/** Section names in playing order; list a section again to repeat it. */
	arrangement: string[];
}

export interface Instrument {
	/** A General MIDI instrument name ("flute", "string ensemble 1") or number 0-127. Not for drums. */
	program?: string | number;
	/** A drum kit track (General MIDI channel 10): patterns use drum names instead of pitches. */
	drums?: boolean;
	/** 0-1, default 0.8. */
	volume?: number;
	/** -1 (left) to 1 (right), default 0. */
	pan?: number;
	/** 0-1 reverb send, default 0.3. */
	reverb?: number;
	/** 0-1 chorus (a slightly detuned double: lush, wide), default 0.25 for strings and pads, else 0. */
	chorus?: number;
}

export const SPACES = ["dry", "room", "hall"] as const;
export type Space = (typeof SPACES)[number];

export interface Section {
	bars: number;
	/** Track id → pattern. A track without a pattern is silent in this section. */
	tracks: Record<string, string>;
}

export const TICKS_PER_BEAT = 480;

export interface Note {
	tick: number;
	ticks: number;
	pitch: number;
	velocity: number;
}

export interface TimelineTrack {
	id: string;
	drums: boolean;
	/** General MIDI program 0-127 (0 for drums). */
	program: number;
	channel: number;
	volume: number;
	pan: number;
	reverb: number;
	chorus: number;
	notes: Note[];
}

export interface Timeline {
	tracks: TimelineTrack[];
	/** Where each arrangement entry starts. */
	sections: { name: string; tick: number; ticks: number }[];
	ticksPerBar: number;
	totalTicks: number;
	seconds: number;
}

export interface SongProblem {
	/** Where: "sections.A.tracks.lead bar 3", "instruments.lead.program", … */
	at: string;
	message: string;
}

export interface ParsedSong {
	song: Song | null;
	timeline: Timeline | null;
	errors: SongProblem[];
}

/** General MIDI programs, 0-127. */
export const GM_PROGRAMS = [
	"acoustic grand piano", "bright acoustic piano", "electric grand piano", "honky-tonk piano", "electric piano 1", "electric piano 2", "harpsichord", "clavinet",
	"celesta", "glockenspiel", "music box", "vibraphone", "marimba", "xylophone", "tubular bells", "dulcimer",
	"drawbar organ", "percussive organ", "rock organ", "church organ", "reed organ", "accordion", "harmonica", "tango accordion",
	"acoustic guitar nylon", "acoustic guitar steel", "electric guitar jazz", "electric guitar clean", "electric guitar muted", "overdriven guitar", "distortion guitar", "guitar harmonics",
	"acoustic bass", "electric bass finger", "electric bass pick", "fretless bass", "slap bass 1", "slap bass 2", "synth bass 1", "synth bass 2",
	"violin", "viola", "cello", "contrabass", "tremolo strings", "pizzicato strings", "orchestral harp", "timpani",
	"string ensemble 1", "string ensemble 2", "synth strings 1", "synth strings 2", "choir aahs", "voice oohs", "synth voice", "orchestra hit",
	"trumpet", "trombone", "tuba", "muted trumpet", "french horn", "brass section", "synth brass 1", "synth brass 2",
	"soprano sax", "alto sax", "tenor sax", "baritone sax", "oboe", "english horn", "bassoon", "clarinet",
	"piccolo", "flute", "recorder", "pan flute", "blown bottle", "shakuhachi", "whistle", "ocarina",
	"lead 1 square", "lead 2 sawtooth", "lead 3 calliope", "lead 4 chiff", "lead 5 charang", "lead 6 voice", "lead 7 fifths", "lead 8 bass and lead",
	"pad 1 new age", "pad 2 warm", "pad 3 polysynth", "pad 4 choir", "pad 5 bowed", "pad 6 metallic", "pad 7 halo", "pad 8 sweep",
	"fx 1 rain", "fx 2 soundtrack", "fx 3 crystal", "fx 4 atmosphere", "fx 5 brightness", "fx 6 goblins", "fx 7 echoes", "fx 8 sci-fi",
	"sitar", "banjo", "shamisen", "koto", "kalimba", "bagpipe", "fiddle", "shanai",
	"tinkle bell", "agogo", "steel drums", "woodblock", "taiko drum", "melodic tom", "synth drum", "reverse cymbal",
	"guitar fret noise", "breath noise", "seashore", "bird tweet", "telephone ring", "helicopter", "applause", "gunshot",
] as const;

/** Drum names → General MIDI percussion notes (channel 10). */
export const DRUMS: Record<string, number> = {
	kick: 36, kick2: 35, snare: 38, snare2: 40, rim: 37, clap: 39, hat: 42, pedalhat: 44, openhat: 46,
	crash: 49, crash2: 57, ride: 51, ridebell: 53, splash: 55, china: 52,
	tom1: 50, tom2: 48, tom3: 47, tom4: 45, tom5: 43, tom6: 41,
	tambourine: 54, cowbell: 56, shaker: 70, cabasa: 69, claves: 75, woodblock: 76, woodblock2: 77, triangle: 81, opentriangle: 80,
	bongo: 60, bongo2: 61, conga: 63, conga2: 64, congamute: 62, timbale: 65, timbale2: 66, agogo: 67, agogo2: 68,
	guiro: 74, whistle: 71, vibraslap: 58, chimes: 84, castanets: 85, sticks: 31,
};

const DURATIONS: Record<string, number> = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 0.125 };
const NOTE_BASE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const DEFAULT_VELOCITY = 90;
const ACCENT = 25;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A General MIDI program from a name (forgiving about case and punctuation) or number. */
export function gmProgram(program: string | number | undefined): number | null {
	if (program === undefined) return 0;
	if (typeof program === "number") return Number.isInteger(program) && program >= 0 && program <= 127 ? program : null;
	const n = norm(program);
	const exact = GM_PROGRAMS.findIndex((p) => norm(p) === n);
	if (exact >= 0) return exact;
	// "string ensemble" → "string ensemble 1", "nylon guitar" → "acoustic guitar nylon": every word must appear.
	const words = n.split(" ");
	const partial = GM_PROGRAMS.findIndex((p) => words.every((w) => norm(p).split(" ").includes(w)));
	return partial >= 0 ? partial : null;
}

/** Closest General MIDI names, for error messages. */
function suggestPrograms(program: string): string {
	const words = norm(program).split(" ").filter((w) => w.length >= 3);
	const near = (a: string, b: string) => b.length >= 3 && (a.startsWith(b) || b.startsWith(a));
	const scored = GM_PROGRAMS.map((p) => [p, words.filter((w) => norm(p).split(" ").some((g) => near(w, g))).length] as const)
		.filter(([, s]) => s > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([p]) => `"${p}"`);
	return scored.length ? ` Did you mean ${scored.join(", ")}?` : "";
}

/** "C4" → 60, "F#3" → 54, "Bb2" → 46. */
export function pitchOf(token: string): number | null {
	const m = /^([a-gA-G])(#|b)?(-?\d)$/.exec(token);
	if (!m) return null;
	const p = (Number(m[3]) + 1) * 12 + NOTE_BASE[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
	return p >= 0 && p <= 127 ? p : null;
}

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const pitchName = (p: number) => `${NAMES[p % 12]}${Math.floor(p / 12) - 1}`;
export const drumName = (p: number) => Object.entries(DRUMS).find(([, n]) => n === p)?.[0] ?? String(p);

interface ParsedEvent {
	pitches: number[];
	beats: number;
	velocity: number;
	tie: boolean;
}

/** One pattern string → bars of events, or a problem. `beatsPerBar` is in quarter notes. */
export function parsePattern(pattern: string, drums: boolean, beatsPerBar: number): { bars: ParsedEvent[][]; error?: string } {
	const bars: ParsedEvent[][] = [];
	let beats = 1; // the default duration carries over: "D4:q E4 F4" is three quarters
	const barTexts = pattern.split("|");
	for (let b = 0; b < barTexts.length; b++) {
		const text = barTexts[b].trim();
		if (text === "%") {
			if (!bars.length) return { bars, error: `bar ${b + 1}: "%" repeats the previous bar, but there isn't one` };
			bars.push(bars[bars.length - 1]);
			continue;
		}
		const events: ParsedEvent[] = [];
		const tokens = text.match(/\[[^\]]*\][^\s\[]*|[^\s]+/g) ?? [];
		for (const token of tokens) {
			const m = /^(\[[^\]]*\]|[^:!?~]+)(?::([whqest])(\.?)(3?))?([!?~]*)$/.exec(token);
			if (!m) return { bars, error: `bar ${b + 1}: can't read "${token}" (expected e.g. D4:q, [C4 E4 G4]:h, r:e, ${drums ? "kick:q" : "F#3:e."})` };
			const [, head, dur, dot, triplet, mods] = m;
			if (dur) beats = DURATIONS[dur] * (dot ? 1.5 : 1) * (triplet ? 2 / 3 : 1);
			let pitches: number[] = [];
			if (head !== "r") {
				const names = head.startsWith("[") ? head.slice(1, -1).trim().split(/\s+/) : [head];
				for (const name of names) {
					const p = drums ? (DRUMS[name.toLowerCase()] ?? (/^\d+$/.test(name) ? Number(name) : null)) : pitchOf(name);
					if (p === null)
						return {
							bars,
							error: drums
								? `bar ${b + 1}: "${name}" isn't a drum (use ${Object.keys(DRUMS).slice(0, 9).join(", ")}, …)`
								: `bar ${b + 1}: "${name}" isn't a pitch (use a note name and octave: C4 is middle C, F#3, Bb2)`,
						};
					pitches.push(p);
				}
			}
			const velocity = DEFAULT_VELOCITY + (mods.includes("!") ? ACCENT : 0) - (mods.includes("?") ? ACCENT : 0);
			events.push({ pitches, beats, velocity, tie: mods.includes("~") });
		}
		const total = events.reduce((s, e) => s + e.beats, 0);
		if (barTexts.length > 1 && Math.abs(total - beatsPerBar) > 1e-6) {
			return { bars, error: `bar ${b + 1} has ${+total.toFixed(3)} beats, but a bar is ${beatsPerBar}` };
		}
		bars.push(events);
	}
	return { bars };
}

/** Validates a song and lays every note out in ticks. */
export function parseSong(input: unknown): ParsedSong {
	const errors: SongProblem[] = [];
	const fail = (at: string, message: string) => errors.push({ at, message });
	if (!input || typeof input !== "object") return { song: null, timeline: null, errors: [{ at: "", message: "A song is a JSON object" }] };
	const s = input as Song;
	if (typeof s.title !== "string" || !s.title.trim()) fail("title", "Give the song a title");
	if (typeof s.tempo !== "number" || s.tempo < 20 || s.tempo > 300) fail("tempo", "tempo is quarter notes per minute, 20-300");
	const meter = s.meter ?? [4, 4];
	if (!Array.isArray(meter) || meter.length !== 2 || ![1, 2, 4, 8, 16].includes(meter[1]) || !(meter[0] >= 1 && meter[0] <= 16))
		fail("meter", "meter is [beats, unit], e.g. [4, 4], [3, 4], [6, 8]");
	const beatsPerBar = (meter[0] * 4) / meter[1];
	if (!s.instruments || typeof s.instruments !== "object" || !Object.keys(s.instruments).length) fail("instruments", "Add at least one instrument");
	if (!s.sections || typeof s.sections !== "object" || !Object.keys(s.sections).length) fail("sections", "Add at least one section");
	if (!Array.isArray(s.arrangement) || !s.arrangement.length) fail("arrangement", "arrangement lists section names in playing order");
	if (s.humanize !== undefined && (typeof s.humanize !== "number" || s.humanize < 0 || s.humanize > 1)) fail("humanize", "humanize is 0 (exactly on the grid) to 1");
	if (s.space !== undefined && !SPACES.includes(s.space)) fail("space", `space is one of ${SPACES.join(", ")}`);
	if (errors.length) return { song: null, timeline: null, errors };

	// Instruments → tracks and MIDI channels (drums on channel 10, i.e. 9).
	const tracks: TimelineTrack[] = [];
	let channel = 0;
	for (const [id, inst] of Object.entries(s.instruments)) {
		const at = `instruments.${id}`;
		const drums = !!inst.drums;
		const program = drums ? 0 : gmProgram(inst.program);
		if (program === null) {
			fail(`${at}.program`, `"${inst.program}" isn't a General MIDI instrument.${typeof inst.program === "string" ? suggestPrograms(inst.program) : " Use 0-127."}`);
			continue;
		}
		if (!drums && inst.program === undefined) fail(`${at}.program`, "Choose an instrument (a General MIDI name like \"flute\") or set drums: true");
		for (const [field, lo, hi] of [["volume", 0, 1], ["pan", -1, 1], ["reverb", 0, 1], ["chorus", 0, 1]] as const) {
			const v = inst[field];
			if (v !== undefined && (typeof v !== "number" || v < lo || v > hi)) fail(`${at}.${field}`, `${field} is ${lo} to ${hi}`);
		}
		if (!drums && channel === 9) channel++;
		if (!drums && channel > 15) {
			fail(at, "At most 15 melodic tracks (plus drums)");
			continue;
		}
		// Strings (40-51) and synth pads (88-95) sound thin without a little chorus.
		const lush = !drums && ((program >= 40 && program <= 51) || (program >= 88 && program <= 95));
		tracks.push({
			id,
			drums,
			program,
			channel: drums ? 9 : channel++,
			volume: inst.volume ?? 0.8,
			pan: inst.pan ?? 0,
			reverb: inst.reverb ?? 0.3,
			chorus: inst.chorus ?? (lush ? 0.25 : 0),
			notes: [],
		});
	}

	// Sections: parse each pattern once.
	const ticksPerBar = beatsPerBar * TICKS_PER_BEAT;
	const parsed = new Map<string, Map<string, ParsedEvent[]>>();
	for (const [name, sec] of Object.entries(s.sections)) {
		const at = `sections.${name}`;
		if (!Number.isInteger(sec.bars) || sec.bars < 1) {
			fail(`${at}.bars`, "bars is a whole number of bars, at least 1");
			continue;
		}
		const byTrack = new Map<string, ParsedEvent[]>();
		for (const [trackId, pattern] of Object.entries(sec.tracks ?? {})) {
			const track = tracks.find((t) => t.id === trackId);
			if (!track) {
				if (!(trackId in s.instruments)) fail(`${at}.tracks.${trackId}`, `No instrument "${trackId}" (instruments: ${Object.keys(s.instruments).join(", ")})`);
				continue;
			}
			if (typeof pattern !== "string") {
				fail(`${at}.tracks.${trackId}`, "A pattern is a string of notes");
				continue;
			}
			const { bars, error } = parsePattern(pattern, track.drums, beatsPerBar);
			if (error) {
				fail(`${at}.tracks.${trackId}`, error);
				continue;
			}
			// Without bar lines a pattern is one run of notes; it must still come to whole bars.
			const events = bars.flat();
			const barCount = events.reduce((t, e) => t + e.beats, 0) / beatsPerBar;
			if (Math.abs(barCount - Math.round(barCount)) > 1e-6 || barCount < 1 - 1e-6) {
				fail(`${at}.tracks.${trackId}`, `${+(barCount * beatsPerBar).toFixed(3)} beats isn't a whole number of ${beatsPerBar}-beat bars`);
				continue;
			}
			const n = Math.round(barCount);
			if (n > sec.bars || sec.bars % n !== 0) {
				fail(`${at}.tracks.${trackId}`, `${n} bar(s) of pattern don't fill the section's ${sec.bars} bars (a pattern repeats to fill its section when ${sec.bars} is a multiple of its length)`);
				continue;
			}
			byTrack.set(trackId, events);
		}
		parsed.set(name, byTrack);
	}
	for (const [i, name] of (s.arrangement ?? []).entries()) {
		if (!(name in (s.sections ?? {}))) fail(`arrangement[${i}]`, `No section "${name}" (sections: ${Object.keys(s.sections).join(", ")})`);
	}
	if (errors.length) return { song: s, timeline: null, errors };

	// Lay the arrangement out in ticks.
	const sections: Timeline["sections"] = [];
	let tick = 0;
	const ties = new Map<string, Map<number, Note>>(); // track → pitch → the note a "~" carries on
	for (const name of s.arrangement) {
		const sec = s.sections[name];
		const ticks = sec.bars * ticksPerBar;
		sections.push({ name, tick, ticks });
		for (const track of tracks) {
			const events = parsed.get(name)?.get(track.id);
			if (!events) continue;
			const tied = ties.get(track.id) ?? new Map<number, Note>();
			ties.set(track.id, tied);
			const length = Math.round(events.reduce((t, e) => t + e.beats, 0) * TICKS_PER_BEAT);
			for (let start = tick; start < tick + ticks; start += length) {
				let t = start;
				for (const e of events) {
					const dur = Math.round(e.beats * TICKS_PER_BEAT);
					const carried = new Map(tied);
					tied.clear();
					for (const p of e.pitches) {
						const prev = carried.get(p);
						const note = prev && prev.tick + prev.ticks === t ? ((prev.ticks += dur), prev) : { tick: t, ticks: dur, pitch: p, velocity: e.velocity };
						if (note !== prev) track.notes.push(note);
						if (e.tie) tied.set(p, note);
					}
					t += dur;
				}
			}
		}
		tick += ticks;
	}
	for (const t of tracks) t.notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
	return { song: s, errors, timeline: { tracks, sections, ticksPerBar, totalTicks: tick, seconds: (tick / TICKS_PER_BEAT) * (60 / s.tempo) } };
}
