/**
 * The studio's sound format (`assets/sounds/<name>/sound.json`): how a sound effect is made. Generated takes
 * (`takes/<id>.wav`, how each was made in takes/takes.json) are the raw material; each **variant** is one finished
 * file the game plays (`<name>.ogg`, `<name>-2.ogg`…; it picks one at random), mixed from its own layers (usually
 * one take; sometimes several takes, or a synth tone) and processed. Every layer is trimmed and levelled before its
 * gain applies, so gains compare layers as heard. Processing is shared by the sound's variants, and a variant can
 * override any of it. See the vault note "M7 Sound Effects" and skills/sound-design/SKILL.md (the agents' reference).
 *
 * Shared by the Sound Effects section, the renderer (src/main/sounds.ts) and agents' tools, so everyone gets the
 * same validation errors.
 */

import { compact } from "./scene";

/** Processing, applied to each variant's mix in this order: trim, length, pitch, filters, reverb, loop, level, fades. */
export interface Processing {
	/** Cut silence (quieter than `threshold` dB below the peak, default -50) from both ends; false keeps it. Default true. */
	trim?: boolean | { threshold?: number };
	/** Seconds: cut after this long (after trimming, before the fade-out), e.g. one footstep out of a take. */
	length?: number;
	/** Semitones, tape-style (lower is also longer). */
	pitch?: number;
	/** Hz: cut below / above. */
	highpass?: number;
	lowpass?: number;
	/** 0-1: how much room reverb (adds a tail). */
	reverb?: number;
	/** Peak level in dBFS (default -1). Balance sounds against each other in the game with volume. */
	peak?: number;
	/** Seconds (default in 0.005, out 0.05). Not for loops. */
	fade?: { in?: number; out?: number };
	/** A loop's crossfade in seconds (default a quarter of its length, at most 2). */
	crossfade?: number;
}

export interface Sound extends Processing {
	/** What it's for and how it's used ("the goblin's footsteps on grass, one per half walk cycle"). */
	notes?: string;
	/** A seamless loop (ambiences): the end is crossfaded into the start, and there are no fades. Default false. */
	loop?: boolean;
	/** The files the game plays, in order: `<name>.ogg`, `<name>-2.ogg`… */
	variants: Variant[];
}

/** One file the game plays: its layers mixed, then the sound's processing with this variant's overrides. */
export interface Variant extends Processing {
	layers: Layer[];
}

export type Layer = TakeLayer | SynthLayer;

interface LayerMix {
	/** dB against the variant's other layers, each levelled first (default 0). */
	gain?: number;
	/** Seconds from the start of the variant (default 0). Takes start at their first sound. */
	at?: number;
}

/** A generated take, by id: `takes/<id>.wav` (e.g. "main-1565909407": its group and seed). */
export interface TakeLayer extends LayerMix {
	take: string;
}

export interface SynthLayer extends LayerMix {
	synth: Synth;
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

/** How a take was made (takes/takes.json, keyed by file name). */
export interface TakeRecord {
	/** The takes generated from one prompt share a group (default "main"); the id is `<group>-<seed>`. */
	group: string;
	prompt: string;
	seconds: number;
	seed: number;
	model: string;
	/** How well it matches its prompt (CLAP cosine similarity); only meaningful against its batch. */
	clap?: number;
	at: string;
}

export interface SoundProblem {
	at: string;
	message: string;
}

export const MAX_GENERATE_SECONDS = 11;
export const SOUND_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TAKE_ID = /^[a-z0-9]+(-[a-z0-9]+)*-\d+$/;
export const takeId = (group: string, seed: number) => `${group}-${seed}`;

/** The variant files, relative to the sound's folder: `<name>.ogg`, `<name>-2.ogg`… */
export const variantFile = (name: string, i: number) => (i === 0 ? `${name}.ogg` : `${name}-${i + 1}.ogg`);

/** The processing a variant renders with: the sound's, overridden by the variant's own fields. */
export function processingOf(sound: Sound, v: Variant): Processing & { loop?: boolean } {
	const { variants: _, notes: __, ...shared } = sound;
	const { layers: ___, ...own } = v;
	return { ...shared, ...own };
}

/**
 * "Make X variants using Y layers": X variants, each mixing Y different takes from `takes`, spread so each take
 * is used as evenly as possible (with Y = 1, one variant per take in order).
 */
export function composeVariants(takes: string[], count: number, layers: number): Variant[] {
	if (!takes.length) return [];
	const per = Math.max(1, Math.min(layers, takes.length));
	return Array.from({ length: count }, (_, v) => ({ layers: Array.from({ length: per }, (_, l) => ({ take: takes[(v * per + l) % takes.length] })) }));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const PROCESSING = ["trim", "length", "pitch", "highpass", "lowpass", "reverb", "peak", "fade", "crossfade"];

/** Every problem in a sound, with where it is; an empty list means it renders. */
export function validateSound(json: unknown): SoundProblem[] {
	const out: SoundProblem[] = [];
	const bad = (at: string, message: string) => out.push({ at, message });
	if (!isObj(json)) return [{ at: "", message: "sound.json must be an object" }];
	const range = (at: string, v: unknown, lo: number, hi: number, unit = "") => {
		if (v === undefined) return;
		if (!num(v) || (v as number) < lo || (v as number) > hi) bad(at, `Must be a number from ${lo} to ${hi}${unit}`);
	};
	const processing = (prefix: string, p: Record<string, unknown>) => {
		const at = (k: string) => (prefix ? `${prefix}.${k}` : k);
		range(at("length"), p.length, 0.01, 60, " seconds");
		range(at("pitch"), p.pitch, -24, 24, " semitones");
		range(at("highpass"), p.highpass, 10, 20000, " Hz");
		range(at("lowpass"), p.lowpass, 10, 20000, " Hz");
		range(at("reverb"), p.reverb, 0, 1);
		range(at("peak"), p.peak, -60, 0, " dBFS");
		range(at("crossfade"), p.crossfade, 0.01, 10, " seconds");
		if (p.trim !== undefined && typeof p.trim !== "boolean") {
			if (!isObj(p.trim)) bad(at("trim"), "true, false or {threshold}");
			else range(at("trim.threshold"), p.trim.threshold, -100, -10, " dB below the peak");
		}
		if (p.fade !== undefined) {
			if (!isObj(p.fade)) bad(at("fade"), "{in, out} in seconds");
			else {
				range(at("fade.in"), p.fade.in, 0, 10, " seconds");
				range(at("fade.out"), p.fade.out, 0, 10, " seconds");
			}
		}
	};
	const s = json as Record<string, unknown>;
	const known = ["notes", "loop", "variants", ...PROCESSING];
	for (const k of Object.keys(s)) {
		if (k === "layers") bad(k, "Layers belong to variants now: \"variants\": [{\"layers\": [{\"take\": \"main-123\"}]}]");
		else if (!known.includes(k)) bad(k, `Unknown field (fields: ${known.join(", ")})`);
	}
	processing("", s);
	if (!Array.isArray(s.variants) || s.variants.length === 0) {
		bad("variants", "At least one variant: {\"layers\": [{\"take\": \"<take id>\"}]} (generate_sound_takes lists take ids)");
		return out;
	}
	s.variants.forEach((rawV, vi) => {
		const vat = `variants[${vi}]`;
		if (!isObj(rawV)) return bad(vat, "A variant is an object with layers");
		for (const k of Object.keys(rawV)) if (k !== "layers" && !PROCESSING.includes(k)) bad(`${vat}.${k}`, `Unknown field (fields: layers, ${PROCESSING.join(", ")})`);
		processing(vat, rawV);
		if (!Array.isArray(rawV.layers) || rawV.layers.length === 0) return bad(`${vat}.layers`, "At least one layer: a take or a synth");
		rawV.layers.forEach((raw, li) => {
			const at = `${vat}.layers[${li}]`;
			if (!isObj(raw)) return bad(at, "A layer is {take} or {synth}");
			for (const k of Object.keys(raw)) if (!["take", "synth", "gain", "at"].includes(k)) bad(`${at}.${k}`, "Unknown field (fields: take, synth, gain, at)");
			if ((raw.take === undefined) === (raw.synth === undefined)) return bad(at, "Exactly one of take or synth");
			range(`${at}.gain`, raw.gain, -60, 24, " dB");
			range(`${at}.at`, raw.at, 0, 60, " seconds");
			if (raw.take !== undefined) {
				if (typeof raw.take !== "string" || !TAKE_ID.test(raw.take)) bad(`${at}.take`, 'A take id like "main-1565909407" (its group and seed)');
				return;
			}
			const y = raw.synth as Record<string, unknown>;
			if (!isObj(y)) return bad(`${at}.synth`, "{wave, seconds, freq, …}");
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
		});
	});
	return out;
}

/** sound.json as the studio writes it: one field per line, one variant per line (small diffs, easy edits). */
export function formatSound(sound: Sound): string {
	const { variants, ...rest } = sound;
	const fields = Object.entries(rest).map(([k, v]) => `\t${JSON.stringify(k)}: ${compact(v)}`);
	const list = variants.map((v) => `\t\t${compact(v)}`).join(",\n");
	return `{\n${[...fields, `\t"variants": [\n${list}\n\t]`].join(",\n")}\n}\n`;
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
