// The AudioWorklet the Sound Effects section's live preview plays through: the engine's per-sound effects, ported
// (src/shared/sound-fx.ts), so what's heard is what the game will do. New effects arrive as messages and glide in, as
// set_voice_effects does in the game.
import { fxProcess, fxState, type SoundEffects } from "../../shared/sound-fx";

// The worklet scope's globals (not in TypeScript's DOM library).
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}

class SoundFxProcessor extends AudioWorkletProcessor {
	private state: ReturnType<typeof fxState>;
	constructor(options: { processorOptions?: { effects?: SoundEffects } }) {
		super();
		this.state = fxState(options.processorOptions?.effects ?? {});
		this.port.onmessage = (e: MessageEvent<SoundEffects>) => {
			this.state.target = e.data;
		};
	}
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const input = inputs[0];
		const output = outputs[0];
		if (!input?.length) return true;
		for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)]);
		fxProcess(this.state, output, sampleRate);
		return true;
	}
}

registerProcessor("sound-fx", SoundFxProcessor);
