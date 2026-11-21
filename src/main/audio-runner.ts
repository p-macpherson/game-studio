// Runs the audio jobs (audio-jobs.ts): in a worker thread in the app, inline where there is no built worker (tests).
import { Worker } from "node:worker_threads";

type Jobs = typeof import("./audio-jobs").JOBS;
export type AudioRun = <K extends keyof Jobs>(job: K, args: Parameters<Jobs[K]>[0]) => Promise<ReturnType<Jobs[K]>>;

/** On the calling thread (it blocks while a job runs). */
export const inlineAudio: AudioRun = async (job, args) => {
	const { JOBS } = await import("./audio-jobs");
	return (JOBS[job] as (a: unknown) => unknown)(args) as never;
};

/**
 * In one worker thread started from `file` (the built audio-worker.js), on first use; jobs queue there in order. A
 * worker that dies fails the jobs it had and is started again for the next one.
 */
export function workerAudio(file: string): AudioRun & { dispose(): void } {
	let worker: Worker | undefined;
	let nextId = 1;
	const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	const failAll = (err: Error) => {
		for (const p of pending.values()) p.reject(err);
		pending.clear();
		worker = undefined;
	};
	const start = () => {
		const w = new Worker(file);
		w.unref(); // never keeps the app from quitting
		w.on("message", (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
			const p = pending.get(m.id);
			if (!p) return;
			pending.delete(m.id);
			if (m.ok) p.resolve(m.result);
			else p.reject(new Error(m.error));
		});
		w.on("error", (err) => worker === w && failAll(err as Error));
		w.on("exit", (code) => worker === w && failAll(new Error(`the audio worker exited (${code})`)));
		return w;
	};
	const run: AudioRun = (job, args) =>
		new Promise((resolve, reject) => {
			worker ??= start();
			const id = nextId++;
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			worker.postMessage({ id, job, args });
		});
	return Object.assign(run, {
		dispose() {
			const w = worker;
			worker = undefined;
			void w?.terminate();
		},
	});
}
