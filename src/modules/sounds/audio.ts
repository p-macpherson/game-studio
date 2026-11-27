// The Sound Effects section's playback: decoding (cached per URL) and one sound at a time across the section.
import { useEffect, useState } from "react";

export interface Decoded {
	buffer: AudioBuffer;
	/** Mono mix. */
	mono: Float32Array;
	peak: number;
	/** The part above -50 dB below the peak (what trimming keeps), in samples. */
	start: number;
	end: number;
}

let audioContext: AudioContext | undefined;
export const ac = () => (audioContext ??= new AudioContext());
const decoded = new Map<string, Promise<Decoded>>();

export function decode(url: string): Promise<Decoded> {
	let p = decoded.get(url);
	if (!p) {
		p = fetch(url)
			.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
			.then((b) => ac().decodeAudioData(b))
			.then((buffer) => {
				const mono = new Float32Array(buffer.length);
				for (let c = 0; c < buffer.numberOfChannels; c++) {
					const ch = buffer.getChannelData(c);
					for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buffer.numberOfChannels;
				}
				let peak = 0;
				for (const v of mono) peak = Math.max(peak, Math.abs(v));
				const limit = peak * 10 ** (-50 / 20);
				let start = mono.findIndex((v) => Math.abs(v) > limit);
				let end = mono.length;
				while (end > 0 && Math.abs(mono[end - 1]) <= limit) end--;
				if (start < 0) [start, end] = [0, mono.length];
				return { buffer, mono, peak, start, end };
			});
		decoded.set(url, p);
		p.catch(() => decoded.delete(url));
	}
	return p;
}

/** One sound plays at a time across the section. */
let playing: { stop(): void } | null = null;

/** Takes over from whatever the section is playing (the live-effects preview): stops it, and `stop` is called when the
 * next thing plays. */
export function takeOverPlayback(stop: () => void): void {
	playing?.stop();
	playing = { stop };
}

export function usePlayer() {
	const [current, setCurrent] = useState<string | null>(null);
	useEffect(() => () => playing?.stop(), []);
	/** Plays a file (`level`: trimmed and brought up to -1 dBFS, as a variant would be). Again stops it. */
	const toggle = async (url: string, opts: { level?: boolean; rate?: number; loop?: boolean; id?: string } = {}) => {
		const id = opts.id ?? url;
		playing?.stop();
		playing = null;
		if (current === id) return setCurrent(null);
		setCurrent(id);
		const d = await decode(url).catch(() => null);
		if (!d) return setCurrent(null);
		const src = ac().createBufferSource();
		src.buffer = d.buffer;
		src.loop = !!opts.loop;
		src.playbackRate.value = opts.rate ?? 1; // tape-style, as the engine's pitch
		const gain = ac().createGain();
		gain.gain.value = opts.level && d.peak > 1e-6 ? 0.89 / d.peak : 1;
		src.connect(gain).connect(ac().destination);
		src.onended = () => setCurrent((c) => (c === id ? null : c));
		const offset = opts.level ? d.start / d.buffer.sampleRate : 0;
		src.start(0, offset, opts.level && !opts.loop ? (d.end - d.start) / d.buffer.sampleRate : undefined);
		playing = { stop: () => src.stop() };
	};
	return { current, toggle };
}

export type Player = ReturnType<typeof usePlayer>;

