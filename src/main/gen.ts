// Local asset generation: a job queue over Python model workers (see gen/workers/protocol.py) and Blender.
// Only one model family fits in VRAM at a time, so at most one GPU worker runs: switching families stops the
// current worker, and an idle worker is stopped after a while so games get the GPU back. Workers stay warm
// between jobs of the same family (loading a model takes 15-30 s).
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BLENDER_JOBS, FAMILY_OF, type GenComponent, type GenFamily, type GenJob, type GenJobKind, type GenStatus } from "../shared/gen";
import type { StudioEvent } from "../shared/ipc";

const WORKER_SCRIPT: Record<GenFamily, string> = {
	image: "image_worker.py",
	hunyuan3d: "hunyuan_worker.py",
	unirig: "unirig_worker.py",
	"stable-audio": "audio_worker.py",
};
const JOB_HISTORY = 200;

export interface GenServiceDeps {
	/** Environments, weights and model repos (default ~/.local/share/game-studio/gen). */
	root: string;
	/** The studio's `gen/` folder: workers, Blender scripts, setup.sh. */
	codeDir: string;
	emit(event: StudioEvent): void;
	/** Use gen/workers/fake_worker.py (system python3) for every family. */
	fake?: boolean;
	idleMs?: number;
	blender?: string;
}

interface Pending {
	resolve(result: Record<string, unknown>): void;
	reject(err: Error): void;
	onProgress(message: string, fraction?: number | null): void;
}

/** One running model worker process. */
class Worker {
	readonly proc: ChildProcess;
	readonly ready: Promise<void>;
	state: "starting" | "idle" | "busy" = "starting";
	private pending = new Map<string, Pending>();
	private exitError: Error | null = null;

	constructor(
		readonly family: GenFamily,
		command: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		private readonly log: (line: string) => void,
		onExit: () => void,
	) {
		this.proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
		this.ready = new Promise((resolve, reject) => {
			createInterface({ input: this.proc.stdout! }).on("line", (line) => {
				let msg: { id?: string; event?: string; result?: Record<string, unknown>; error?: string; message?: string; fraction?: number | null };
				try {
					msg = JSON.parse(line);
				} catch {
					this.log(line);
					return;
				}
				if (msg.event === "ready") {
					this.state = "idle";
					resolve();
					return;
				}
				const p = msg.id ? this.pending.get(msg.id) : undefined;
				if (!p) return;
				if (msg.event === "progress") p.onProgress(msg.message ?? "", msg.fraction);
				else if (msg.event === "done" || msg.event === "error") {
					this.pending.delete(msg.id!);
					this.state = "idle";
					if (msg.event === "done") p.resolve(msg.result ?? {});
					else p.reject(new Error(msg.error ?? "worker error"));
				}
			});
			createInterface({ input: this.proc.stderr! }).on("line", this.log);
			this.proc.on("error", (err) => {
				this.exitError = err;
				reject(err);
			});
			this.proc.on("exit", (code, signal) => {
				const err = this.exitError ?? new Error(`The ${family} worker exited (${signal ?? `code ${code}`}); see ${family}.log`);
				reject(err);
				for (const p of this.pending.values()) p.reject(err);
				this.pending.clear();
				onExit();
			});
		});
		this.ready.catch(() => {});
	}

	async request(id: string, op: string, params: Record<string, unknown>, onProgress: Pending["onProgress"]): Promise<Record<string, unknown>> {
		await this.ready;
		this.state = "busy";
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject, onProgress });
			this.proc.stdin!.write(`${JSON.stringify({ id, op, params })}\n`);
		});
	}

	get alive(): boolean {
		return this.proc.exitCode === null && this.proc.signalCode === null;
	}

	stop(): Promise<void> {
		if (!this.alive) return Promise.resolve();
		const exited = new Promise<void>((r) => this.proc.once("exit", () => r()));
		this.proc.stdin!.end();
		this.proc.kill("SIGTERM");
		const kill = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
		return exited.finally(() => clearTimeout(kill));
	}
}

export class GenService {
	private jobs: GenJob[] = [];
	private worker: Worker | null = null;
	private idleTimer: NodeJS.Timeout | undefined;
	private running: { job: GenJob; cancel(): void } | null = null;
	private waiters = new Map<string, { resolve(job: GenJob): void }[]>();
	private installer: ChildProcess | null = null;
	private nextId = 1;

	constructor(private readonly deps: GenServiceDeps) {}

	list(): GenJob[] {
		return this.jobs.map((j) => ({ ...j }));
	}

	get(id: string): GenJob {
		const job = this.jobs.find((j) => j.id === id);
		if (!job) throw new Error(`No generation job ${id}`);
		return { ...job };
	}

	/** Queues a job and returns it immediately; use `wait` for the result. */
	submit(kind: GenJobKind, params: Record<string, unknown>, opts: { label?: string; sessionId?: string } = {}): GenJob {
		const job: GenJob = {
			id: `gen-${Date.now().toString(36)}-${this.nextId++}`,
			kind,
			label: opts.label ?? kind,
			params,
			status: "queued",
			sessionId: opts.sessionId,
			createdAt: new Date().toISOString(),
		};
		this.jobs.push(job);
		if (this.jobs.length > JOB_HISTORY) this.jobs.splice(0, this.jobs.length - JOB_HISTORY);
		this.changed(job);
		void this.pump();
		return { ...job };
	}

	/** Resolves when the job finishes (done, failed or cancelled). */
	wait(id: string): Promise<GenJob> {
		const job = this.get(id);
		if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return Promise.resolve(job);
		return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), { resolve }]));
	}

	/** Submits, waits, and throws if the job didn't succeed. */
	async run(kind: GenJobKind, params: Record<string, unknown>, opts: { label?: string; sessionId?: string; onProgress?(job: GenJob): void } = {}): Promise<Record<string, unknown>> {
		const { id } = this.submit(kind, params, opts);
		const off = opts.onProgress ? this.onProgress(id, opts.onProgress) : () => {};
		try {
			const job = await this.wait(id);
			if (job.status !== "done") throw new Error(job.status === "cancelled" ? `${job.label}: cancelled` : `${job.label}: ${job.error}`);
			return job.result ?? {};
		} finally {
			off();
		}
	}

	cancel(id: string): void {
		const job = this.jobs.find((j) => j.id === id);
		if (!job) return;
		if (job.status === "queued") this.finish(job, "cancelled");
		else if (job.status === "running" && this.running?.job === job) this.running.cancel();
	}

	/** Cancels everything a session queued (e.g. when its agent is stopped). */
	cancelSession(sessionId: string): void {
		for (const j of this.jobs.filter((x) => x.sessionId === sessionId)) this.cancel(j.id);
	}

	status(): GenStatus {
		const { root, codeDir } = this.deps;
		const exists = (p: string) => existsSync(join(root, p));
		const component = (id: string, name: string, needs: string[]): GenComponent => {
			const missing = needs.filter((p) => !exists(p));
			return { id, name, ok: missing.length === 0, detail: missing.length ? `missing ${missing.join(", ")}` : "installed" };
		};
		const components = this.deps.fake
			? [{ id: "fake", name: "Fake worker (tests)", ok: existsSync(join(codeDir, "workers/fake_worker.py")), detail: "GAME_STUDIO_GEN_FAKE=1" }]
			: [
					component("image", "Concept images (FLUX.2 Klein)", ["envs/image/bin/python", "models/black-forest-labs/FLUX.2-klein-4B/transformer"]),
					component("shape", "3D shape (Hunyuan3D-2mini/2mv)", [
						"envs/hunyuan3d/bin/python",
						"models/tencent/Hunyuan3D-2mini/hunyuan3d-dit-v2-mini-turbo",
						"models/tencent/Hunyuan3D-2mv/hunyuan3d-dit-v2-mv-turbo",
					]),
					component("texture", "Texture (Hunyuan3D-Paint)", [
						"models/tencent/Hunyuan3D-2/hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.bin",
						"models/tencent/Hunyuan3D-2/hunyuan3d-delight-v2-0",
					]),
					component("rig", "Rigging (UniRig)", [
						"envs/unirig/bin/python",
						"src/UniRig/experiments/skeleton/articulation-xl_quantization_256/model.ckpt",
						"src/UniRig/experiments/skin/articulation-xl/model.ckpt",
					]),
					component("sound", "Sound effects (Stable Audio Open Small)", [
						"envs/stable-audio/bin/python",
						"models/stabilityai/stable-audio-open-small/model.safetensors",
						"models/laion/larger_clap_general/pytorch_model.bin",
					]),
				];
		components.push(musicComponent(soundfontPath(root)));
		return {
			root,
			ready: components.every((c) => c.ok),
			components,
			worker: this.worker?.alive ? { family: this.worker.family, state: this.worker.state } : null,
			fake: !!this.deps.fake,
			installing: !!this.installer,
		};
	}

	/** Runs gen/setup.sh (idempotent): environments, weights, patches. Output streams as `gen_setup` events. */
	install(): void {
		if (this.installer) throw new Error("Setup is already running");
		const proc = spawn("bash", [join(this.deps.codeDir, "setup.sh")], { env: { ...process.env, GAME_STUDIO_GEN: this.deps.root } });
		this.installer = proc;
		const out = (chunk: Buffer) => this.deps.emit({ type: "gen_setup", text: chunk.toString() });
		proc.stdout.on("data", out);
		proc.stderr.on("data", out);
		proc.on("close", (code) => {
			this.installer = null;
			this.deps.emit({ type: "gen_setup", text: `\n${code === 0 ? "Setup finished." : `Setup failed (exit ${code}).`}\n`, done: true, ok: code === 0 });
			this.deps.emit({ type: "gen_changed" });
		});
		this.deps.emit({ type: "gen_changed" });
	}

	async dispose(): Promise<void> {
		clearTimeout(this.idleTimer);
		for (const j of this.jobs.filter((x) => x.status === "queued")) this.finish(j, "cancelled");
		this.running?.cancel();
		this.installer?.kill();
		await this.worker?.stop();
	}

	private onProgress(id: string, listener: (job: GenJob) => void): () => void {
		const handler = (e: StudioEvent) => e.type === "gen_job" && e.job.id === id && listener(e.job);
		this.progressListeners.add(handler);
		return () => this.progressListeners.delete(handler);
	}

	private progressListeners = new Set<(e: StudioEvent) => void>();

	private async pump(): Promise<void> {
		if (this.running) return;
		const job = this.jobs.find((j) => j.status === "queued");
		if (!job) return;
		clearTimeout(this.idleTimer);
		job.status = "running";
		job.startedAt = new Date().toISOString();
		this.changed(job);
		let cancelled = false;
		try {
			const result =
				(BLENDER_JOBS as readonly string[]).includes(job.kind)
					? await this.blender(job, (cancel) => (this.running = { job, cancel: () => ((cancelled = true), cancel()) }))
					: await this.onWorker(job, (cancel) => (this.running = { job, cancel: () => ((cancelled = true), cancel()) }));
			job.result = { ...result, seconds: result.seconds ?? Math.round((Date.now() - Date.parse(job.startedAt!)) / 100) / 10 };
			this.finish(job, "done");
		} catch (err) {
			job.error = (err as Error).message;
			this.finish(job, cancelled ? "cancelled" : "failed");
		} finally {
			this.running = null;
			if (this.worker && !this.jobs.some((j) => j.status === "queued")) {
				this.idleTimer = setTimeout(() => void this.stopWorker(), this.deps.idleMs ?? 5 * 60_000);
			}
			void this.pump();
		}
	}

	private async onWorker(job: GenJob, setCancel: (cancel: () => void) => void): Promise<Record<string, unknown>> {
		const { family, op } = FAMILY_OF[job.kind as keyof typeof FAMILY_OF];
		if (this.worker && (this.worker.family !== family || !this.worker.alive)) await this.stopWorker();
		if (!this.worker) this.worker = this.startWorker(family);
		const worker = this.worker;
		setCancel(() => void worker.stop());
		job.progress = { message: worker.state === "starting" ? `Starting the ${family} worker` : "Starting" };
		this.changed(job);
		return worker.request(job.id, op, job.params, (message, fraction) => {
			job.progress = { message, fraction };
			this.changed(job);
		});
	}

	private startWorker(family: GenFamily): Worker {
		const { root, codeDir, fake } = this.deps;
		const python = fake ? "python3" : join(root, "envs", family, "bin/python");
		const script = join(codeDir, "workers", fake ? "fake_worker.py" : WORKER_SCRIPT[family]);
		if (!fake && !existsSync(python)) throw new Error(`The ${family} environment isn't installed (Settings → Asset generation)`);
		const env = { ...process.env, GAME_STUDIO_GEN: root, PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True", PYTHONUNBUFFERED: "1" };
		const worker = new Worker(family, python, [script], env, this.logger(family), () => {
			if (this.worker === worker) this.worker = null;
			this.deps.emit({ type: "gen_changed" });
		});
		this.deps.emit({ type: "gen_changed" });
		void worker.ready.then(() => this.deps.emit({ type: "gen_changed" }), () => {});
		return worker;
	}

	private async stopWorker(): Promise<void> {
		const w = this.worker;
		this.worker = null;
		clearTimeout(this.idleTimer);
		await w?.stop();
		this.deps.emit({ type: "gen_changed" });
	}

	/** Runs gen/blender/finalize.py headless; it prints "RESULT: {json}". */
	private blender(job: GenJob, setCancel: (cancel: () => void) => void): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const script = join(this.deps.codeDir, `blender/${job.kind}.py`);
			const proc = spawn(this.deps.blender ?? "blender", ["-b", "--factory-startup", "--python", script, "--", JSON.stringify(job.params)]);
			setCancel(() => proc.kill("SIGKILL"));
			const log = this.logger("blender");
			let result: Record<string, unknown> | null = null;
			let lastError = "";
			job.progress = { message: `Blender: ${job.kind.replace("_", " ")}` };
			this.changed(job);
			for (const stream of [proc.stdout, proc.stderr]) {
				createInterface({ input: stream }).on("line", (line) => {
					if (line.startsWith("RESULT: ")) result = JSON.parse(line.slice(8));
					else {
						log(line);
						if (/Error|SystemExit|could not/.test(line)) lastError = line;
					}
				});
			}
			proc.on("error", reject);
			proc.on("close", (code) => {
				if (result && code === 0) resolve(result);
				else reject(new Error(`Blender ${job.kind} failed (exit ${code}): ${lastError || "see blender.log"}`));
			});
		});
	}

	private logger(name: string): (line: string) => void {
		const dir = join(this.deps.root, "logs");
		return (line) => {
			try {
				mkdirSync(dir, { recursive: true });
				appendFileSync(join(dir, `${name}.log`), `${line}\n`);
			} catch {
				// Logging must never break a job.
			}
		};
	}

	private finish(job: GenJob, status: GenJob["status"]): void {
		job.status = status;
		job.finishedAt = new Date().toISOString();
		if (status !== "running") job.progress = undefined;
		this.changed(job);
		for (const w of this.waiters.get(job.id) ?? []) w.resolve({ ...job });
		this.waiters.delete(job.id);
	}

	private changed(job: GenJob): void {
		const event: StudioEvent = { type: "gen_job", job: { ...job } };
		this.deps.emit(event);
		for (const l of this.progressListeners) l(event);
	}
}

/** The General MIDI SoundFont music is rendered with (gen/setup.sh downloads it). */
export function soundfontPath(root: string): string {
	return process.env.GAME_STUDIO_SOUNDFONT ?? join(root, "models/soundfonts/GeneralUser-GS.sf2");
}

const onPath = (cmd: string) => (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, cmd)));

/** Music rendering runs on the CPU: FluidSynth and ffmpeg from the system, plus the SoundFont. */
function musicComponent(soundfont: string): GenComponent {
	const missing = [
		...(existsSync(soundfont) ? [] : ["the SoundFont (Install)"]),
		...["fluidsynth", "ffmpeg"].filter((c) => !onPath(c)).map((c) => `${c} (system package: pacman -S ${c})`),
	];
	return { id: "music", name: "Music rendering (FluidSynth + GeneralUser GS)", ok: !missing.length, detail: missing.length ? `missing ${missing.join(", ")}` : "installed" };
}
