// Builds, runs and tests the game through the project's `build.sh`, from the main checkout or a session's
// worktree. A run is driven over the engine's control protocol: frames are streamed into the studio (hidden
// mode), and the inspector, input and console are plain control commands.
import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { StudioEvent } from "../shared/ipc";
import {
	type CheckoutId,
	type CheckoutInfo,
	type RunInfo,
	type RunMode,
	type RunOptions,
	type TestReport,
	pairReplies,
	parseDiagnostics,
	scriptCommands,
} from "../shared/run";
import { parseScene, type SceneEntity, validateScene } from "../shared/scene";
import { safeJoin, walk } from "./assets";
import { normalizeSceneFile } from "./scenes";
import { EngineClient, freePort } from "./engine-client";
import type { SessionService } from "./sessions";

// The live view streams JPEG screenshots. The engine encodes them off the main loop, but each takes about
// five frames end to end, so several are kept in flight to reach the target rate.
// See "Screenshots and streaming" in engine/docs/control-protocol.md.
const FRAME_INTERVAL_MS = 1000 / 30;
const FRAMES_IN_FLIGHT = 4;
const FRAME_REQUEST = { inline: true, format: "jpeg", quality: 80 };
const TEST_TIMEOUT_MS = 180_000;
/** A build takes a second or two; one still going after this is stuck, and everything queued behind it in its checkout waits. */
const BUILD_TIMEOUT_MS = 10 * 60_000;

export type SceneView = "top" | "overview" | "game" | { position: number[]; target: number[] };

/** Centre and size of what a scene places (top-level positions; huge scaled entities like the ground left out). */
export function sceneBounds(entities: SceneEntity[]): { center: number[]; extent: number } {
	const ps = entities.flatMap((e) => {
		const t = e.Transform as { position?: number[]; parent?: number; scale?: number[] } | undefined;
		if (t?.parent || (t?.scale && Math.max(...t.scale) > 8)) return [];
		return Array.isArray(t?.position) && t.position.length === 3 ? [t.position] : [[0, 0, 0]];
	});
	if (ps.length === 0) return { center: [0, 0, 0], extent: 4 };
	const lo = [0, 1, 2].map((i) => Math.min(...ps.map((p) => p[i])));
	const hi = [0, 1, 2].map((i) => Math.max(...ps.map((p) => p[i])));
	const center = [(lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2];
	return { center, extent: Math.max(3, (Math.max(hi[0] - lo[0], hi[2] - lo[2]) / 2) * 1.15 + 1.5) };
}

/**
 * Starts a game binary. A build the studio doesn't control (an agent's own ./build.sh) may still be writing it, and
 * Linux refuses to start a file open for writing (spawn throws ETXTBSY): wait for the build to finish.
 */
export async function spawnGame(file: string, args: string[], options: SpawnOptions, timeoutMs = 20_000): Promise<ChildProcess> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return spawn(file, args, options);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ETXTBSY" || Date.now() > deadline) throw err;
			await sleep(100);
		}
	}
}

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
	private turns = new Map<string, Promise<unknown>>();
	/** Every build, test and game this service started that is still running (killed on quit). */
	private children = new Set<ChildProcess>();

	constructor(private readonly deps: RunServiceDeps) {}

	/** The main checkout plus every worktree the game can be run from (the id is the worktree's). */
	checkouts(): CheckoutInfo[] {
		const project = this.project();
		const out: CheckoutInfo[] = [{ sessionId: null, label: "Main checkout", cwd: project }];
		for (const w of this.deps.sessions.listWorktrees()) {
			if (w.checkout !== "active" || w.status !== "active") continue;
			if (w.target === "project") out.push({ sessionId: w.id, label: `Worktree: ${w.label}`, cwd: w.path });
			if (w.target === "engine") out.push({ sessionId: w.id, label: `Engine worktree: ${w.label}`, cwd: project, engineDir: w.path });
		}
		return out;
	}

	/** A checkout by worktree id, or by the id of a session working in it. */
	checkout(id: CheckoutId): CheckoutInfo {
		const list = this.checkouts();
		const worktreeId = id && !list.some((x) => x.sessionId === id) ? this.deps.sessions.list().find((s) => s.id === id)?.worktreeId : id;
		const c = list.find((x) => x.sessionId === (worktreeId ?? null));
		if (!c) throw new Error("That worktree isn't checked out. Reopen it first.");
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
	async start(sessionId: CheckoutId, mode: RunMode, options: RunOptions = {}): Promise<RunInfo> {
		return this.begin(sessionId, mode, options);
	}

	private async begin(sessionId: CheckoutId, mode: RunMode | null, options: RunOptions = {}): Promise<RunInfo> {
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
				scene: options.scene,
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
		if (options.scene) args.push("--paused", `--scene=${options.scene}`);
		const proc = await this.launch(co, args);
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
		if (options.scene) await run.client.call("debug", { game_ui: false }).catch(() => {});
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
		const proc = await this.launch(co, ["--mode=hidden", `--control=${port}`, "--fps=60"]);
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

	/**
	 * Shows a scene or prefab (repo-relative path) in the game's own engine, paused, with the game's UI hidden, from
	 * each view: "top", "overview" (three-quarter), "game" (the scene's own camera), or a {position, target}. Views
	 * are framed on the file's entity positions. Returns JPEG data URLs and the engine's warnings.
	 */
	async previewScene(sessionId: CheckoutId, path: string, views: SceneView[] = ["top", "overview", "game"]): Promise<{ images: { view: string; image: string }[]; warnings: string[] }> {
		const co = this.checkout(sessionId);
		const file = safeJoin(co.cwd, path);
		if (!existsSync(file)) throw new Error(`No ${path} in this checkout`);
		const reformatted = normalizeSceneFile(file);
		const { scene, errors } = parseScene(readFileSync(file, "utf8"));
		const problems = [
			...(reformatted ? [`${path} was rewritten in another layout; it's back to one entity per line (keep that layout when you edit it, so diffs stay small)`] : []),
			...errors,
			...(scene ? validateScene(scene) : []),
		];
		const built = await this.exec(co, ["build"]);
		if (built.code !== 0) {
			throw new Error(`The game doesn't build, so it can't show the scene:\n${(built.stdout + built.stderr).trim().split("\n").slice(-12).join("\n")}`);
		}
		return this.shoot(co, path.replace(/^assets\//, ""), scene?.entities ?? [], views, problems);
	}

	/**
	 * A texture on a 6 m ground plane and a sphere, lit by a sun, in the game's engine: a scene written to a temp
	 * file (outside the project) with the texture's files by absolute path, so nothing in the checkout changes.
	 */
	async previewTexture(sessionId: CheckoutId, files: { texture: string; normal_map: string; roughness_map: string }, tile: number): Promise<{ images: { view: string; image: string }[]; warnings: string[] }> {
		const co = this.checkout(sessionId);
		const abs = (p: string) => safeJoin(co.cwd, `assets/${p}`);
		for (const f of Object.values(files)) if (!existsSync(abs(f))) throw new Error(`${f} hasn't been made yet`);
		const built = await this.exec(co, ["build"]);
		if (built.code !== 0) throw new Error(`The game doesn't build, so it can't show the texture:\n${(built.stdout + built.stderr).trim().split("\n").slice(-12).join("\n")}`);
		const material = (repeat: number) => ({ texture: abs(files.texture), normal_map: abs(files.normal_map), roughness_map: abs(files.roughness_map), uv_scale: [repeat, repeat] });
		const entities = [
			{ id: 1, Name: "Sun", Transform: { rotation: [40, 35, 0] }, Light: { kind: "Directional", intensity: 1.2, shadows: true } },
			{ id: 2, Name: "Ground", Transform: { scale: [6, 1, 6] }, Mesh_Renderer: { mesh: "plane", material: material(6 / tile) } },
			{ id: 3, Name: "Sphere", Transform: { position: [1.2, 0.8, 1.2], scale: [1.6, 1.6, 1.6] }, Mesh_Renderer: { mesh: "sphere", material: material(Math.max(1, (1.6 * Math.PI) / tile)) } },
		];
		const dir = mkdtempSync(join(tmpdir(), "gs-texture-"));
		const file = join(dir, "preview.json");
		writeFileSync(file, JSON.stringify({ entities }));
		try {
			return await this.shoot(co, file, entities as SceneEntity[], [{ position: [-2.6, 2.4, -2.6], target: [0.4, 0, 0.4] }, { position: [0.2, 7, -0.3], target: [0, 0, 0] }], []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	/** Runs the built game paused on `scene` (engine-relative or absolute) and screenshots each view. */
	private async shoot(co: CheckoutInfo, scene: string, entities: SceneEntity[], views: SceneView[], problems: string[]) {
		const port = await freePort();
		const args = ["--mode=hidden", `--control=${port}`, "--fps=60", "--paused", `--scene=${scene}`];
		const proc = await this.launch(co, args);
		let client: EngineClient | undefined;
		try {
			client = await EngineClient.connect(port, () => proc.exitCode === null);
			await client.call("debug", { game_ui: false });
			const { center, extent } = sceneBounds(entities);
			const images: { view: string; image: string }[] = [];
			for (const view of views) {
				if (view === "game") {
					await client.call("camera", { reset: true });
				} else {
					const cam =
						view === "top"
							? { position: [center[0], extent * 2.2, center[2] - extent * 0.02], target: center }
							: view === "overview"
								? { position: [center[0] + extent * 0.5, extent * 1.1, center[2] - extent * 1.5], target: center }
								: view;
					await client.call("camera", { ...cam, fov: 50 });
				}
				await client.call("wait", { frames: 4 });
				const shot = (await client.call("screenshot", { inline: true, format: "jpeg", quality: 85 })) as { jpeg_base64: string };
				images.push({ view: typeof view === "string" ? view : JSON.stringify(view), image: `data:image/jpeg;base64,${shot.jpeg_base64}` });
			}
			const logs = (await client.call("logs")) as { level: string; text: string }[];
			const warnings = [...problems, ...logs.filter((l) => ["warn", "error"].includes(l.level.trim()) && !/u32 to u16/.test(l.text)).map((l) => l.text)];
			return { images, warnings };
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
		for (const proc of this.children) proc.kill("SIGKILL");
		this.children.clear();
	}

	private track<P extends ChildProcess>(proc: P): P {
		this.children.add(proc);
		proc.once("exit", () => this.children.delete(proc));
		proc.once("error", () => this.children.delete(proc));
		return proc;
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

	/**
	 * Runs one step for a checkout after the previous one has finished. A build rewrites build/game for most of its
	 * run, and Linux won't start a binary that is open for writing (ETXTBSY), so the studio's builds, tests and game
	 * launches in one checkout take turns (the Scenes view and an agent's preview_scene used to collide).
	 */
	private inTurn<T>(cwd: string, step: () => Promise<T>): Promise<T> {
		const next = (this.turns.get(cwd) ?? Promise.resolve()).then(step, step);
		this.turns.set(cwd, next.catch(() => {}));
		return next;
	}

	/** Starts the checkout's game binary in its turn. */
	private launch(co: CheckoutInfo, args: string[]): Promise<ChildProcess> {
		return this.inTurn(co.cwd, async () => this.track(await spawnGame(join(co.cwd, "build/game"), args, { cwd: co.cwd, env: { ...process.env, NO_COLOR: "1" } })));
	}

	private exec(co: CheckoutInfo, args: string[], onOutput?: (text: string) => void, timeoutMs?: number): Promise<ExecResult> {
		return this.inTurn(co.cwd, () => this.execNow(co, args, onOutput, timeoutMs));
	}

	private execNow(co: CheckoutInfo, args: string[], onOutput?: (text: string) => void, timeoutMs = BUILD_TIMEOUT_MS): Promise<ExecResult> {
		return new Promise((resolve) => {
			const env = { ...process.env, NO_COLOR: "1", ...(co.engineDir ? { ENGINE_DIR: co.engineDir } : {}) };
			const proc = this.track(spawn(join(co.cwd, "build.sh"), args, { cwd: co.cwd, env }));
			let timedOut = false;
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
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGKILL");
			}, timeoutMs);
			proc.on("error", (err) => {
				clearTimeout(timer);
				resolve({ code: null, stdout, stderr: `${stderr}${err.message}\n` });
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				if (timedOut) stderr += `build.sh ${args.join(" ")} was stopped: no result after ${Math.round(timeoutMs / 1000)} s\n`;
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
