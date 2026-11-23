import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import { pairReplies, parseDiagnostics } from "../shared/run";
import type { AgentTypeInfo } from "../shared/types";
import { createProject } from "./project";
import { RunService, runArgs } from "./runner";
import { SessionService } from "./sessions";
import { inProcessHost, sh, tempDir, waitFor } from "./test-helpers";

describe("parseDiagnostics", () => {
	it("reads Odin errors with repo-relative paths", () => {
		const out = [
			"/p/game/main.odin(4:7) Error: Undeclared name: foo ",
			"\tx := foo ",
			"\t     ^~^ ",
			"/elsewhere/x.odin(5:11) Syntax Error: Expected ';'",
		].join("\n");
		expect(parseDiagnostics(out, "/p")).toEqual([
			{ file: "game/main.odin", line: 4, column: 7, severity: "error", message: "Undeclared name: foo" },
			{ file: "/elsewhere/x.odin", line: 5, column: 11, severity: "error", message: "Expected ';'" },
		]);
	});
});

describe("pairReplies", () => {
	it("matches replies to script lines, skipping comments and blank lines", () => {
		const script = '// smoke\n{"cmd":"wait"}\n\n# note\n{"cmd":"assert","entity":"X","exists":true}\n{"cmd":"quit"}\n';
		const stdout = '>> built build/game\n{"id":null,"ok":true,"result":{"frame":1}}\n{"id":null,"ok":false,"error":"no entity named \\"X\\""}\n';
		const { steps, notRun } = pairReplies(script, stdout);
		expect(steps.map((s) => [s.line, s.ok, s.error])).toEqual([
			[2, true, undefined],
			[5, false, 'no entity named "X"'],
		]);
		expect(notRun).toBe(1);
	});
});

describe("runArgs", () => {
	it("reads real gamepads only in the plain Run in studio run", () => {
		expect(runArgs("hidden", 7000)).toEqual(["--mode=hidden", "--control=7000", "--fps=60", "--read-pads"]);
		// A window reads pads anyway.
		expect(runArgs("window", 7000)).toEqual(["--mode=window", "--control=7000"]);
		// The sections' live views are previews: a controller on the desk mustn't move them.
		for (const options of [{ scene: "scenes/main.json" }, { screen: "hud" }, { shader: { name: "water" } }, { effect: { name: "sparks" } }]) {
			expect(runArgs("hidden", 7000, options)).not.toContain("--read-pads");
		}
	});
});

// Builds and runs a real game from the template, so it needs the engine checkout next to this repo, odin, and a display.
const engineRepo = resolve(process.env.GAME_STUDIO_TEST_ENGINE ?? "../headless-game-engine");
const gameplay: AgentTypeInfo = { id: "gameplay-engineer", name: "Gameplay", description: "", targets: ["project"], skills: [], prompt: "", source: "builtin" };

describe.skipIf(!existsSync(join(engineRepo, "third_party/lib")))("RunService", () => {
	let project: string;
	let runner: RunService;
	let sessions: SessionService;
	const events: StudioEvent[] = [];

	beforeAll(async () => {
		const root = tempDir();
		project = join(root, "game");
		mkdirSync(project);
		sh(project, "init", "-q", "-b", "main");
		sh(project, "config", "user.email", "test@example.com");
		sh(project, "config", "user.name", "Test");
		await createProject({ path: project, name: "Run Test", templateDir: resolve("templates/game"), engineRepo });
		const emit = (e: StudioEvent) => events.push(e);
		sessions = new SessionService({
			host: await inProcessHost(join(root, "pi")),
			settings: () => ({ engineRepo, studioRepo: join(root, "none"), worktreeRoot: join(root, "wt"), recentProjects: [] }),
			projectPath: () => project,
			agentTypes: () => [gameplay],
			skillsDir: join(root, "skills"),
			emit,
		});
		runner = new RunService({ projectPath: () => project, sessions, emit });
	}, 120_000);

	it("runs the game hidden, streams frames and answers control commands", async () => {
		runner.setStreaming(true);
		const run = await runner.start(null, "hidden");
		expect(run.state).toBe("running");
		const entities = (await runner.call("entities")) as { name: string }[];
		expect(entities.map((e) => e.name)).toContain("Cube");
		// The player's controller works in the studio (engines with the `pads` command say so).
		const pads = (await runner.call("pads").catch(() => null)) as { read?: boolean } | null;
		if (pads) expect(pads.read).toBe(true);
		const frames = () => events.filter((e) => e.type === "run_frame" && e.runId === run.id);
		await waitFor(() => frames().length > 0);
		expect(frames()[0]).toMatchObject({ mime: "image/jpeg", width: 1280, height: 720 });

		// Streaming must not slow the game down (it used to cost a third of its frame rate).
		const before = frames().length;
		await new Promise((r) => setTimeout(r, 2000));
		const perSecond = (frames().length - before) / 2;
		const { fps } = (await runner.call("stats")) as { fps: number };
		expect(perSecond).toBeGreaterThan(20);
		expect(fps).toBeGreaterThan(55);

		await runner.stop();
		expect(runner.current()?.state).toBe("exited");
		await expect(runner.call("info")).rejects.toThrow(/isn't running/);

		// A section's live view doesn't.
		expect((await runner.start(null, "hidden", { scene: "scenes/main.json" })).state).toBe("running");
		if (pads) expect(((await runner.call("pads")) as { read: boolean }).read).toBe(false);
		await runner.stop();
	}, 60_000);

	it("runs a multiplayer game: a host and a second copy that joins it, each streamed and commanded on its own", async () => {
		runner.setStreaming(true);
		const run = await runner.start(null, "hidden", { players: 2 });
		expect(run.state).toBe("running");
		expect(run.players).toMatchObject([
			{ index: 0, name: "Player 1", role: "host", state: "running" },
			{ index: 1, name: "Player 2", role: "client", state: "running" },
		]);
		type Net = { role: string; local_id: number; players: { name: string }[] };
		// (waitFor takes a plain condition; these ask the game, so they poll with awaits.)
		const until = async (what: string, cond: () => Promise<boolean>) => {
			const end = Date.now() + 10_000;
			while (!(await cond())) {
				if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
				await new Promise((r) => setTimeout(r, 50));
			}
		};
		// The engine's own networking: the second copy is a peer of the first.
		await until("the host to see two players", async () => ((await runner.call("net")) as Net).players.length === 2);
		expect(((await runner.call("net")) as Net).role).toBe("Host");
		await until("the second copy to be welcomed", async () => ((await runner.call("net", {}, 1)) as Net).players.length === 2);
		const joined = (await runner.call("net", {}, 1)) as Net;
		expect(joined).toMatchObject({ role: "Client", local_id: 1 });
		expect(joined.players.map((p) => p.name).sort()).toEqual(["Player 1", "Player 2"]);
		// Each copy streams its own frames, and only the host's reads a real controller.
		const framesOf = (player: number) => events.filter((e) => e.type === "run_frame" && e.runId === run.id && e.player === player);
		await waitFor(() => framesOf(0).length > 0 && framesOf(1).length > 0);
		const pads = (await runner.call("pads", {}, 1).catch(() => null)) as { read?: boolean } | null;
		if (pads) expect(pads.read).toBe(false);
		await expect(runner.call("info", {}, 2)).rejects.toThrow(/Player 3's copy/);
		// One copy leaving is seen by the other; stopping ends them all.
		await runner.call("quit", {}, 1).catch(() => {});
		await waitFor(() => runner.current()?.players?.[1].state === "exited");
		await until("the host to see it leave", async () => ((await runner.call("net")) as Net).players.length === 1);
		expect(runner.current()?.state).toBe("running");
		await runner.stop();
		expect(runner.current()?.state).toBe("exited");
		// An ordinary run has no players list.
		expect((await runner.start(null, "hidden")).players).toBeUndefined();
		await runner.stop();
	}, 60_000);

	it("runs a multiplayer test script across two copies of the game, each line on the player it names", async () => {
		// (An engine commit from before the tool existed: use the checkout's copy.)
		if (!existsSync(join(project, "engine/tools/mptest.py"))) cpSync(join(engineRepo, "tools/mptest.py"), join(project, "engine/tools/mptest.py"));
		writeFileSync(
			join(project, "tests/two.mp.jsonl"),
			'// players: 2\n{"player": "all", "cmd": "assert", "entity": "Cube", "exists": true}\n{"player": 2, "cmd": "net"}\n{"player": 2, "cmd": "quit"}\n{"player": 2, "cmd": "info"}\n',
		);
		try {
			expect(runner.tests(null)).toContain("tests/two.mp.jsonl");
			const report = await runner.test(null, "tests/two.mp.jsonl");
			expect(report.buildOk).toBe(true);
			expect(report.steps.map((s) => [s.line, s.ok])).toEqual([
				[2, true],
				[3, true],
				[4, true],
				[5, false],
			]);
			expect(report.steps[1].result).toMatchObject({ role: "Client", local_id: 1 });
			expect(report.steps[3].error).toMatch(/player 2 has left/);
			expect(report.ok).toBe(false);
		} finally {
			rmSync(join(project, "tests/two.mp.jsonl"));
		}
	}, 60_000);

	it("reports a scripted test step by step, with its screenshots", async () => {
		const pass = await runner.test(null, "tests/smoke.jsonl");
		expect(pass).toMatchObject({ ok: true, buildOk: true, notRun: 0, screenshots: ["build/smoke.png"] });
		expect(pass.steps).toHaveLength(3);

		writeFileSync(join(project, "tests/broken.jsonl"), '{"cmd": "wait", "frames": 2}\n{"cmd": "assert", "entity": "Sphere", "exists": true}\n');
		const fail = await runner.test(null, "tests/broken.jsonl");
		expect(fail.ok).toBe(false);
		expect(fail.steps.map((s) => s.ok)).toEqual([true, false]);
		expect(fail.steps[1].line).toBe(2);
		expect(runner.tests(null)).toEqual(["tests/broken.jsonl", "tests/smoke.jsonl"]);
		rmSync(join(project, "tests/broken.jsonl"));
	}, 60_000);

	it("films the game after a lead-in script into a short clip for a review", async () => {
		writeFileSync(join(project, "tests/lead.jsonl"), '{"cmd": "wait", "frames": 5}\n{"cmd": "quit"}\n');
		const r = await runner.captureClip(null, { name: "cube spin!", script: "tests/lead.jsonl", seconds: 1, fps: 10 });
		rmSync(join(project, "tests/lead.jsonl"));
		expect(r).toMatchObject({ clip: "build/review/cube-spin.webm", frames: 10, seconds: 1, first: "build/review/cube-spin/f-0001.png", last: "build/review/cube-spin/f-0010.png", problems: [] });
		// A real WebM (EBML header), not an empty file.
		expect(readFileSync(join(project, r.clip)).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
		await expect(runner.captureClip(null, { name: "  " })).rejects.toThrow("Give the clip a name");
	}, 90_000);

	it("starts the game as a scenario: its flags and scene on the command line, its setup sent once it runs", async () => {
		mkdirSync(join(project, "scenarios"), { recursive: true });
		writeFileSync(
			join(project, "scenarios/sandbox.json"),
			JSON.stringify({
				title: "Sandbox",
				flags: { biome: "{environment}" },
				setup: [{ cmd: "spawn", name: "Marker_{environment}", position: [0, "{height}", 0] }, { cmd: "no_such_command" }],
				params: [
					{ id: "environment", type: "choice", options: ["forest", "desert"] },
					{ id: "height", type: "number", default: 2 },
				],
			}),
		);
		const before = events.length;
		const info = await runner.start(null, "hidden", { scenario: { path: "scenarios/sandbox.json", values: { environment: "desert" } } });
		expect(info).toMatchObject({ state: "running", scenario: { path: "scenarios/sandbox.json", title: "Sandbox", values: { environment: "desert", height: 2 } } });
		const entities = (await runner.call("entities")) as { entities?: { name: string }[] } | { name: string }[];
		expect(JSON.stringify(entities)).toContain("Marker_desert");
		// A setup command the game doesn't know is reported in the run's output, and the game keeps running.
		const output = events.slice(before).flatMap((e) => (e.type === "run_output" ? [e.text] : [])).join("");
		expect(output).toContain('scenario setup: {"cmd":"no_such_command"} failed');
		await runner.stop();
		// A broken file stops before anything is built.
		writeFileSync(join(project, "scenarios/broken.json"), JSON.stringify({ title: "Broken", flags: { mode: "window" } }));
		await expect(runner.start(null, "hidden", { scenario: { path: "scenarios/broken.json" } })).rejects.toThrow('The flag "mode" is set by the studio');
		rmSync(join(project, "scenarios"), { recursive: true });
	}, 90_000);

	it("reports compiler errors on a failed build", async () => {
		writeFileSync(join(project, "game/broken.odin"), "package game\n\nbroken :: proc() {\n\tx := undefined_thing\n}\n");
		try {
			const run = await runner.build(null);
			expect(run.state).toBe("build_failed");
			expect(run.diagnostics[0]).toMatchObject({ file: "game/broken.odin", line: 4, severity: "error" });
		} finally {
			rmSync(join(project, "game/broken.odin"));
		}
	}, 60_000);

	it("previews a scene paused from each view, with problems and engine warnings", async () => {
		const path = "assets/scenes/main.json";
		const original = readFileSync(join(project, path), "utf8");
		try {
			writeFileSync(join(project, path), original.replace('"Name": "Cube",', '"Name": "Cube", "Glow": {},'));
			const r = await runner.previewScene(null, path, ["top", "game", { position: [3, 2, -3], target: [0, 1, 0] }]);
			expect(r.images.map((i) => i.view)).toEqual(["top", "game", '{"position":[3,2,-3],"target":[0,1,0]}']);
			expect(r.images[0].image).toMatch(/^data:image\/jpeg;base64,/);
			expect(r.images[0].image).not.toBe(r.images[1].image);
			expect(r.warnings.some((w) => w.includes('unknown component "Glow"'))).toBe(true);
		} finally {
			writeFileSync(join(project, path), original);
		}
	}, 60_000);

	it("previews a UI screen in the game's engine with sample values: layout, text, unset bindings, problems", async () => {
		mkdirSync(join(project, "assets/ui"), { recursive: true });
		writeFileSync(
			join(project, "assets/ui/hud.json"),
			JSON.stringify({
				elements: [
					{ id: "box", type: "panel", anchor: "top_left", offset: [16, 16], size: [260, 90], padding: 12, children: [
						{ id: "gold", type: "text", text: "Gold: {gold}" },
						{ id: "map", type: "text", text: "Map found", visible: "has_map", anchor: "bottom_left" },
					] },
					{ id: "logo", type: "image", image: "ui/missing.png", size: [64, 64], anchor: "top_right" },
				],
			}),
		);
		try {
			const r = await runner.previewUi(null, "hud", { gold: 250 });
			expect(r.image).toMatch(/^data:image\/jpeg;base64,/);
			expect(r.elements.find((e) => e.id === "gold")).toMatchObject({ text: "Gold: 250", rect: [28, 28, expect.any(Number), expect.any(Number)] });
			expect(r.elements.find((e) => e.id === "map")).toMatchObject({ visible: false });
			expect(r.bindings).toEqual(["gold", "has_map"]);
			expect(r.unset).toEqual(["has_map"]);
			expect(r.warnings).toContain("elements.logo.image: No assets/ui/missing.png");
		} finally {
			rmSync(join(project, "assets/ui"), { recursive: true, force: true });
		}
	}, 60_000);

	it("previews a model with the game's own screens hidden (a title shown at start covered it)", async () => {
		const main = join(project, "game/main.odin");
		const code = readFileSync(main, "utf8");
		mkdirSync(join(project, "assets/ui"), { recursive: true });
		mkdirSync(join(project, "assets/models/biped"), { recursive: true });
		writeFileSync(join(project, "assets/models/biped/biped.glb"), readFileSync(resolve("gen/workers/fixtures/biped.glb")));
		try {
			const plain = await runner.preview(null, "assets/models/biped/biped.glb", 1.6);
			// A full-screen magenta title, shown by the game as it starts.
			writeFileSync(join(project, "assets/ui/title.json"), JSON.stringify({ elements: [{ id: "bg", type: "panel", color: "#ff00ff", anchor: "center", size: [4000, 4000] }] }));
			writeFileSync(main, code.replace('cube = engine.find("Cube")', 'cube = engine.find("Cube")\n\tengine.ui_show("title")'));
			const titled = await runner.preview(null, "assets/models/biped/biped.glb", 1.6);
			// Covered, a frame is flat magenta: a far smaller JPEG than the model on its ground.
			titled.images.forEach((img, i) => expect(img.length).toBeGreaterThan(plain.images[i].length * 0.8));
		} finally {
			writeFileSync(main, code);
			rmSync(join(project, "assets/ui"), { recursive: true, force: true });
			rmSync(join(project, "assets/models/biped"), { recursive: true, force: true });
		}
	}, 90_000);

	it("previews an effect over time in the game's engine: frames, counts, bounds, problems", async () => {
		const dir = join(project, "assets/effects");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "burst.json"),
			JSON.stringify({ emitters: [{ burst: [{ at: 0, count: 40 }], life: 1, speed: [1, 2], gravity: 3, shape: { kind: "cone", angle: 30 }, color: [[0, "#ffd080", 1, 4], [1, "#ff6020", 0]], blend: "additive", texture: "effects/textures/nothing.png" }] }),
		);
		try {
			const r = await runner.previewEffect(null, { effect: "burst", times: [0.1, 0.5, 1.5] });
			expect(r.frames.map((f) => [f.time, f.particles])).toEqual([[0.1, 40], [0.5, 40], [1.5, 0]]);
			expect(r.frames[0].image).toMatch(/^data:image\/jpeg;base64,/);
			// Paused: only the replay at another time changes the picture (each a fresh play: an older one must be gone).
			expect(new Set(r.frames.map((f) => f.image)).size).toBe(3);
			expect(r.bounds?.[1][1]).toBeGreaterThan(0.3); // they rose
			expect(r.problems).toEqual(["texture effects/textures/nothing.png not found"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);

	it("checks a material shader and previews it over time in the game's engine", async () => {
		const dir = join(project, "assets/shaders");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "wave.glsl"),
			"// @param float height = 0.3 [0, 1]\n// @bounds 0.4\nvoid vertex(inout Vertex v) { v.position.y += sin(v.position.x * 3.0 + u_time * 3.0) * height; }\nvoid surface(inout Surface s) { s.albedo = vec3(0.1, 0.4, 0.8); }\n",
		);
		writeFileSync(join(dir, "broken.glsl"), "void surface(inout Surface s) {\n    s.albedo = nope;\n}\n");
		try {
			expect(await runner.checkShader(null, "wave")).toMatchObject({ ok: true, errors: [], params: [{ name: "height", kind: "float", default: 0.3 }], hooks: { vertex: true, surface: true } });
			const broken = await runner.checkShader(null, "broken");
			expect(broken.ok).toBe(false);
			expect(broken.errors[0].line).toBe(2);

			const r = await runner.previewShader(null, { shader: "wave", params: { height: 0.4, speed: 2 }, times: [0, 1] });
			expect(r.frames.map((f) => f.time)).toEqual([0, 1]);
			expect(r.frames[0].image).toMatch(/^data:image\/jpeg;base64,/);
			// The game is paused: only the pinned shader time moves the waves.
			expect(r.frames[0].image).not.toBe(r.frames[1].image);
			expect(r.shader).toEqual({ ok: true, errors: [] });
			expect(r.problems).toEqual(["params.speed: the shader has no such @param (it has height)"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);

	it("opens a scene paused for the Scenes editor, with file ids and picking", async () => {
		const run = await runner.start(null, "hidden", { scene: "scenes/main.json" });
		expect(run).toMatchObject({ state: "running", scene: "scenes/main.json" });
		expect(await runner.call("info")).toMatchObject({ paused: true });
		const rows = (await runner.call("entities")) as { name: string; scene_id?: number }[];
		expect(rows.find((r) => r.name === "Cube")?.scene_id).toBe(4);
		await runner.call("camera", { position: [0, 6, -6], target: [0, 1, 0] });
		const pick = (await runner.call("pick", { x: 640, y: 360 })) as { hit: { scene_id?: number } | null };
		expect(pick.hit?.scene_id).toBe(4);
		await runner.stop();
	}, 60_000);

	it("launches the game while builds of the same checkout are running", async () => {
		// An agent's own ./build.sh (outside the studio) and an agent's preview_scene rewrite build/game while the
		// Scenes view starts the game: Linux refuses to start a binary that is being written (ETXTBSY).
		const outside = spawn(join(project, "build.sh"), ["build"], { cwd: project });
		const outsideDone = new Promise((r) => outside.on("close", r));
		const [preview, run] = await Promise.all([
			runner.previewScene(null, "assets/scenes/main.json", ["top"]),
			new Promise((r) => setTimeout(r, 150)).then(() => runner.start(null, "hidden", { scene: "scenes/main.json" })),
		]);
		expect(preview.images).toHaveLength(1);
		expect(run.state).toBe("running");
		await outsideDone;
		await runner.stop();
	}, 90_000);

	it("runs a session's worktree", async () => {
		const s = await sessions.create({ agentType: "gameplay-engineer", target: "project", model: "faux/echo", prompt: "hello" });
		await waitFor(() => sessions.get(s.id).status === "idle");
		expect(runner.checkouts().map((c) => c.sessionId)).toEqual([null, s.id]);
		// Change the game in the worktree only; the test must see the session's version.
		writeFileSync(join(s.worktreePath, "tests/draft.jsonl"), '{"cmd": "assert", "entity": "Cube", "exists": true}\n');
		const report = await runner.test(s.id, "tests/draft.jsonl");
		expect(report.ok).toBe(true);
		expect(existsSync(join(s.worktreePath, "build/game"))).toBe(true);
	}, 120_000);
});
