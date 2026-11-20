/**
 * The studio's sound format (`assets/sounds/<name>/sound.json`): how a sound effect is made. Layers (generated
 * takes and synthesised tones) are mixed, then processed, into one or more variants: `<name>.ogg`,
 * `<name>-2.ogg`… See the vault note "M7 Sound Effects" and skills/sound-design/SKILL.md (the reference agents read).
 *
 * Shared by the Sound Effects section, the renderer (src/main/sounds.ts) and agents' tools, so everyone gets the
 * same validation errors.
 */

export interface Sound {
	/** What it's for and how it's used ("the goblin's footsteps on grass, one per half walk cycle"). */
	notes?: string;
	/** A seamless loop (ambiences): the end is crossfaded into the start, and there are no fades. Default false. */
	loop?: boolean;
	/** Mixed together, each at its `at` offset. */
	layers: Layer[];
	/** Cut silence (quieter than `threshold` dB below the mix's peak, default -50) from both ends; false keeps it. Default true. */
	trim?: boolean | { threshold?: number };
	/** Seconds: cut the sound after this long (after trimming, before the fade-out), e.g. one footstep out of a take. */
	length?: number;
	/** Semitones, tape-style (lower is also longer). */
	pitch?: number;
	/** Hz: cut below / above. */
	highpass?: number;
	lowpass?: number;
	/** 0-1: how much room reverb (adds a tail). */
	reverb?: number;
	/** Peak level in dBFS after processing (default -1). Balance sounds against each other in the game with volume. */
	peak?: number;
	/** Seconds (default in 0.005, out 0.05). Not for loops. */
	fade?: { in?: number; out?: number };
	/** A loop's crossfade in seconds (default a quarter of its length, at most 2). */
	crossfade?: number;
}

export interface Layer {
	/** Names the layer's takes (`takes/<name>-<seed>.wav`); generate layers default to "main". */
	name?: string;
	/** A generated layer: Stable Audio Open Small, from a prompt, up to 11 seconds. */
	generate?: { prompt: string; seconds: number };
	/** The generated takes used, by seed: one per variant, or one for every variant. */
	takes?: number[];
	/** A synthesised layer. */
	synth?: Synth;
	/** dB (default 0). */
	gain?: number;
	/** Seconds from the start of the sound (default 0). */
	at?: number;
}

export type Wave = "sine" | "square" | "saw" | "triangle" | "noise";
export const WAVES: readonly Wave[] = ["sine", "square", "saw", "triangle", "noise"];

export interface Synth {
	wave: Wave;
	seconds: number;
	/** Hz (not for noise). */
	freq?: number;
	/** Hz at the end: an exponential sweep from `freq`. */
	to?: number;
	/** Seconds to full level (default 0.005). */
	attack?: number;
	/** Seconds from full level to -60 dB after the attack (default: the rest of the layer). */
	decay?: number;
	/** Pitch wobble: rate in Hz, depth in semitones. */
	vibrato?: { rate: number; depth: number };
	/** Hz, for shaping noise. */
	highpass?: number;
	lowpass?: number;
}

export interface SoundProblem {
	at: string;
	message: string;
}

export const MAX_GENERATE_SECONDS = 11;
export const SOUND_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The layer's name for its takes. */
export const layerName = (layer: Layer, index: number) => layer.name ?? (layer.generate ? "main" : `layer-${index + 1}`);

/** How many variants a sound renders: the longest `takes` list (1 without generated layers). */
export function variantCount(sound: Sound): number {
	return Math.max(1, ...sound.layers.map((l) => (l.generate ? (l.takes?.length ?? 0) : 1)));
}

/** The variant files, repo-relative to the sound's folder: `<name>.ogg`, `<name>-2.ogg`… */
export const variantFile = (name: string, i: number) => (i === 0 ? `${name}.ogg` : `${name}-${i + 1}.ogg`);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Every problem in a sound, with where it is; an empty list means it renders. */
export function validateSound(json: unknown): SoundProblem[] {
	const out: SoundProblem[] = [];
	const bad = (at: string, message: string) => out.push({ at, message });
	if (!isObj(json)) return [{ at: "", message: "sound.json must be an object" }];
	const s = json as Record<string, unknown>;
	const known = ["notes", "loop", "layers", "trim", "length", "pitch", "highpass", "lowpass", "reverb", "peak", "fade", "crossfade"];
	for (const k of Object.keys(s)) if (!known.includes(k)) bad(k, `Unknown field (fields: ${known.join(", ")})`);
	if (!Array.isArray(s.layers) || s.layers.length === 0) {
		bad("layers", "At least one layer (generate or synth)");
		return out;
	}
	const range = (at: string, v: unknown, lo: number, hi: number, unit = "") => {
		if (v === undefined) return;
		if (!num(v) || (v as number) < lo || (v as number) > hi) bad(at, `Must be a number from ${lo} to ${hi}${unit}`);
	};
	range("length", s.length, 0.01, 60, " seconds");
	range("pitch", s.pitch, -24, 24, " semitones");
	range("highpass", s.highpass, 10, 20000, " Hz");
	range("lowpass", s.lowpass, 10, 20000, " Hz");
	range("reverb", s.reverb, 0, 1);
	range("peak", s.peak, -60, 0, " dBFS");
	range("crossfade", s.crossfade, 0.01, 10, " seconds");
	if (s.trim !== undefined && typeof s.trim !== "boolean") {
		if (!isObj(s.trim)) bad("trim", "true, false or {threshold}");
		else range("trim.threshold", s.trim.threshold, -100, -10, " dB below the peak");
	}
	if (s.fade !== undefined) {
		if (!isObj(s.fade)) bad("fade", "{in, out} in seconds");
		else {
			range("fade.in", s.fade.in, 0, 10, " seconds");
			range("fade.out", s.fade.out, 0, 10, " seconds");
		}
	}
	const counts = new Set<number>();
	const names = new Set<string>();
	s.layers.forEach((raw, i) => {
		const at = `layers[${i}]`;
		if (!isObj(raw)) return bad(at, "A layer is an object with generate or synth");
		const l = raw as Layer;
		const keys = ["name", "generate", "takes", "synth", "gain", "at"];
		for (const k of Object.keys(raw)) if (!keys.includes(k)) bad(`${at}.${k}`, `Unknown field (fields: ${keys.join(", ")})`);
		if (!!l.generate === !!l.synth) return bad(at, "Exactly one of generate or synth");
		if (l.name !== undefined && (typeof l.name !== "string" || !SOUND_NAME.test(l.name))) bad(`${at}.name`, "lower-kebab-case, e.g. \"creak\"");
		const name = layerName(l, i);
		if (names.has(name)) bad(`${at}.name`, `Another layer is already called "${name}"`);
		names.add(name);
		range(`${at}.gain`, l.gain, -60, 24, " dB");
		range(`${at}.at`, l.at, 0, 60, " seconds");
		if (l.generate) {
			const g = l.generate as unknown as Record<string, unknown>;
			if (typeof g.prompt !== "string" || !g.prompt.trim()) bad(`${at}.generate.prompt`, "Describe the sound");
			range(`${at}.generate.seconds`, g.seconds, 0.1, MAX_GENERATE_SECONDS, " seconds (the model's limit)");
			if (g.seconds === undefined) bad(`${at}.generate.seconds`, "How long to generate");
			if (!Array.isArray(l.takes) || l.takes.length === 0) bad(`${at}.takes`, "Pick at least one take by its seed (generate_sound_takes lists them)");
			else if (!l.takes.every((t) => Number.isInteger(t) && t >= 0)) bad(`${at}.takes`, "Takes are seeds: whole numbers");
			else if (l.takes.length > 1) counts.add(l.takes.length);
		} else if (l.synth) {
			if (l.takes !== undefined) bad(`${at}.takes`, "Only generated layers have takes");
			const y = l.synth as unknown as Record<string, unknown>;
			if (!WAVES.includes(y.wave as Wave)) bad(`${at}.synth.wave`, `One of ${WAVES.join(", ")}`);
			if (y.seconds === undefined) bad(`${at}.synth.seconds`, "How long it lasts");
			range(`${at}.synth.seconds`, y.seconds, 0.005, 30, " seconds");
			if (y.wave !== "noise" && y.freq === undefined) bad(`${at}.synth.freq`, "A frequency in Hz");
			range(`${at}.synth.freq`, y.freq, 20, 20000, " Hz");
			range(`${at}.synth.to`, y.to, 20, 20000, " Hz");
			range(`${at}.synth.attack`, y.attack, 0, 30, " seconds");
			range(`${at}.synth.decay`, y.decay, 0.001, 60, " seconds");
			range(`${at}.synth.highpass`, y.highpass, 10, 20000, " Hz");
			range(`${at}.synth.lowpass`, y.lowpass, 10, 20000, " Hz");
			if (y.vibrato !== undefined) {
				const v = y.vibrato as Record<string, unknown>;
				if (!isObj(v) || !num(v.rate) || !num(v.depth)) bad(`${at}.synth.vibrato`, "{rate (Hz), depth (semitones)}");
			}
		}
	});
	if (counts.size > 1) bad("layers", `Generated layers pick different numbers of takes (${[...counts].join(", ")}): give each layer one take or the same number, one per variant`);
	return out;
}

/** Parses sound.json text: the sound, or every problem. */
export function parseSound(text: string): { sound: Sound | null; problems: SoundProblem[] } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		return { sound: null, problems: [{ at: "", message: `Not valid JSON: ${(err as Error).message}` }] };
	}
	const problems = validateSound(json);
	return { sound: problems.length ? null : (json as Sound), problems };
}
