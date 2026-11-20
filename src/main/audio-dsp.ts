// Sound processing for the studio's sound effects (src/main/sounds.ts): synthesis, mixing, trimming, pitch,
// filters, reverb, levels, fades and loops on float samples, plus the measurements an agent reads in place of
// listening. Pure functions; audio is one Float32Array per channel.
import type { Synth } from "../shared/sound";

export const RATE = 44100;
export type Audio = Float32Array[];

export const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
export const fromDb = (db: number) => 10 ** (db / 20);
export const frames = (a: Audio) => a[0]?.length ?? 0;

/** Two channels (a mono signal is copied). */
export const stereo = (a: Audio): Audio => (a.length === 1 ? [a[0], a[0].slice()] : a.slice(0, 2));

const map = (a: Audio, f: (ch: Float32Array) => Float32Array): Audio => a.map(f);
const slice = (a: Audio, from: number, to: number): Audio => a.map((ch) => ch.slice(from, to));

export function peak(a: Audio): number {
	let p = 0;
	for (const ch of a) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
	return p;
}

// --- Synthesis ----------------------------------------------------------------------------------------------

/** A synth layer (mono): an oscillator or noise with an exponential sweep, vibrato, attack and decay. */
export function synth(s: Synth, rate = RATE): Float32Array {
	const n = Math.max(1, Math.round(s.seconds * rate));
	const out = new Float32Array(n);
	const attackS = s.attack ?? 0.005;
	const attack = Math.max(1, Math.round(attackS * rate));
	const decayRate = Math.log(1000) / (s.decay ?? Math.max(0.001, s.seconds - attackS)); // -60 dB over `decay`
	const f0 = s.freq ?? 440;
	let phase = 0;
	let seed = 0x9e3779b9;
	const noise = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 31 - 1;
	};
	for (let i = 0; i < n; i++) {
		const t = i / rate;
		let f = s.to ? f0 * (s.to / f0) ** (t / s.seconds) : f0;
		if (s.vibrato) f *= 2 ** ((s.vibrato.depth * Math.sin(2 * Math.PI * s.vibrato.rate * t)) / 12);
		phase = (phase + f / rate) % 1;
		let v: number;
		switch (s.wave) {
			case "sine": v = Math.sin(2 * Math.PI * phase); break;
			case "square": v = phase < 0.5 ? 1 : -1; break;
			case "saw": v = 2 * phase - 1; break;
			case "triangle": v = 1 - 4 * Math.abs(phase - 0.5); break;
			default: v = noise();
		}
		const env = i < attack ? i / attack : Math.exp(-decayRate * (t - attackS));
		out[i] = v * env * (s.wave === "square" || s.wave === "saw" ? 0.5 : 1); // bright waves sound louder
	}
	// No click at the end.
	const tail = Math.min(n, Math.round(0.002 * rate));
	for (let i = 0; i < tail; i++) out[n - 1 - i] *= i / tail;
	let y: Float32Array = out;
	if (s.highpass) y = biquad(y, "highpass", s.highpass, rate);
	if (s.lowpass) y = biquad(y, "lowpass", s.lowpass, rate);
	return y;
}

/** Layers summed at their offsets (in frames), with linear gains: stereo, as long as the longest. */
export function mix(parts: { audio: Audio; at: number; gain: number }[]): Audio {
	const n = Math.max(1, ...parts.map((p) => p.at + frames(p.audio)));
	const out: Audio = [new Float32Array(n), new Float32Array(n)];
	for (const p of parts) {
		const a = stereo(p.audio);
		for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) out[c][p.at + i] += a[c][i] * p.gain;
	}
	return out;
}

// --- Processing ---------------------------------------------------------------------------------------------

/** Cuts what is quieter than `threshold` dB below the peak from both ends (keeping 5 ms before and 10 ms after). */
export function trimSilence(a: Audio, threshold = -50, rate = RATE): Audio {
	const limit = peak(a) * fromDb(threshold);
	let first = -1;
	let last = -1;
	for (let i = 0; i < frames(a); i++) {
		if (a.some((ch) => Math.abs(ch[i]) > limit)) {
			if (first < 0) first = i;
			last = i;
		}
	}
	if (first < 0) return a;
	return slice(a, Math.max(0, first - Math.round(0.005 * rate)), Math.min(frames(a), last + 1 + Math.round(0.01 * rate)));
}

/** Tape-style pitch shift: resampled, so up is shorter and down is longer. */
export function pitchShift(a: Audio, semitones: number): Audio {
	if (!semitones) return a;
	const r = 2 ** (semitones / 12);
	const n = Math.floor((frames(a) - 1) / r) + 1;
	return map(a, (ch) => {
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const x = i * r;
			const j = Math.floor(x);
			out[i] = ch[j] + (ch[Math.min(j + 1, ch.length - 1)] - ch[j]) * (x - j);
		}
		return out;
	});
}

/** A 12 dB/octave low- or high-pass (RBJ biquad, Q 0.707). */
export function biquad(x: Float32Array, type: "lowpass" | "highpass", freq: number, rate = RATE): Float32Array {
	const w = (2 * Math.PI * Math.min(freq, rate * 0.45)) / rate;
	const cos = Math.cos(w);
	const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
	const [b0, b1, b2] = type === "lowpass" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
	const a0 = 1 + alpha;
	const a1 = -2 * cos;
	const a2 = 1 - alpha;
	const out = new Float32Array(x.length);
	let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
	for (let i = 0; i < x.length; i++) {
		const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
		x2 = x1;
		x1 = x[i];
		y2 = y1;
		y1 = y;
		out[i] = y;
	}
	return out;
}

export const filter = (a: Audio, type: "lowpass" | "highpass", freq: number): Audio => map(a, (ch) => biquad(ch, type, freq));

/** Room reverb (a small Freeverb: four damped combs and two all-passes per channel), with a 2 s tail added. */
export function reverb(a: Audio, wet: number, rate = RATE): Audio {
	if (!wet) return a;
	const s = rate / 44100;
	const tail = Math.round(2 * rate);
	return stereo(a).map((ch, c) => {
		const n = ch.length + tail;
		const input = new Float32Array(n);
		input.set(ch);
		const spread = c * 23;
		const combs = [1116, 1188, 1277, 1356].map((d) => ({ buf: new Float32Array(Math.round((d + spread) * s)), i: 0, store: 0 }));
		const passes = [556, 441].map((d) => ({ buf: new Float32Array(Math.round((d + spread) * s)), i: 0 }));
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const x = input[i] * 0.03;
			let y = 0;
			for (const cb of combs) {
				const o = cb.buf[cb.i];
				cb.store = o * 0.8 + cb.store * 0.2; // damping
				cb.buf[cb.i] = x + cb.store * 0.84;
				cb.i = (cb.i + 1) % cb.buf.length;
				y += o;
			}
			for (const ap of passes) {
				const b = ap.buf[ap.i];
				ap.buf[ap.i] = y + b * 0.5;
				ap.i = (ap.i + 1) % ap.buf.length;
				y = b - y;
			}
			out[i] = input[i] * (1 - wet * 0.4) + y * wet * 3;
		}
		return out;
	});
}

/** Scales so the loudest sample is at `db` dBFS (silence stays silent). */
export function normalizePeak(a: Audio, db: number): Audio {
	const p = peak(a);
	if (p < 1e-6) return a;
	const g = fromDb(db) / p;
	return map(a, (ch) => ch.map((v) => v * g));
}

/** Linear fade in and out, in seconds. */
export function fades(a: Audio, fadeIn: number, fadeOut: number, rate = RATE): Audio {
	const n = frames(a);
	const fi = Math.min(n, Math.round(fadeIn * rate));
	const fo = Math.min(n, Math.round(fadeOut * rate));
	return map(a, (ch) => {
		const out = ch.slice();
		for (let i = 0; i < fi; i++) out[i] *= i / fi;
		for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
		return out;
	});
}

/**
 * A seamless loop: the last `seconds` are crossfaded (equal power) into the start, so playing the result
 * end-to-start continues the sound the way it went on. The loop is that much shorter than its source.
 */
export function loopCrossfade(a: Audio, seconds: number, rate = RATE): Audio {
	const n = frames(a);
	const f = Math.min(Math.round(seconds * rate), Math.floor(n / 2));
	return map(a, (ch) => {
		const out = ch.slice(0, n - f);
		for (let i = 0; i < f; i++) {
			const t = (i + 0.5) / f;
			out[i] = ch[i] * Math.sqrt(t) + ch[n - f + i] * Math.sqrt(1 - t);
		}
		return out;
	});
}

// --- Measurements -------------------------------------------------------------------------------------------

export interface Measurements {
	seconds: number;
	/** dBFS of the loudest sample. */
	peak_db: number;
	/** RMS level of the part within 40 dB of the peak, dBFS: how loud it sounds, roughly. */
	loudness_db: number;
	/** Samples at full scale (a sign of clipping). */
	clipped: number;
	/** Seconds until it first reaches 6 dB below its peak: short = a hit, long = a swell. */
	attack: number;
	/** Seconds from the last moment within 20 dB of the peak to the end: how long it rings out. */
	tail: number;
	/** Spectral centroid in Hz: low = dull or boomy, high = bright, hissy or metallic. */
	brightness_hz: number;
	/** Separate hits (onsets): one footstep should be 1. */
	events: number;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function measure(a: Audio, rate = RATE): Measurements {
	const n = frames(a);
	const mono = new Float32Array(n);
	for (const ch of a) for (let i = 0; i < n; i++) mono[i] += ch[i] / a.length;
	const p = peak(a);
	let clipped = 0;
	for (const ch of a) for (let i = 0; i < n; i++) if (Math.abs(ch[i]) >= 0.999) clipped++;
	// 10 ms RMS envelope.
	const hop = Math.round(0.01 * rate);
	const env: number[] = [];
	for (let i = 0; i < n; i += hop) {
		let s = 0;
		const end = Math.min(n, i + hop);
		for (let j = i; j < end; j++) s += mono[j] * mono[j];
		env.push(Math.sqrt(s / Math.max(1, end - i)));
	}
	const envPeak = Math.max(1e-9, ...env);
	const active = env.filter((e) => e > envPeak * fromDb(-40));
	const loudness = Math.sqrt(active.reduce((s, e) => s + e * e, 0) / Math.max(1, active.length));
	const attackAt = env.findIndex((e) => e >= envPeak * fromDb(-6));
	let lastLoud = 0;
	env.forEach((e, i) => e >= envPeak * fromDb(-20) && (lastLoud = i));
	// Onsets: a rise of 10 dB over the quietest of the last 50 ms, within 30 dB of the peak, 80 ms apart.
	let events = 0;
	let lastOnset = -Infinity;
	for (let i = 1; i < env.length; i++) {
		const floor = Math.min(...env.slice(Math.max(0, i - 5), i));
		if (env[i] > envPeak * fromDb(-30) && toDb(env[i]) - toDb(floor) >= 10 && i - lastOnset >= 8) {
			events++;
			lastOnset = i;
		}
	}
	if (events === 0 && p > 1e-6) events = 1; // a sound that starts loud has no rise to find
	return {
		seconds: round(n / rate, 3),
		peak_db: round(toDb(p), 1),
		loudness_db: round(toDb(loudness), 1),
		clipped,
		attack: round((Math.max(0, attackAt) * hop) / rate, 3),
		tail: round(Math.max(0, n - (lastLoud + 1) * hop) / rate, 2),
		brightness_hz: Math.round(centroid(mono, rate)),
		events,
	};
}

/** Energy-weighted spectral centroid over 2048-sample frames. */
function centroid(x: Float32Array, rate: number): number {
	const size = 2048;
	let num = 0;
	let den = 0;
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	for (let start = 0; start + size <= Math.max(x.length, size); start += size / 2) {
		for (let i = 0; i < size; i++) {
			re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
			im[i] = 0;
		}
		fft(re, im);
		for (let k = 1; k < size / 2; k++) {
			const m = re[k] * re[k] + im[k] * im[k];
			num += m * ((k * rate) / size);
			den += m;
		}
	}
	return den ? num / den : 0;
}

function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		for (let i = 0; i < n; i += len) {
			for (let k = 0; k < len / 2; k++) {
				const wr = Math.cos(ang * k);
				const wi = Math.sin(ang * k);
				const ur = re[i + k];
				const ui = im[i + k];
				const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
				const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
				re[i + k] = ur + vr;
				im[i + k] = ui + vi;
				re[i + k + len / 2] = ur - vr;
				im[i + k + len / 2] = ui - vi;
			}
		}
	}
}

// --- WAV ----------------------------------------------------------------------------------------------------

/** 16-bit or 32-bit float PCM WAV to float samples. */
export function decodeWav(buf: Buffer): { audio: Audio; rate: number } {
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
	let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
	for (let i = 12; i + 8 <= buf.length; ) {
		const id = buf.toString("ascii", i, i + 4);
		const size = buf.readUInt32LE(i + 4);
		if (id === "fmt ") fmt = { format: buf.readUInt16LE(i + 8), channels: buf.readUInt16LE(i + 10), rate: buf.readUInt32LE(i + 12), bits: buf.readUInt16LE(i + 22) };
		if (id === "data") {
			if (!fmt) throw new Error("WAV data before its format");
			const bytes = fmt.bits / 8;
			const n = Math.floor(Math.min(size, buf.length - i - 8) / (bytes * fmt.channels));
			const audio: Audio = Array.from({ length: fmt.channels }, () => new Float32Array(n));
			for (let f = 0; f < n; f++) {
				for (let c = 0; c < fmt.channels; c++) {
					const at = i + 8 + (f * fmt.channels + c) * bytes;
					audio[c][f] = fmt.bits === 16 ? buf.readInt16LE(at) / 32768 : fmt.bits === 32 && fmt.format === 3 ? buf.readFloatLE(at) : buf.readInt32LE(at) / 2 ** 31;
				}
			}
			return { audio, rate: fmt.rate };
		}
		i += 8 + size + (size & 1);
	}
	throw new Error("WAV without data");
}

/** Float samples to a 16-bit PCM WAV. */
export function encodeWav(a: Audio, rate = RATE): Buffer {
	const n = frames(a);
	const ch = a.length;
	const data = Buffer.alloc(n * ch * 2);
	for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a[c][f] * 32767))), (f * ch + c) * 2);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0, "ascii");
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVEfmt ", 8, "ascii");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(ch, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * ch * 2, 28);
	h.writeUInt16LE(ch * 2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36, "ascii");
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}

/** Linear resampling to the studio's rate (takes come at 44.1 kHz already; this is for anything else). */
export function resample(a: Audio, from: number, to = RATE): Audio {
	if (from === to) return a;
	const r = from / to;
	const n = Math.floor((frames(a) - 1) / r) + 1;
	return map(a, (ch) => {
		const out = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const x = i * r;
			const j = Math.floor(x);
			out[i] = ch[j] + (ch[Math.min(j + 1, ch.length - 1)] - ch[j]) * (x - j);
		}
		return out;
	});
}
