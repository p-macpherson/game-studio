/**
 * The engine's per-sound effects (headless-game-engine `engine/engine/sound_fx.odin`), ported line for line so the
 * studio can play a sound exactly as the game will: the Sound Effects section's live preview (an AudioWorklet) and,
 * later, agents' renders. Keep the two in step: `sound-fx.test.ts` checks this against samples the engine computed.
 */

/** What a sound plays through, as the engine's `Sound_Effects` (same field names). 0 or missing turns each one off. */
export interface SoundEffects {
	lowpass?: number;
	highpass?: number;
	bandpass?: number;
	resonance?: number;
	comb_ms?: number;
	comb_feedback?: number;
	comb_mix?: number;
}

export const SOUND_EFFECT_FIELDS = ["lowpass", "highpass", "bandpass", "resonance", "comb_ms", "comb_feedback", "comb_mix"] as const;

const MAX_DELAY = 2048;
const GLIDE = 0.01;
const SUB_BLOCK = 32;
const LP_OPEN = 20000;
const HP_OPEN = 10;

interface Biquad {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
	z1: [number, number];
	z2: [number, number];
}

const biquad = (): Biquad => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: [0, 0], z2: [0, 0] });

export interface FxState {
	target: SoundEffects;
	started: boolean;
	fromDry: boolean;
	lp: number;
	hp: number;
	bp: number;
	bpMix: number;
	q: number;
	combLen: number;
	feedback: number;
	combMix: number;
	low: Biquad;
	high: Biquad;
	band: Biquad;
	delay: [Float32Array, Float32Array];
	pos: number;
	combLive: boolean;
}

export function fxState(target: SoundEffects = {}, fromDry = false): FxState {
	return {
		target,
		started: false,
		fromDry,
		lp: 0,
		hp: 0,
		bp: 0,
		bpMix: 0,
		q: 0,
		combLen: 0,
		feedback: 0,
		combMix: 0,
		low: biquad(),
		high: biquad(),
		band: biquad(),
		delay: [new Float32Array(MAX_DELAY), new Float32Array(MAX_DELAY)],
		pos: 0,
		combLive: false,
	};
}

function biquadSet(q: Biquad, kind: "low" | "high" | "band", freq: number, Q: number, rate: number): void {
	const w = (2 * Math.PI * freq) / rate;
	const cw = Math.cos(w);
	const alpha = Math.sin(w) / (2 * Q);
	const a0 = 1 + alpha;
	const [b0, b1, b2] = kind === "low" ? [(1 - cw) / 2, 1 - cw, (1 - cw) / 2] : kind === "high" ? [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2] : [alpha, 0, -alpha];
	q.b0 = b0 / a0;
	q.b1 = b1 / a0;
	q.b2 = b2 / a0;
	q.a1 = (-2 * cw) / a0;
	q.a2 = (1 - alpha) / a0;
}

function biquadRun(q: Biquad, c: number, x: number): number {
	const y = q.b0 * x + q.z1[c];
	q.z1[c] = q.b1 * x - q.a1 * y + q.z2[c];
	q.z2[c] = q.b2 * x - q.a2 * y;
	return y;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function goal(e: SoundEffects, rate: number) {
	const top = Math.min(LP_OPEN, 0.45 * rate);
	const lowpass = e.lowpass ?? 0;
	const highpass = e.highpass ?? 0;
	const bandpass = e.bandpass ?? 0;
	const resonance = e.resonance ?? 0;
	const combMs = e.comb_ms ?? 0;
	const on = combMs > 0;
	return {
		lp: Math.log2(lowpass > 0 ? clamp(lowpass, HP_OPEN, top) : top),
		hp: Math.log2(highpass > 0 ? clamp(highpass, HP_OPEN, top) : HP_OPEN),
		bpMix: bandpass > 0 ? 1 : 0,
		bp: Math.log2(bandpass > 0 ? clamp(bandpass, HP_OPEN, top) : 1000),
		q: resonance > 0 ? clamp(resonance, 0.1, 20) : 0.707,
		combLen: (clamp(on ? combMs : 4, 0.5, 20) * rate) / 1000,
		feedback: on ? clamp(e.comb_feedback ?? 0, -0.95, 0.95) : 0,
		combMix: on ? clamp(e.comb_mix ?? 0, 0, 1) : 0,
	};
}

function coefficients(s: FxState, rate: number): void {
	biquadSet(s.low, "low", 2 ** s.lp, s.q, rate);
	biquadSet(s.high, "high", 2 ** s.hp, s.q, rate);
	biquadSet(s.band, "band", 2 ** s.bp, s.q, rate);
}

/** Runs `channels` (one or two, the same length) through the effects in place. `rate`: their sample rate. */
export function fxProcess(s: FxState, channels: Float32Array[], rate: number): void {
	const g = goal(s.target, rate);
	if (!s.started) {
		Object.assign(s, { lp: g.lp, hp: g.hp, bp: g.bp, bpMix: g.bpMix, q: g.q, combLen: g.combLen, feedback: g.feedback, combMix: g.combMix });
		if (s.fromDry) {
			const open = goal({}, rate);
			Object.assign(s, { lp: open.lp, hp: open.hp, bpMix: open.bpMix, q: open.q, feedback: open.feedback, combMix: open.combMix });
		}
		s.started = true;
		coefficients(s, rate);
	}
	const top = Math.log2(Math.min(LP_OPEN, 0.45 * rate));
	const bottom = Math.log2(HP_OPEN);
	const k = 1 - Math.exp(-1 / (GLIDE * rate));
	const kb = 1 - Math.exp(-SUB_BLOCK / (GLIDE * rate));
	const n = channels[0]?.length ?? 0;
	const nc = Math.min(channels.length, 2);

	for (let start = 0; start < n; start += SUB_BLOCK) {
		const end = Math.min(start + SUB_BLOCK, n);
		const gliding = Math.abs(s.lp - g.lp) > 1e-3 || Math.abs(s.hp - g.hp) > 1e-3 || Math.abs(s.bp - g.bp) > 1e-3 || Math.abs(s.q - g.q) > 1e-3;
		if (gliding) {
			s.lp += (g.lp - s.lp) * kb;
			s.hp += (g.hp - s.hp) * kb;
			s.bp += (g.bp - s.bp) * kb;
			s.q += (g.q - s.q) * kb;
			coefficients(s, rate);
		}
		const useLp = s.lp < top - 1e-3 || g.lp < top - 1e-3;
		const useHp = s.hp > bottom + 1e-3 || g.hp > bottom + 1e-3;
		const useBp = s.bpMix > 1e-4 || g.bpMix > 0;
		const useComb = Math.abs(s.combMix) > 1e-4 || g.combMix > 0 || Math.abs(s.feedback) > 1e-4 || g.feedback !== 0;
		if (useComb && !s.combLive) {
			s.delay[0].fill(0);
			s.delay[1].fill(0);
			s.combLen = g.combLen;
			s.combLive = true;
		} else if (!useComb) s.combLive = false;
		if (!useLp) (s.low.z1 = [0, 0]), (s.low.z2 = [0, 0]);
		if (!useHp) (s.high.z1 = [0, 0]), (s.high.z2 = [0, 0]);
		if (!useBp) (s.band.z1 = [0, 0]), (s.band.z2 = [0, 0]);
		if (!(useLp || useHp || useBp || useComb)) continue;

		for (let i = start; i < end; i++) {
			if (useBp) s.bpMix += (g.bpMix - s.bpMix) * k;
			if (useComb) {
				s.combLen += (g.combLen - s.combLen) * k;
				s.feedback += (g.feedback - s.feedback) * k;
				s.combMix += (g.combMix - s.combMix) * k;
			}
			const whole = Math.trunc(s.combLen);
			const frac = s.combLen - whole;
			const r0 = (s.pos - whole + MAX_DELAY) % MAX_DELAY;
			const r1 = (r0 - 1 + MAX_DELAY) % MAX_DELAY;
			for (let c = 0; c < nc; c++) {
				let x = channels[c][i];
				if (useHp) x = biquadRun(s.high, c, x);
				if (useLp) x = biquadRun(s.low, c, x);
				if (useBp) x = x * (1 - s.bpMix) + biquadRun(s.band, c, x) * s.bpMix;
				if (useComb) {
					const line = s.delay[c];
					const y = x + s.feedback * (line[r0] * (1 - frac) + line[r1] * frac);
					line[s.pos] = y;
					x = x * (1 - s.combMix) + y * s.combMix;
				}
				channels[c][i] = x;
			}
			if (useComb) s.pos = (s.pos + 1) % MAX_DELAY;
		}
	}
}

/** The effects that are on (non-zero), for code and display. */
export function effectsOn(e: SoundEffects): SoundEffects {
	return Object.fromEntries(SOUND_EFFECT_FIELDS.flatMap((f) => (e[f] ? [[f, e[f]]] : [])));
}
