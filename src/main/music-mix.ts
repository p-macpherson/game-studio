// The mix stage of music rendering: each track is rendered on its own (FluidSynth, its reverb off), low-cut below
// its lowest note, summed dry, and sent by its `reverb` amount to one convolution reverb (an impulse response made
// here for the song's `space`, applied by ffmpeg's afir). A gentle master chain and levelling follow in music.ts.
import { type Audio, biquad, RATE } from "./audio-dsp";
import type { Space, TimelineTrack } from "../shared/song";

/** A small seeded PRNG (mulberry32): the same song always renders the same. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A stable hash of a string to 0..1 (FNV-1a): per-note humanising that's the same in every pass of a loop. */
export function unit(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
	return (h >>> 0) / 4294967296;
}

const SPACE: Record<Exclude<Space, "dry">, { rt60: number; predelay: number; damp: number }> = {
	room: { rt60: 1.1, predelay: 0.012, damp: 0.5 },
	hall: { rt60: 2.3, predelay: 0.028, damp: 0.4 },
};

/**
 * A stereo impulse response for a space: a few early reflections, then decorrelated noise in each ear decaying to
 * -60 dB over rt60, the highs dying sooner (`damp` × rt60) as in a real room. Each channel has unit energy, so the
 * reverb comes out about as loud as what's sent into it.
 */
export function impulse(space: Exclude<Space, "dry">, rate = RATE): Audio {
	const { rt60, predelay, damp } = SPACE[space];
	const n = Math.round((predelay + rt60) * rate);
	return [0, 1].map((c) => {
		const rand = rng(space === "hall" ? 101 + c : 7 + c);
		const ir = new Float32Array(n);
		const start = Math.round(predelay * rate);
		// Early reflections: 7 taps over the next 60 ms, getting quieter.
		for (let k = 0; k < 7; k++) {
			const at = start + Math.round(rand() * 0.06 * rate);
			ir[at] += (rand() < 0.5 ? -1 : 1) * 0.6 * (1 - k / 8);
		}
		// The late tail: noise, split at about 3 kHz, the high band decaying faster.
		const a = Math.exp((-2 * Math.PI * 3000) / rate);
		let low = 0;
		const fadeIn = 0.02 * rate;
		for (let i = start; i < n; i++) {
			const t = (i - start) / rate;
			const x = rand() * 2 - 1;
			low = (1 - a) * x + a * low;
			const high = x - low;
			const env = Math.min(1, (i - start) / fadeIn);
			ir[i] += env * (low * 10 ** ((-3 * t) / rt60) + high * 0.5 * 10 ** ((-3 * t) / (rt60 * damp)));
		}
		let e = 0;
		for (const v of ir) e += v * v;
		const g = 1 / Math.sqrt(e || 1);
		for (let i = 0; i < n; i++) ir[i] *= g;
		return ir;
	});
}

/** Where a track's low cut sits: well below its lowest note (the fundamental keeps), clearing rumble and mud. */
export function lowCutHz(track: TimelineTrack): number {
	if (track.drums || !track.notes.length) return 30;
	const lowest = Math.min(...track.notes.map((n) => n.pitch));
	return Math.max(30, 0.6 * 440 * 2 ** ((lowest - 69) / 12));
}

/** Running sums of the stems: the dry mix, and the reverb send. Stems are added one at a time to keep memory flat. */
export class StemBus {
	dry: Audio = [];
	send: Audio = [];

	add(stem: Audio, track: TimelineTrack): void {
		const cut = lowCutHz(track);
		const chans = stem.length === 1 ? [stem[0], stem[0]] : stem.slice(0, 2);
		for (let c = 0; c < 2; c++) {
			const x = biquad(chans[c], "highpass", cut);
			if (!this.dry[c]) {
				this.dry[c] = new Float32Array(x.length);
				this.send[c] = new Float32Array(x.length);
			}
			const n = Math.min(x.length, this.dry[c].length);
			for (let i = 0; i < n; i++) {
				this.dry[c][i] += x[i];
				this.send[c][i] += x[i] * track.reverb;
			}
		}
	}
}

/** 32-bit float WAV: mixes go over full scale before they're levelled. */
export function encodeFloatWav(a: Audio, rate = RATE): Buffer {
	const n = a[0]?.length ?? 0;
	const ch = a.length;
	const data = Buffer.alloc(n * ch * 4);
	for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++) data.writeFloatLE(a[c][f], (f * ch + c) * 4);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0, "ascii");
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVEfmt ", 8, "ascii");
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(3, 20); // IEEE float
	h.writeUInt16LE(ch, 22);
	h.writeUInt32LE(rate, 24);
	h.writeUInt32LE(rate * ch * 4, 28);
	h.writeUInt16LE(ch * 4, 32);
	h.writeUInt16LE(32, 34);
	h.write("data", 36, "ascii");
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}
