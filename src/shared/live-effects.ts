// Live effects, without the audio: two ends for each of pitch and the engine's per-sound effects (at 0 and at 1 of
// something in the game, like heat), the values between, and the game code that does the same. A sound.json keeps them
// as `"live"` (the Sound Designer writes it; render_sound previews it); the Sound Effects section's "Try live effects"
// card edits them as text.
import { SOUND_EFFECT_FIELDS, type SoundEffects } from "./sound-fx";

export const LIVE_FIELDS = ["pitch", ...SOUND_EFFECT_FIELDS] as const;
export type LiveField = (typeof LIVE_FIELDS)[number];

/** What's typed for each field: its value at 0 and at 1. Blank is off (pitch: 1). */
export type LiveEnds = Record<LiveField, [string, string]>;

export const emptyEnds = (): LiveEnds => Object.fromEntries(LIVE_FIELDS.map((f) => [f, ["", ""]])) as unknown as LiveEnds;

const num = (s: string): number | undefined => {
	const v = Number(s.trim());
	return s.trim() === "" || !Number.isFinite(v) ? undefined : v;
};
const off = (f: LiveField) => (f === "pitch" ? 1 : 0);

/** The two ends of a field as numbers (blank: off), or undefined when neither is set. */
function endsOf(ends: LiveEnds, f: LiveField): [number, number] | undefined {
	const [a, b] = [num(ends[f][0]), num(ends[f][1])];
	if (a === undefined && b === undefined) return undefined;
	return [a ?? off(f), b ?? off(f)];
}

/** Pitch and effects at `t` (0..1): each field straight between its ends, as the generated code does it. */
export function liveAt(ends: LiveEnds, t: number): { pitch: number; effects: SoundEffects } {
	const at = (f: LiveField) => {
		const e = endsOf(ends, f);
		return e ? e[0] + (e[1] - e[0]) * t : off(f);
	};
	const effects: SoundEffects = {};
	for (const f of SOUND_EFFECT_FIELDS) {
		const v = at(f);
		if (v) effects[f] = v;
	}
	return { pitch: at("pitch"), effects };
}

const fmt = (v: number) => String(Number(v.toFixed(3)));

/** `a + t * (b - a)` written as plainly as it can be. */
function expr(a: number, b: number, variable: string): string {
	if (a === b) return fmt(a);
	const d = b - a;
	const scaled = `${variable} * ${fmt(Math.abs(d))}`;
	if (a === 0) return d < 0 ? `-${scaled}` : scaled;
	return `${fmt(a)} ${d < 0 ? "-" : "+"} ${scaled}`;
}

/**
 * The Odin that plays the sound as the preview does. `path` is the file under assets/; `variable` the 0..1 value in the
 * game. A loop is changed while it plays, so it gets the set_voice_* calls.
 */
export function liveCode(ends: LiveEnds, path: string, variable: string, loop: boolean): string {
	const v = variable.trim() || "heat";
	const pitchEnds = endsOf(ends, "pitch");
	const pitch = pitchEnds && !(pitchEnds[0] === 1 && pitchEnds[1] === 1) ? expr(pitchEnds[0], pitchEnds[1], v) : undefined;
	const fields = SOUND_EFFECT_FIELDS.flatMap((f) => {
		const e = endsOf(ends, f);
		return e && !(e[0] === 0 && e[1] === 0) ? [`\t${f} = ${expr(e[0], e[1], v)},`] : [];
	});
	const effects = fields.length ? `{\n${fields.join("\n")}\n}` : undefined;
	const varying = LIVE_FIELDS.some((f) => {
		const e = endsOf(ends, f);
		return e && e[0] !== e[1];
	});
	const lines: string[] = [];
	if (varying) lines.push(`// ${v}: 0..1, from the game`);
	if (loop) {
		lines.push(`id := engine.play_sound(${JSON.stringify(path)}${pitch ? `, pitch = ${pitch}` : ""}${effects ? `, effects = ${effects}` : ""})`);
		if (varying) {
			lines.push(`// then every frame while it plays:`);
			if (pitch) lines.push(`engine.set_voice_pitch(id, ${pitch})`);
			if (effects) lines.push(`engine.set_voice_effects(id, ${effects})`);
		}
	} else {
		lines.push(`engine.play_sound(${JSON.stringify(path)}${pitch ? `, pitch = ${pitch}` : ""}${effects ? `, effects = ${effects}` : ""})`);
	}
	return lines.join("\n");
}

/** Starting points: where each ends up at 1 (the start is the dry sound). */
export const LIVE_PRESETS: { label: string; title: string; at1: Partial<Record<LiveField, string>>; at0?: Partial<Record<LiveField, string>> }[] = [
	{
		label: "Hollow (overheating)",
		title: "Higher, boxier and ringing as it heats: a narrowing band, the comb's ring fading in",
		at0: { bandpass: "1200", resonance: "1", comb_ms: "4" },
		at1: { pitch: "1.3", bandpass: "2700", resonance: "4", comb_ms: "4", comb_feedback: "0.7", comb_mix: "0.6" },
	},
	{ label: "Muffled", title: "Behind a wall or underwater: the highs closing off", at0: { lowpass: "20000" }, at1: { lowpass: "500" } },
	{ label: "Radio", title: "Thin and boxy, as through a small speaker", at1: { highpass: "400", lowpass: "3500", resonance: "1.5" } },
];

/** sound.json's `"live"`: how the game changes the sound while it plays. A field missing at an end is off (pitch 1). */
export interface SoundLive {
	/** The game's 0..1 value it follows, as named in the code ("heat", "speed"). */
	value: string;
	at0?: Partial<Record<LiveField, number>>;
	at1?: Partial<Record<LiveField, number>>;
}

/** The ranges the engine accepts (it clamps beyond them). 0 is also allowed for the effects: off. */
export const LIVE_RANGES: Record<LiveField, [number, number]> = {
	pitch: [0.05, 4],
	lowpass: [10, 20000],
	highpass: [10, 20000],
	bandpass: [10, 20000],
	resonance: [0.1, 20],
	comb_ms: [0.5, 20],
	comb_feedback: [-0.95, 0.95],
	comb_mix: [0, 1],
};

/** Every problem in a `"live"`, with where it is (under `at`). */
export function validateLive(raw: unknown, at = "live"): { at: string; message: string }[] {
	const out: { at: string; message: string }[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [{ at, message: '{"value": "heat", "at0": {…}, "at1": {…}}' }];
	const r = raw as Record<string, unknown>;
	for (const k of Object.keys(r)) if (!["value", "at0", "at1"].includes(k)) out.push({ at: `${at}.${k}`, message: "Unknown field (fields: value, at0, at1)" });
	if (typeof r.value !== "string" || !/^[a-z_][a-z0-9_]*$/.test(r.value)) out.push({ at: `${at}.value`, message: 'The game value it follows, a name like "heat" or "speed"' });
	for (const end of ["at0", "at1"] as const) {
		const e = r[end];
		if (e === undefined) continue;
		if (typeof e !== "object" || e === null || Array.isArray(e)) {
			out.push({ at: `${at}.${end}`, message: `{${LIVE_FIELDS.join(", ")}}` });
			continue;
		}
		for (const [k, v] of Object.entries(e)) {
			const range = LIVE_RANGES[k as LiveField];
			if (!range) out.push({ at: `${at}.${end}.${k}`, message: `Unknown field (fields: ${LIVE_FIELDS.join(", ")})` });
			else if (typeof v !== "number" || !Number.isFinite(v) || ((v < range[0] || v > range[1]) && !(v === 0 && k !== "pitch")))
				out.push({ at: `${at}.${end}.${k}`, message: `A number from ${range[0]} to ${range[1]}${k === "pitch" ? "" : " (or 0: off)"}` });
		}
	}
	if (r.at0 === undefined && r.at1 === undefined) out.push({ at, message: "Set at0, at1 or both" });
	return out;
}

/** A sound.json `"live"` as the card's text. */
export function endsOfLive(live: SoundLive): LiveEnds {
	const ends = emptyEnds();
	for (const f of LIVE_FIELDS) ends[f] = [live.at0?.[f]?.toString() ?? "", live.at1?.[f]?.toString() ?? ""];
	return ends;
}

/** The card's text as a sound.json `"live"`, or null when nothing is set. */
export function liveOfEnds(ends: LiveEnds, value: string): SoundLive | null {
	const end = (i: 0 | 1) => {
		const o: Partial<Record<LiveField, number>> = {};
		for (const f of LIVE_FIELDS) {
			const v = num(ends[f][i]);
			if (v !== undefined) o[f] = v;
		}
		return Object.keys(o).length ? o : undefined;
	};
	const [at0, at1] = [end(0), end(1)];
	if (!at0 && !at1) return null;
	return { value: value.trim() || "heat", ...(at0 ? { at0 } : {}), ...(at1 ? { at1 } : {}) };
}
