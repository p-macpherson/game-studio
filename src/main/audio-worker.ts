// The worker thread behind workerAudio (audio-runner.ts): runs one audio job per message.
import { parentPort } from "node:worker_threads";
import { JOBS } from "./audio-jobs";

parentPort!.on("message", ({ id, job, args }: { id: number; job: keyof typeof JOBS; args: unknown }) => {
	try {
		parentPort!.postMessage({ id, ok: true, result: (JOBS[job] as (a: unknown) => unknown)(args) });
	} catch (err) {
		parentPort!.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
});
