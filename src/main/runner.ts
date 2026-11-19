// Builds, runs and tests the game through the project's `build.sh`, from the main checkout or a session's
// worktree. A run is driven over the engine's control protocol: frames are streamed into the studio (hidden
// mode), and the inspector, input and console are plain control commands.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { StudioEvent } from "../shared/ipc";
import {
	type CheckoutId,
	type CheckoutInfo,
	type RunInfo,
	type RunMode,
	type TestReport,
	pairReplies,
	parseDiagnostics,
	scriptCommands,
} from "../shared/run";
import { safeJoin, walk } from "./assets";
import { EngineClient, freePort } from "./engine-client";
import type { SessionService } from "./sessions";

// The live view streams JPEG screenshots. The engine encodes them off the main loop, but each takes about
// five frames end to end, so several are kept in flight to reach the target rate.
// See "Screenshots and streaming" in engine/docs/control-protocol.md.
const FRAME_INTERVAL_MS = 1000 / 30;
const FRAMES_IN_FLIGHT = 4;
const FRAME_REQUEST = { inline: true, format: "jpeg", quality: 80 };
const TEST_TIMEOUT_MS = 180_000;

interface ActiveRun {
	info: RunInfo;
	proc?: ChildProcess;
	client?: EngineClient;
}

export interface RunServiceDeps {
	projectPath(): string | null;
	sessions: SessionService;
	emit(event: StudioEvent): void;
}

interface ExecResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RunService {
	private run: ActiveRun | null = null;
	private streaming = false;
	private testQueue: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: RunServiceDeps) {}

	/** The main checkout plus every session worktree the game can be run from. */
	checkouts(): CheckoutInfo[] {
		const project = this.project();
		const out: CheckoutInfo[] = [{ sessionId: null, label: "Main checkout", cwd: project }];
		for (const s of this.deps.sessions.list()) {
			if (s.worktree !== "active") continue;
			if (s.target === "project") out.push({ sessionId: s.id, label: `Session: ${s.title}`, cwd: s.worktreePath });
			if (s.target === "engine") out.push({ sessionId: s.id, label: `Engine session: ${s.title}`, cwd: project, engineDir: s.worktreePath });
		}
		return out;
	}

	checkout(sessionId: CheckoutId): CheckoutInfo {
		const c = this.checkouts().find((x) => x.sessionId === sessionId);
		if (!c) throw new Error("That session has no worktree to run. Resume it first.");
		return c;
	}

	current(): RunInfo | null {
		return this.run?.info ?? null;
	}

	/** Builds the checkout without running it. Output streams to the run console. */
	async build(sessionId: CheckoutId): Promise<RunInfo> {
		return this.begin(sessionId, null);
	}

	/** Builds and starts the game with a control server. Stops any previous run first. */
	async start(sessionId: CheckoutId, mode: RunMode): Promise<RunInfo> {
		return this.begin(sessionId, mode);
	}

	private async begin(sessionId: CheckoutId, mode: RunMode | null): Promise<RunInfo> {
		const co = this.checkout(sessionId);
		await this.stop();
		const run: ActiveRun = {
			info: {
				id: `run-${Date.now().toString(36)}`,
				sessionId,
				label: co.label,
				mode: mode ?? "hidden",
				state: "building",
				diagnostics: [],
				startedAt: new Date().toISOString(),
			},
		};
		this.run = run;
		this.changed(run);

		const built = await this.exec(co, ["build"], (text) => this.output(run, text));
		if (this.run !== run) return run.info;
		run.info.diagnostics = parseDiagnostics(built.stdout + built.stderr, co.cwd);
		if (built.code !== 0) {
			run.info.state = "build_failed";
			this.changed(run);
			return run.info;
		}
		if (!mode) {
			run.info.state = "exited";
			run.info.exitCode = 0;
			this.changed(run);
			return run.info;
		}

		const port = await freePort();
		const args = [`--mode=${mode}`, `--control=${port}`];
		if (mode === "hidden") args.push("--fps=60");
		const proc = spawn(join(co.cwd, "build/game"), args, { cwd: co.cwd, env: { ...process.env, NO_COLOR: "1" } });
		run.proc = proc;
		run.info.port = port;
		run.info.state = "starting";
		this.changed(run);
		proc.stdout?.setEncoding("utf8").on("data", (t: string) => this.output(run, t));
		proc.stderr?.setEncoding("utf8").on("data", (t: string) => this.output(run, t));
		proc.on("error", (err) => this.output(run, `${err.message}\n`));
		proc.on("exit", (code) => {
			run.client?.close();
			run.info.state = "exited";
			run.info.exitCode = code;
			this.changed(run);
		});

		try {
			run.client = await EngineClient.connect(port, () => proc.exitCode === null && run.info.state === "starting");
		} catch (err) {
			this.output(run, `Could not connect to the game: ${(err as Error).message}\n`);
			proc.kill();
			return run.info;
		}
		if (run.info.state !== "starting") return run.info;
		run.info.state = "running";
		this.changed(run);
		if (mode === "hidden") void this.pumpFrames(run);
		return run.info;
	}

	/** Asks the game to quit, then kills it if it hasn't exited after two seconds. */
	async stop(): Promise<void> {
		const run = this.run;
		const proc = run?.proc;
		if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
		const exited = new Promise((r) => proc.once("exit", r));
		run.client?.call("quit").catch(() => {});
		if (!(await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]))) {
			proc.kill("SIGKILL");
			await exited;
		}
	}

	/** Sends a control-protocol command to the running game. */
	call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
		const client = this.run?.info.state === "running" ? this.run.client : undefined;
		if (!client) return Promise.reject(new Error("The game isn't running"));
		return client.call(cmd, args);
	}

	/** Frames are only captured while a view shows them (screenshots cost the game a few milliseconds each). */
	setStreaming(on: boolean): void {
		this.streaming = on;
	}

	/**
	 * Shows a model in the game's own engine: builds the checkout, runs it hidden, spawns the model on a plain
	 * ground plane far from the game's scene, and screenshots it from the front, three-quarter and back.
	 * Returns JPEG data URLs plus any engine errors logged while loading it (e.g. the vertex limit).
	 */
	async preview(sessionId: CheckoutId, glb: string, height: number): Promise<{ images: string[]; errors: string[] }> {
		const co = this.checkout(sessionId);
		const built = await this.exec(co, ["build"]);
		if (built.code !== 0) {
			throw new Error(`The game doesn't build, so it can't show the model:\n${(built.stdout + built.stderr).trim().split("\n").slice(-12).join("\n")}`);
		}
		const port = await freePort();
		const proc = spawn(join(co.cwd, "build/game"), ["--mode=hidden", `--control=${port}`, "--fps=60"], { cwd: co.cwd, env: { ...process.env, NO_COLOR: "1" } });
		let client: EngineClient | undefined;
		try {
			client = await EngineClient.connect(port, () => proc.exitCode === null);
			const at = [800, 0, 800];
			const size = Math.max(height, 0.5);
			await client.call("spawn", { name: "StudioPreviewGround", position: at, components: { Mesh_Renderer: { mesh: "plane", material: { color: [0.36, 0.38, 0.42, 1] } } } });
			await client.call("set", { entity: "StudioPreviewGround", component: "Transform", value: { scale: [size * 8, 1, size * 8] } });
			// Engine paths are relative to the assets folder.
			await client.call("spawn", { name: "StudioPreview", position: at, components: { Mesh_Renderer: { mesh: glb.replace(/^assets\//, "") } } });
			const images: string[] = [];
			const distance = size * 1.5 + 0.5;
			for (const yaw of [0, 35, 180]) {
				const a = (yaw * Math.PI) / 180;
				// The model faces +Z (the engine's forward), so the front view looks back along -Z.
				const position = [at[0] + Math.sin(a) * distance, size * 0.75, at[2] + Math.cos(a) * distance];
				await client.call("camera", { position, target: [at[0], size * 0.45, at[2]] });
				await client.call("wait", { frames: 6 });
				const shot = (await client.call("screenshot", { inline: true, format: "jpeg", quality: 90 })) as { jpeg_base64?: string; png_base64?: string };
				images.push(shot.jpeg_base64 ? `data:image/jpeg;base64,${shot.jpeg_base64}` : `data:image/png;base64,${shot.png_base64}`);
			}
			const logs = (await client.call("logs")) as { level: string; text: string }[];
			const errors = logs.filter((l) => l.level.trim() === "error" || (l.level.trim() === "warn" && /model|mesh|texture/i.test(l.text) && !/u32 to u16/.test(l.text))).map((l) => l.text);
			return { images, errors };
		} finally {
			await client?.call("quit").catch(() => {});
			client?.close();
			setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 2000);
		}
	}

	/** `tests/**.jsonl` in a checkout, repo-relative. */
	tests(sessionId: CheckoutId): string[] {
		const { cwd } = this.checkout(sessionId);
		return walk(join(cwd, "tests"), cwd)
			.filter((p) => p.endsWith(".jsonl"))
			.sort();
	}

	/** Runs one control script headlessly via `build.sh test`. Tests run one at a time. */
	test(sessionId: CheckoutId, script: string): Promise<TestReport> {
		const next = this.testQueue.then(() => this.runTest(sessionId, script));
		this.testQueue = next.catch(() => {});
		return next;
	}

	private async runTest(sessionId: CheckoutId, script: string): Promise<TestReport> {
		const co = this.checkout(sessionId);
		const text = readFileSync(safeJoin(co.cwd, script), "utf8");
		const started = Date.now();
		const r = await this.exec(co, ["test", script], undefined, TEST_TIMEOUT_MS);
		const buildOk = /^>> built /m.test(r.stdout);
		const { steps, notRun } = buildOk ? pairReplies(text, r.stdout) : { steps: [], notRun: scriptCommands(text).length };
		const screenshots = steps.flatMap((s) => {
			const path = s.ok && (s.result as { path?: unknown } | undefined)?.path;
			if (typeof path !== "string" || !path) return [];
			return [isAbsolute(path) ? relative(co.cwd, path) : path];
		});
		const report: TestReport = {
			script,
			sessionId,
			ok: buildOk && r.code === 0 && notRun === 0 && steps.every((s) => s.ok),
			buildOk,
			exitCode: r.code,
			steps,
			notRun,
			diagnostics: parseDiagnostics(r.stdout + r.stderr, co.cwd),
			screenshots,
			output: (r.stdout + r.stderr).slice(-20_000),
			durationMs: Date.now() - started,
			finishedAt: new Date().toISOString(),
		};
		this.deps.emit({ type: "test_report", report });
		return report;
	}

	/** A PNG from a checkout (test screenshots) as a data URL. */
	image(sessionId: CheckoutId, path: string): string {
		const full = safeJoin(this.checkout(sessionId).cwd, path);
		if (!path.toLowerCase().endsWith(".png") || !existsSync(full)) throw new Error(`No screenshot at ${path}`);
		return `data:image/png;base64,${readFileSync(full).toString("base64")}`;
	}

	dispose(): void {
		this.run?.proc?.kill("SIGKILL");
	}

	private project(): string {
		const p = this.deps.projectPath();
		if (!p) throw new Error("No project is open");
		return p;
	}

	private async pumpFrames(run: ActiveRun): Promise<void> {
		let inFlight = 0;
		let lastRequest = 0;
		while (this.run === run && run.info.state === "running") {
			if (this.streaming && inFlight < FRAMES_IN_FLIGHT && Date.now() - lastRequest >= FRAME_INTERVAL_MS) {
				lastRequest = Date.now();
				inFlight++;
				run.client!.call("screenshot", FRAME_REQUEST).then(
					(reply) => {
						inFlight--;
						// Engines older than JPEG support ignore `format` and reply with a PNG.
						const r = reply as { jpeg_base64?: string; png_base64?: string; width: number; height: number };
						const image = r.jpeg_base64 ?? r.png_base64;
						if (!image || this.run !== run) return;
						const mime = r.jpeg_base64 ? "image/jpeg" : "image/png";
						this.deps.emit({ type: "run_frame", runId: run.info.id, image, mime, width: r.width, height: r.height });
					},
					() => {
						// The game is exiting; the exit handler reports it.
						inFlight--;
					},
				);
			}
			await sleep(5);
		}
	}

	private exec(co: CheckoutInfo, args: string[], onOutput?: (text: string) => void, timeoutMs?: number): Promise<ExecResult> {
		return new Promise((resolve) => {
			const env = { ...process.env, NO_COLOR: "1", ...(co.engineDir ? { ENGINE_DIR: co.engineDir } : {}) };
			const proc = spawn(join(co.cwd, "build.sh"), args, { cwd: co.cwd, env });
			let stdout = "";
			let stderr = "";
			proc.stdout.setEncoding("utf8").on("data", (t: string) => {
				stdout += t;
				onOutput?.(t);
			});
			proc.stderr.setEncoding("utf8").on("data", (t: string) => {
				stderr += t;
				onOutput?.(t);
			});
			const timer = timeoutMs ? setTimeout(() => proc.kill("SIGKILL"), timeoutMs) : undefined;
			proc.on("error", (err) => {
				clearTimeout(timer);
				resolve({ code: null, stdout, stderr: `${stderr}${err.message}\n` });
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr });
			});
		});
	}

	private output(run: ActiveRun, text: string): void {
		this.deps.emit({ type: "run_output", runId: run.info.id, text });
	}

	private changed(run: ActiveRun): void {
		if (this.run === run) this.deps.emit({ type: "run_changed", run: { ...run.info } });
	}
}
