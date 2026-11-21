// The CPU-heavy steps of music and sound rendering: decoding, filtering, mixing, cutting and encoding whole buffers.
// Each takes and leaves files, so it can run off the main process's thread (audio-runner.ts, audio-worker.ts): a
// one-minute piece is tens of millions of samples per pass, and doing this inline stalled the studio's window and
// the game view in a dozen hitches per render.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Layer, Processing } from "../shared/sound";
import { type Audio, decodeWav, encodeWav, fromDb, type Measurements, measure, mix, normalizePeak, RATE, resample, synth, trimSilence } from "./audio-dsp";
import { loopFromPasses, readWav, sliceFrames, writeWav } from "./music";
import { encodeFloatWav, StemBus } from "./music-mix";
import { processSound } from "./sounds";

export const JOBS = {
	/** Stems (WAV files, removed once read) low-cut and summed into a dry mix and a reverb send, as float WAVs. */
	stemBus(a: { wavs: string[]; tracks: { cut: number; reverb: number }[]; dry: string; send: string; emptyFrames: number }): void {
		const bus = new StemBus();
		for (const [i, wav] of a.wavs.entries()) {
			bus.addWith(decodeWav(readFileSync(wav)).audio, a.tracks[i].cut, a.tracks[i].reverb);
			rmSync(wav);
		}
		if (!bus.dry.length) bus.dry = bus.send = [new Float32Array(a.emptyFrames), new Float32Array(a.emptyFrames)];
		writeFileSync(a.dry, encodeFloatWav(bus.dry));
		writeFileSync(a.send, encodeFloatWav(bus.send));
	},

	/** Float WAVs summed sample by sample into one (the stems' mix, to find its level). */
	sumWavs(a: { files: string[]; out: string }): void {
		const sum: Float32Array[] = [];
		for (const file of a.files) {
			const audio = decodeWav(readFileSync(file)).audio;
			for (let c = 0; c < 2; c++) {
				sum[c] ??= new Float32Array(audio[c].length);
				for (let k = 0; k < Math.min(audio[c].length, sum[c].length); k++) sum[c][k] += audio[c][k];
			}
		}
		writeFileSync(a.out, encodeFloatWav(sum.length ? sum : [new Float32Array(1), new Float32Array(1)]));
	},

	/** A 16-bit render cut to what is kept: the middle pass of a loop (its seam crossfaded), or the piece and its tail. Returns its frames. */
	cutLoop(a: { in: string; out: string; loop: boolean; loopFrames: number; tailFrames: number }): number {
		const pcm = readWav(readFileSync(a.in));
		const cut = a.loop ? loopFromPasses(pcm, a.loopFrames) : sliceFrames(pcm, 0, a.loopFrames + a.tailFrames);
		writeFileSync(a.out, writeWav(cut));
		return cut.frames;
	},

	/** One variant of a sound: its layers (takes from `dir`/takes, or synth) levelled, mixed and processed into a WAV; returns its measurements. */
	renderVariant(a: { dir: string; layers: Layer[]; processing: Processing & { loop?: boolean }; out: string }): Measurements {
		const take = (id: string): Audio => {
			const { audio, rate } = decodeWav(readFileSync(join(a.dir, "takes", `${id}.wav`)));
			return resample(audio, rate);
		};
		// Each layer trimmed and levelled to full scale first, so gains compare layers as they're heard.
		const parts = a.layers.map((l) => ({
			audio: normalizePeak("take" in l ? trimSilence(take(l.take)) : [synth(l.synth)], 0),
			at: Math.round((l.at ?? 0) * RATE),
			gain: fromDb(l.gain ?? 0),
		}));
		const audio = processSound(a.processing, mix(parts));
		writeFileSync(a.out, encodeWav(audio));
		return measure(audio);
	},

	/** What an agent reads instead of listening to a take. */
	measureWav(a: { file: string }): Measurements {
		const { audio, rate } = decodeWav(readFileSync(a.file));
		return measure(resample(audio, rate));
	},
};
