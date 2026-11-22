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
import { effectTextures, parseEffect } from "../shared/effect";
import { parseShader, type ShaderInfo, shaderPath, validateShaderParams } from "../shared/shader";
import { normalizeSceneFile, shaderProblems } from "./scenes";
import { readScreen } from "./ui";
import { screenInterface } from "../shared/ui-screen";
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
	/** Removes what the run needed outside the checkout (the Shaders view's temp scene). */
	cleanup?(): void;
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

/** What preview_effect shows: an effect (by name) at some moments, on a plain ground or in a scene. */
export interface EffectPreview {
	effect: string;
	/** Seconds into the effect (default 0.1, 0.3, 0.6, 1, 1.6; at most 8). */
	times?: number[];
	/** The plain ground's light (default dark: glows read best at night). */
	background?: "dark" | "light";
	/** Play it in this scene (repo-relative) instead, at `position`. */
	scene?: string;
	position?: number[];
	view?: { position: number[]; target: number[] };
	post?: Record<string, unknown>;
	seed?: number;
}

/** What preview_shader shows: a shader (by name) on a mesh, or in a scene, at some moments. */
export interface ShaderPreview {
	shader: string;
	params?: Record<string, unknown>;
	/** A built-in mesh ("sphere", "cube", "grid", "plane", …) or a model path ("models/fern/fern.glb"). Default: grid when it moves vertices, else sphere. */
	mesh?: string;
	transparent?: boolean;
	/** Shader times (seconds) to show; default 0, 0.5, 1, 1.5; at most 8. */
	times?: number[];
	/** Show it in this scene (repo-relative) as the scene uses it, instead of on a mesh. */
	scene?: string;
	view?: { position: number[]; target: number[] };
	/** Post-processing for the preview (the environment's `post`). */
	post?: Record<string, unknown>;
}

/**
 * The scene shaders are previewed in: a sun, a ground, the shader on `Subject` (a flat mesh lifted clear of the ground
 * by how far it may move vertices) and a stone beside it, so transparency and depth_fade show; and a camera for it.
 */
export function shaderPreviewScene(info: ShaderInfo, p: { shader: string; params?: Record<string, unknown>; mesh?: string; transparent?: boolean }) {
	const mesh = p.mesh ?? (info.hasVertex ? "grid" : "sphere");
	const flat = mesh === "plane" || mesh === "grid";
	const model = mesh.includes("/");
	const subject = {
		id: 3,
		Name: "Subject",
		Transform: flat ? { position: [0, info.hasVertex ? Math.max(info.bounds, 0.3) + 0.05 : 0.05, 0], scale: [3, 1, 3] } : { position: [0, model ? 0 : 0.75, 0], scale: model ? [1, 1, 1] : [1.3, 1.3, 1.3] },
		Mesh_Renderer: { mesh, material: { shader: shaderPath(p.shader), ...(p.params ? { params: p.params } : {}), ...(p.transparent || info.usesDepth ? { transparent: true } : {}) } },
	};
	const entities = [
		{ id: 1, Name: "Sun", Transform: { rotation: [40, 35, 0] }, Light: { kind: "Directional", intensity: 1.1, shadows: true } },
		{ id: 2, Name: "Ground", Transform: { position: [0, -0.5, 0], scale: [12, 1, 12] }, Mesh_Renderer: { mesh: "cube", material: { color: [0.45, 0.45, 0.42, 1], roughness: 0.9 } } },
		subject,
		{ id: 4, Name: "Stone", Transform: { position: [0.6, 0, 0.4], scale: [0.6, 0.5, 0.6] }, Mesh_Renderer: { mesh: "sphere", material: { color: [0.55, 0.5, 0.45, 1] } } },
	];
	const camera = flat ? { position: [0, 3.2, -3.4], target: [0, 0, 0.2] } : { position: [1.4, 1.7, -2.8], target: [0, 0.7, 0] };
	return { entities, camera };
}

/** The plain ground effects are previewed on: dark (night, glows read best) or light (day), with a little bloom. */
export function effectGroundScene(background: "dark" | "light", post?: Record<string, unknown>) {
	const dark = background === "dark";
	const environment = dark
		? { sky_zenith: [0.03, 0.04, 0.08], sky_horizon: [0.1, 0.11, 0.16], exposure: 0.9, post: post ?? { bloom: 0.6 } }
		: { sky_zenith: [0.3, 0.5, 0.8], sky_horizon: [0.75, 0.82, 0.9], post: post ?? { bloom: 0.6 } };
	const entities = [
		{ id: 1, Name: "Sun", Transform: { rotation: [40, 35, 0] }, Light: { kind: "Directional", intensity: dark ? 0.15 : 1.1, shadows: true } },
		{ id: 2, Name: "Ground", Transform: { position: [0, -0.5, 0], scale: [30, 1, 30] }, Mesh_Renderer: { mesh: "cube", material: { color: dark ? [0.12, 0.12, 0.14, 1] : [0.5, 0.5, 0.48, 1], roughness: 0.9 } } },
	];
	return { environment, entities };
}

const hooks = (info: ShaderInfo) => ({ vertex: info.hasVertex, surface: info.hasSurface, depth_fade: info.usesDepth, bounds: info.bounds });

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
				screen: options.screen,
				shader: options.shader?.name,
				effect: options.effect?.name,
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
		let shaderCamera: { position: number[]; target: number[] } | undefined;
		if (options.shader) {
			// A temp scene outside the checkout, gone when the run ends.
			const { info } = this.readShader(co, options.shader.name);
			const built = shaderPreviewScene(info, { shader: options.shader.name, mesh: options.shader.mesh });
			const dir = mkdtempSync(join(tmpdir(), "gs-shader-live-"));
			writeFileSync(join(dir, "preview.json"), JSON.stringify({ entities: built.entities }));
			run.cleanup = () => rmSync(dir, { recursive: true, force: true });
			shaderCamera = built.camera;
			args.push("--paused", `--scene=${join(dir, "preview.json")}`);
		} else if (options.effect) {
			const dir = mkdtempSync(join(tmpdir(), "gs-effect-live-"));
			writeFileSync(join(dir, "ground.json"), JSON.stringify(effectGroundScene(options.effect.background ?? "dark")));
			run.cleanup = () => rmSync(dir, { recursive: true, force: true });
			args.push("--paused", `--scene=${join(dir, "ground.json")}`);
		} else if (options.scene) args.push("--paused", `--scene=${options.scene}`);
		else if (options.screen) args.push("--paused");
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
			run.cleanup?.();
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
		if (options.scene || options.shader || options.effect) await run.client.call("debug", { game_ui: false }).catch(() => {});
		if (shaderCamera) {
			await run.client.call("camera", { ...shaderCamera, fov: 50 }).catch(() => {});
			// Paused, so the game stands still; the shader's own time runs.
			await run.client.call("shader_time", { mode: "real" }).catch(() => {});
		}
		if (options.screen) {
			// The game's own screens (a title it shows at start) make way for the one being edited.
			await run.client.call("wait", { frames: 2 }).catch(() => {});
			await run.client.call("ui_hide", { all: true }).catch(() => {});
			await run.client.call("ui_show", { screen: options.screen }).catch(() => {});
		}
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
			// The game's own UI (a title it shows at start, a HUD) would cover the model.
			await client.call("debug", { game_ui: false });
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
			...(scene ? [...validateScene(scene), ...shaderProblems(co.cwd, scene)] : []),
		];
		const built = await this.exec(co, ["build"]);
		if (built.code !== 0) {
			throw new Error(`The game doesn't build, so it can't show the scene:\n${(built.stdout + built.stderr).trim().split("\n").slice(-12).join("\n")}`);
		}
		return this.shoot(co, path.replace(/^assets\//, ""), scene?.entities ?? [], views, problems);
	}

	/**
	 * A UI screen in the game's own engine over its default scene, paused, with sample `values` for its bindings: a
	 * screenshot, every element as laid out (id, type, rect in UI units, text with values filled in), the file's
	 * problems and engine warnings, and the bindings it reads that got no value.
	 */
	async previewUi(sessionId: CheckoutId, screen: string, values: Record<string, unknown> = {}) {
		const co = this.checkout(sessionId);
		const { screen: parsed, problems } = readScreen(co.cwd, screen);
		const built = await this.exec(co, ["build"]);
		if (built.code !== 0) throw new Error(`The game doesn't build, so it can't show the screen:\n${(built.stdout + built.stderr).trim().split("\n").slice(-12).join("\n")}`);
		const port = await freePort();
		const proc = await this.launch(co, ["--mode=hidden", `--control=${port}`, "--fps=60", "--paused"]);
		let client: EngineClient | undefined;
		try {
			client = await EngineClient.connect(port, () => proc.exitCode === null);
			await client.call("wait", { frames: 2 });
			await client.call("ui_hide", { all: true });
			// Pinned: a game that sets its values every frame (from its real state) mustn't overwrite the samples.
			if (Object.keys(values).length) await client.call("ui_set", { values, pin: true });
			await client.call("ui_show", { screen });
			await client.call("wait", { frames: 4 });
			const shot = (await client.call("screenshot", { inline: true, format: "jpeg", quality: 88 })) as { jpeg_base64: string };
			const tree = ((await client.call("ui_tree")) as { screen: string; id: string; type: string; depth: number; rect: number[]; text: string; visible: boolean }[]).filter((n) => n.screen === screen);
			const state = (await client.call("ui_screens")) as { screens: Record<string, { error: string }> };
			const logs = (await client.call("logs")) as { level: string; text: string }[];
			const engineError = state.screens[screen]?.error;
			const reads = parsed ? screenInterface(parsed) : { bindings: [], actions: [] };
			return {
				image: `data:image/jpeg;base64,${shot.jpeg_base64}`,
				elements: tree.map((n) => ({ id: n.id, type: n.type, depth: n.depth, rect: n.rect, ...(n.text ? { text: n.text } : {}), ...(n.visible ? {} : { visible: false }) })),
				bindings: reads.bindings,
				actions: reads.actions,
				unset: reads.bindings.filter((b) => !(b in values)),
				warnings: [...problems, ...(engineError ? [engineError] : []), ...logs.filter((l) => ["warn", "error"].includes(l.level.trim())).map((l) => l.text)],
			};
		} finally {
			await client?.call("quit").catch(() => {});
			client?.close();
			setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 2000);
		}
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

	/**
	 * Compiles a material shader (`assets/shaders/<name>.glsl`) in the game's engine without using it: its params as
	 * declared, compile errors with the line in the file, and whether it defines vertex() and surface().
	 */
	async checkShader(sessionId: CheckoutId, name: string) {
		const co = this.checkout(sessionId);
		const { info } = this.readShader(co, name);
		return this.withEngine(co, ["--mode=hidden", "--width=320", "--height=180", "--fps=60", "--paused"], async (client) => {
			const r = (await this.shaderCall(client, "shader_check", { path: shaderPath(name) })) as { ok: boolean; errors: { line: number; message: string }[] };
			return { ok: r.ok, errors: r.errors, params: info.params, hooks: hooks(info) };
		});
	}

	/**
	 * A material shader in the game's engine at several moments (its `u_time` pinned), so motion shows as a sequence:
	 * on a mesh under a sun (a temp scene outside the checkout), or in one of the game's scenes as it is. Returns the
	 * frames, the shader's compile state and params, and problems with the params given.
	 */
	async previewShader(sessionId: CheckoutId, p: ShaderPreview) {
		const co = this.checkout(sessionId);
		const { info } = this.readShader(co, p.shader);
		const problems = validateShaderParams(info, p.params);
		const times = (p.times?.length ? p.times : [0, 0.5, 1, 1.5]).slice(0, 8);
		let scene: string;
		let dir: string | undefined;
		let camera: { position: number[]; target: number[] } | undefined = p.view;
		if (p.scene) {
			if (!existsSync(safeJoin(co.cwd, p.scene))) throw new Error(`No ${p.scene} in this checkout`);
			scene = p.scene.replace(/^assets\//, "");
		} else {
			const built = shaderPreviewScene(info, p);
			dir = mkdtempSync(join(tmpdir(), "gs-shader-"));
			scene = join(dir, "preview.json");
			writeFileSync(scene, JSON.stringify({ ...(p.post ? { environment: { post: p.post } } : {}), entities: built.entities }));
			camera ??= built.camera;
		}
		try {
			return await this.withEngine(co, ["--mode=hidden", "--width=640", "--height=360", "--fps=60", "--paused", `--scene=${scene}`], async (client) => {
				await client.call("debug", { game_ui: false });
				if (p.scene && p.post) await client.call("environment", { value: { post: p.post } });
				await client.call("camera", camera ? { ...camera, fov: 50 } : { reset: true });
				const frames: { time: number; image: string }[] = [];
				for (const time of times) {
					await this.shaderCall(client, "shader_time", { value: time });
					await client.call("wait", { frames: 3 });
					const shot = (await client.call("screenshot", { inline: true, format: "jpeg", quality: 85 })) as { jpeg_base64: string };
					frames.push({ time, image: `data:image/jpeg;base64,${shot.jpeg_base64}` });
				}
				const loaded = (await client.call("shaders")) as { path: string; ok: boolean; errors: { line: number; message: string }[]; variants: string[] }[];
				const state = loaded.find((s) => s.path === shaderPath(p.shader));
				const logs = (await client.call("logs")) as { level: string; text: string }[];
				return {
					frames,
					shader: state ? { ok: state.ok, errors: state.errors } : { ok: false, errors: [{ line: 0, message: "nothing in the view drew with it" }] },
					params: info.params,
					hooks: hooks(info),
					problems,
					warnings: logs.filter((l) => ["warn", "error"].includes(l.level.trim()) && !/u32 to u16|^shader /.test(l.text)).map((l) => l.text),
				};
			});
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	}

	/**
	 * An effect file in the game's engine at chosen moments (each played afresh and simulated ahead to its time, with a
	 * fixed seed), so a burst unfolds as a sequence: on a dark or light ground with a little bloom (a temp scene
	 * outside the checkout), or in one of the game's scenes. The camera frames the effect's particles unless `view` is
	 * given. Returns the frames with their particle counts, the effect's bounds and problems.
	 */
	async previewEffect(sessionId: CheckoutId, p: EffectPreview) {
		const co = this.checkout(sessionId);
		const path = `effects/${p.effect.replace(/^(assets\/)?effects\//, "").replace(/\.json$/, "")}.json`;
		const file = safeJoin(co.cwd, `assets/${path}`);
		if (!existsSync(file)) throw new Error(`No assets/${path} in this checkout`);
		const { effect, problems } = parseEffect(readFileSync(file, "utf8"));
		for (const t of effect ? effectTextures(effect) : []) if (!existsSync(safeJoin(co.cwd, `assets/${t}`))) problems.push(`texture ${t} not found`);
		const times = (p.times?.length ? p.times : [0.1, 0.3, 0.6, 1, 1.6]).slice(0, 8);
		const at = p.position ?? [0, 0, 0];
		let scene: string;
		let dir: string | undefined;
		if (p.scene) {
			if (!existsSync(safeJoin(co.cwd, p.scene))) throw new Error(`No ${p.scene} in this checkout`);
			scene = p.scene.replace(/^assets\//, "");
		} else {
			dir = mkdtempSync(join(tmpdir(), "gs-effect-"));
			scene = join(dir, "preview.json");
			writeFileSync(scene, JSON.stringify(effectGroundScene(p.background ?? "dark", p.post)));
		}
		try {
			return await this.withEngine(co, ["--mode=hidden", "--width=640", "--height=360", "--fps=60", "--paused", `--scene=${scene}`], async (client) => {
				await client.call("debug", { game_ui: false });
				if (p.scene && p.post) await client.call("environment", { value: { post: p.post } });
				const seed = p.seed ?? 7;
				const play = async (time: number) => {
					await this.effectCall(client, "effect_stop", { clear: true });
					await client.call("wait", { frames: 1 });
					const r = (await this.effectCall(client, "effect_play", { path, position: at, time, seed })) as { handle: number; problems: string[] };
					await client.call("wait", { frames: 2 });
					const state = (await client.call("effects")) as { playing: { handle: number; particles: number; bounds?: number[][] }[] };
					const live = state.playing.find((x) => x.handle === r.handle);
					return { handle: r.handle, particles: live?.particles ?? 0, bounds: live?.bounds };
				};
				// Frame the camera on where the particles are at the last moment (or the whole run's largest).
				let bounds: number[][] | undefined;
				for (const t of [...times].sort((a, b) => b - a).slice(0, 2)) {
					const b = (await play(t)).bounds;
					if (b) bounds = bounds ? [b[0].map((v, i) => Math.min(v, bounds![0][i])), b[1].map((v, i) => Math.max(v, bounds![1][i]))] : b;
				}
				let camera = p.view;
				if (!camera) {
					const c = bounds ? bounds[0].map((v, i) => (v + bounds![1][i]) / 2) : [at[0], at[1] + 0.5, at[2]];
					const e = bounds ? Math.max(...bounds[1].map((v, i) => v - bounds![0][i]), 0.5) : 1.5;
					camera = { position: [c[0] + e * 0.35, c[1] + e * 0.45, c[2] - (e * 1.3 + 1.2)], target: c };
				}
				await client.call("camera", { ...camera, fov: 50 });
				const frames: { time: number; particles: number; image: string }[] = [];
				for (const time of times) {
					const r = await play(time);
					const shot = (await client.call("screenshot", { inline: true, format: "jpeg", quality: 85 })) as { jpeg_base64: string };
					frames.push({ time, particles: r.particles, image: `data:image/jpeg;base64,${shot.jpeg_base64}` });
				}
				const state = (await client.call("effects")) as { loaded: { path: string; problems: string[] }[] };
				const engineProblems = state.loaded.find((l) => l.path === path)?.problems ?? [];
				const logs = (await client.call("logs")) as { level: string; text: string }[];
				return {
					frames,
					bounds,
					problems: [...new Set([...problems, ...engineProblems])],
					warnings: logs.filter((l) => ["warn", "error"].includes(l.level.trim()) && !/u32 to u16|^effect /.test(l.text)).map((l) => l.text),
				};
			});
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	}

	/** An effects command, with a clear error from an engine older than effects. */
	private async effectCall(client: EngineClient, cmd: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			return await client.call(cmd, args);
		} catch (e) {
			if (/unknown command/i.test(String(e))) throw new Error(`This game's engine predates effect files: update the engine (Code → Update engine) first`);
			throw e;
		}
	}

	private readShader(co: CheckoutInfo, name: string): { info: ShaderInfo } {
		const file = safeJoin(co.cwd, `assets/${shaderPath(name)}`);
		if (!existsSync(file)) throw new Error(`No assets/${shaderPath(name)} in this checkout`);
		return { info: parseShader(readFileSync(file, "utf8")) };
	}

	/** Builds the game, runs it with `args` and a control port, and gives `use` the client; always quits it. */
	private async withEngine<T>(co: CheckoutInfo, args: string[], use: (client: EngineClient) => Promise<T>): Promise<T> {
		const built = await this.exec(co, ["build"]);
		if (built.code !== 0) throw new Error(`The game doesn't build, so its engine can't run:\n${(built.stdout + built.stderr).trim().split("\n").slice(-12).join("\n")}`);
		const port = await freePort();
		const proc = await this.launch(co, [...args, `--control=${port}`]);
		let client: EngineClient | undefined;
		try {
			client = await EngineClient.connect(port, () => proc.exitCode === null);
			return await use(client);
		} finally {
			await client?.call("quit").catch(() => {});
			client?.close();
			setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), 2000);
		}
	}

	/** A shader command, with a clear error from an engine older than material shaders. */
	private async shaderCall(client: EngineClient, cmd: string, args: Record<string, unknown>): Promise<unknown> {
		try {
			return await client.call(cmd, args);
		} catch (e) {
			if (/unknown command/i.test(String(e))) throw new Error(`This game's engine predates material shaders: update the engine (Code → Update engine) first`);
			throw e;
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
