import { describe, expect, it } from "vitest";
import { fxProcess, fxState, type SoundEffects } from "./sound-fx";

const RATE = 48000;

// Samples the engine's own fx_process (headless-game-engine engine/engine/sound_fx.odin) produced for this input:
// two tones per channel, every effect on, then a change mid-sound (the glide), in the blocks below. If the engine's
// effects change, compute these again there and update the port.
const ENGINE: [number, number, number][] = [
	[100, 0.1236791, -0.1060032],
	[777, 0.1017894, 0.1081013],
	[1500, -0.0000354, -0.0454932],
	[2047, 0.0080411, -0.0755977],
	[2048, 0.0066602, -0.0565608],
	[2100, 0.0633035, -0.1942377],
	[2500, -0.2076081, 0.1969213],
	[3000, 0.1651405, -0.0759432],
	[4095, 0.4351988, -0.0609468],
];

describe("the engine's sound effects, ported", () => {
	it("matches the engine sample for sample, through a change mid-sound", () => {
		const n = 4096;
		const l = new Float32Array(n);
		const r = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const t = i / RATE;
			l[i] = 0.4 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 3000 * t);
			r[i] = 0.3 * Math.sin(2 * Math.PI * 700 * t);
		}
		const s = fxState({ lowpass: 2000, highpass: 200, bandpass: 900, resonance: 2, comb_ms: 3.3, comb_feedback: 0.6, comb_mix: 0.5 });
		for (let i = 0; i < 2048; i += 512) fxProcess(s, [l.subarray(i, i + 512), r.subarray(i, i + 512)], RATE);
		s.target = { lowpass: 800, comb_ms: 6, comb_feedback: -0.5, comb_mix: 0.8 };
		for (let i = 2048; i < n; i += 128) fxProcess(s, [l.subarray(i, i + 128), r.subarray(i, i + 128)], RATE);
		// The engine works in 32-bit floats and this in 64: through the comb's feedback they drift apart a little.
		for (const [i, el, er] of ENGINE) {
			expect(Math.abs(l[i] - el), `left ${i}: ${l[i]} vs ${el}`).toBeLessThan(2e-3);
			expect(Math.abs(r[i] - er), `right ${i}: ${r[i]} vs ${er}`).toBeLessThan(2e-3);
		}
	});

	const gainDb = (e: SoundEffects, freq: number) => {
		const n = RATE / 2;
		const x = new Float32Array(n).map((_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / RATE));
		const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
		const dry = rms(x.subarray(n / 2));
		const s = fxState(e);
		for (let i = 0; i < n; i += 128) fxProcess(s, [x.subarray(i, i + 128)], RATE);
		return 20 * Math.log10(rms(x.subarray(n / 2)) / dry);
	};

	it("filters and rings where the engine's tests say", () => {
		expect(gainDb({ lowpass: 1000 }, 5000)).toBeLessThan(-20);
		expect(Math.abs(gainDb({ lowpass: 1000 }, 200))).toBeLessThan(1);
		expect(gainDb({ highpass: 1000 }, 200)).toBeLessThan(-20);
		expect(Math.abs(gainDb({ bandpass: 1000 }, 1000))).toBeLessThan(1);
		const comb = { comb_ms: 4, comb_feedback: 0.7, comb_mix: 1 };
		expect(gainDb(comb, 250)).toBeGreaterThan(9);
		expect(gainDb(comb, 125)).toBeLessThan(-3);
	});

	it("with nothing on, leaves the sound as it was", () => {
		const x = new Float32Array(1000).map((_, i) => Math.sin(i / 7));
		const y = x.slice();
		fxProcess(fxState({}), [y], RATE);
		expect(y).toEqual(x);
	});
});
