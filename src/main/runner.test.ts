import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import { pairReplies, parseDiagnostics } from "../shared/run";
import type { AgentTypeInfo } from "../shared/types";
import { createProject } from "./project";
import { RunService } from "./runner";
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
