// The Sound Effects section's live preview, without the audio: two ends for each of pitch and the engine's effects (at 0
// and at 1 of something in the game, like heat), the values between, and the game code that does the same.
import { SOUND_EFFECT_FIELDS, type SoundEffects } from "../../shared/sound-fx";

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
