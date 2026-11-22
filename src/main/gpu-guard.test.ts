import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenJob } from "../shared/gen";
import { GenService } from "./gen";
import { GpuGuard } from "./gpu-guard";
import { tempDir, waitFor } from "./test-helpers";

const codeDir = resolve("gen");
const stops: (() => unknown)[] = [];
afterEach(async () => {
	for (const s of stops.splice(0)) await s();
});

function service(free: () => Promise<number | null> = async () => null) {
	const root = tempDir();
	const jobs: GenJob[] = [];
	const gen = new GenService({
		root,
		codeDir,
		emit: (e) => e.type === "gen_job" && jobs.push(structuredClone(e.job)),
		fake: true,
		gpu: new GpuGuard(root, free),
		gpuPollMs: 50,
	});
	stops.push(() => gen.dispose());
	const said = () => jobs.map((j) => j.progress?.message ?? "");
	return { root, gen, said };
}

describe("GPU guard", () => {
	it("waits while another live studio holds the GPU, and takes over a lock its holder left behind", async () => {
		const { root, gen, said } = service();
		const other = spawn("sleep", ["30"]);
		stops.push(() => other.kill());
		writeFileSync(join(root, "gpu.lock"), JSON.stringify({ pid: other.pid }));
		let done = false;
		const job = gen.run("image", { prompt: "a chest", out_dir: tempDir(), count: 1 }).then(() => (done = true));
		await waitFor(() => said().some((m) => m.includes("another Game Studio")));
		await new Promise((r) => setTimeout(r, 300));
		expect(done).toBe(false);
		other.kill(); // the other studio dies without giving the lock back
		await job;
		expect(done).toBe(true);
	}, 20_000);

	it("waits until the card has the memory a model needs, then loads it", async () => {
		let free = 1.5;
		const { gen, said } = service(async () => free);
		let done = false;
		const job = gen.run("voice", { text: "hello", voice: "a goblin", out: join(tempDir(), "a.wav") }).then(() => (done = true), () => (done = true));
		await waitFor(() => said().some((m) => m.startsWith("Waiting for 4 GB of GPU memory (1.5 GB free")));
		expect(done).toBe(false);
		free = 8; // the game closed
		await job;
		expect(said().some((m) => m.startsWith("Waiting"))).toBe(true);
	}, 20_000);

	it("lets a waiting job be cancelled", async () => {
		const { gen, said } = service(async () => 0.5);
		const job = gen.run("image", { prompt: "a chest", out_dir: tempDir(), count: 1 }).then(() => "done", () => "stopped");
		await waitFor(() => said().some((m) => m.startsWith("Waiting for")));
		gen.cancel(gen.list().find((j) => j.status === "running")!.id);
		expect(await job).toBe("stopped");
		expect(gen.list().at(-1)?.status ?? gen.list()[0].status).toBe("cancelled");
	}, 20_000);

	it("learns what a family needs from its measured peaks", () => {
		const guard = new GpuGuard(tempDir(), async () => null);
		expect(guard.need("image")).toBe(6);
		guard.recordPeak("image", 4.2);
		guard.recordPeak("image", 3.1); // a smaller job doesn't lower it
		expect(guard.need("image")).toBe(5);
	});
});
