import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANIMATION_CLIPS, type GenJob, type ModelManifest } from "../shared/gen";
import type { StudioEvent } from "../shared/ipc";
import { GenService } from "./gen";
import { modelRequests, ModelPipeline } from "./models";
import { studioRequests } from "./studio-requests";
import { SessionService } from "./sessions";
import { inProcessHost, makeRepo, tempDir, waitFor } from "./test-helpers";

const codeDir = resolve("gen");
let services: GenService[] = [];

function service(opts: { idleMs?: number } = {}) {
	const events: StudioEvent[] = [];
	const gen = new GenService({ root: tempDir(), codeDir, emit: (e) => events.push(e), fake: true, idleMs: opts.idleMs });
	services.push(gen);
	const workerPid = () => (gen as unknown as { worker: { proc: { pid: number } } | null }).worker?.proc.pid;
	return { gen, events, workerPid };
}

afterEach(async () => {
	await Promise.all(services.map((s) => s.dispose()));
	services = [];
});

describe("GenService", () => {
	it("runs jobs in order, keeps a family's worker warm and swaps workers between families", async () => {
		const { gen, events, workerPid } = service();
		const out = tempDir();
		const a = gen.submit("shape", { image: "x.png", out: join(out, "a.glb") });
		const b = gen.submit("texture", { mesh: join(out, "a.glb"), image: "x.png", out: join(out, "b.glb") });
		expect((await gen.wait(a.id)).status).toBe("done");
		const hunyuanPid = workerPid();
		expect((await gen.wait(b.id)).result).toMatchObject({ mesh: join(out, "b.glb") });
		expect(workerPid()).toBe(hunyuanPid); // same family: the warm worker served both
		expect(existsSync(join(out, "b.glb"))).toBe(true);
		const progress = events.flatMap((e) => (e.type === "gen_job" && e.job.id === a.id ? [e.job.progress?.message] : []));
		expect(progress).toContain("Faking shape");

		await gen.run("image", { prompt: "a chest", out_dir: out, count: 2, seed: 5 });
		expect(workerPid()).not.toBe(hunyuanPid); // another family: the hunyuan worker was stopped first
		expect(gen.status().worker?.family).toBe("image");
	});

	it("retries a job once in a fresh worker when the GPU runs out of memory", async () => {
		const { gen, workerPid } = service();
		const out = tempDir();
		await gen.run("shape", { image: "x.png", out: join(out, "warm.glb") });
		const before = workerPid();
		const job = await gen.wait(gen.submit("shape", { image: "x.png", out: join(out, "a.glb"), fail_once: join(out, "oom") }).id);
		expect(job).toMatchObject({ status: "done", retried: true });
		expect(existsSync(join(out, "oom"))).toBe(true); // it did fail once
		expect(workerPid()).not.toBe(before); // and ran again in a new worker
	});

	it("reports failures, and restarts a worker that crashed", async () => {
		const { gen } = service();
		const failed = await gen.wait(gen.submit("shape", { fail: "no mesh for you" }).id);
		expect(failed).toMatchObject({ status: "failed", error: "RuntimeError: no mesh for you" });
		const crashed = await gen.wait(gen.submit("shape", { crash: true }).id);
		expect(crashed.status).toBe("failed");
		expect(crashed.error).toMatch(/hunyuan3d worker exited/);
		const out = join(tempDir(), "ok.glb");
		await expect(gen.run("shape", { image: "x.png", out })).resolves.toMatchObject({ mesh: out });
	});

	it("cancels queued and running jobs", async () => {
		const { gen } = service();
		const running = gen.submit("shape", { sleep: 30 });
		const queued = gen.submit("shape", { out: "never.glb" });
		await waitFor(() => gen.get(running.id).status === "running");
		gen.cancel(queued.id);
		gen.cancel(running.id);
		expect((await gen.wait(running.id)).status).toBe("cancelled");
		expect(gen.get(queued.id).status).toBe("cancelled");
	});

	it("stops an idle worker so the GPU is free", async () => {
		const { gen } = service({ idleMs: 50 });
		await gen.run("shape", { out: join(tempDir(), "a.glb") });
		expect(gen.status().worker).not.toBeNull();
		await waitFor(() => gen.status().worker === null, 5000);
	});
});

describe("generation tools", () => {
	it("serve an agent's tool call in its session's worktree and return the result to the chat", async () => {
		const { gen } = service();
		const root = tempDir();
		const project = makeRepo(join(root, "game"));
		const sessions = new SessionService({
			host: await inProcessHost(join(root, "pi")),
			settings: () => ({ engineRepo: join(root, "x"), studioRepo: join(root, "x"), worktreeRoot: join(root, "wt"), recentProjects: [] }),
			projectPath: () => project,
			agentTypes: () => [{ id: "3d-modeller", name: "3D", description: "", targets: ["project"], skills: [], prompt: "", source: "builtin" }],
			skillsDir: join(root, "skills"),
			emit: () => {},
			...studioRequests(gen, modelRequests(new ModelPipeline(gen))),
		});
		try {
			const s = await sessions.create({
				agentType: "3d-modeller",
				target: "project",
				model: "faux/echo",
				prompt: 'tool generate_concept_images {"model": "crate", "prompt": "a wooden crate", "count": 1, "seed": 2}',
			});
			await waitFor(() => sessions.get(s.id).status === "idle", 20_000);
			expect(existsSync(join(s.worktreePath, "assets/models/crate/concepts/crate-2.png"))).toBe(true);
			expect(existsSync(join(project, "assets/models/crate"))).toBe(false); // only in the session's worktree
			const reply = JSON.stringify((await sessions.messages(s.id)).at(-1));
			expect(reply).toContain("Result:");
			expect(reply).toContain("assets/models/crate/concepts/crate-2.png");
			// The agent sees every concept at once: a contact sheet comes back as an image in the tool result.
			const result = (await sessions.messages(s.id)).find((m) => (m as { role?: string }).role === "toolResult");
			expect(JSON.stringify(result)).toMatch(/"type":"image","mimeType":"image\/png"/);
		} finally {
			sessions.dispose();
		}
	}, 30_000);
});

const hasBlender = (() => {
	try {
		execFileSync("blender", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

function glbJson(glb: string) {
	const bytes = readFileSync(glb);
	return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
}

/** Faces of a model whose vertices are bound to different bones (rigid parts should have none). */
function facesOnBothBones(glb: string): number {
	const script = `
import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=sys.argv[-1])
ob = next(o for o in bpy.context.scene.objects if o.type == "MESH")
bone = [max(v.groups, key=lambda g: g.weight).group for v in ob.data.vertices]
print("MIXED", sum(len({bone[i] for i in f.vertices}) > 1 for f in ob.data.polygons))`;
	const out = execFileSync("blender", ["-b", "--python-expr", script, "--", glb], { encoding: "utf8" });
	return Number(/MIXED (\d+)/.exec(out)![1]);
}

describe.skipIf(!hasBlender)("ModelPipeline", () => {
	it("builds a model folder: concept, shape, texture, rig, then an engine-ready export with a manifest", async () => {
		const { gen } = service();
		const pipeline = new ModelPipeline(gen);
		const cwd = tempDir();
		const progress: string[] = [];
		const jobs = new Set<string>();
		const ctx = { cwd, progress: (t: string) => progress.push(t), onJob: (j: GenJob) => jobs.add(j.id) };

		const { images } = await pipeline.concepts(ctx, { model: "crate", prompt: "a wooden crate", count: 2, seed: 3 });
		expect(images).toEqual(["assets/models/crate/concepts/crate-3.png", "assets/models/crate/concepts/crate-4.png"]);

		const made = await pipeline.generate(ctx, { model: "crate", image: images[0], height: 0.5, rig: true });
		expect(made.glb).toBe("assets/models/crate/crate.glb");
		const manifest = JSON.parse(readFileSync(join(cwd, "assets/models/crate/model.json"), "utf8")) as ModelManifest;
		expect(manifest).toMatchObject({ name: "crate", concept: "concepts/crate-3.png", height: 0.5, textured: true, rigged: true });
		expect(manifest.steps.map((s) => s.kind)).toEqual(["shape", "texture", "rig", "finalize"]);
		expect(manifest.steps.every((s) => typeof s.seconds === "number")).toBe(true);
		expect(manifest.conceptSource).toMatchObject({ prompt: "a wooden crate", seed: 3, model: "fake" });

		// Blender scaled the fixture cube (2 m) to the requested height, with its base on the ground.
		expect((manifest.stats?.size as number[])[1]).toBeCloseTo(0.5, 2);
		for (const f of ["crate.glb", "thumbnail.png", "source/shape.glb", "source/textured.glb", "source/rigged.glb"]) {
			expect(existsSync(join(cwd, "assets/models/crate", f))).toBe(true);
		}
		expect(progress.some((p) => p.startsWith("Shape for crate:"))).toBe(true);
		expect(jobs.size).toBe(4);

		// A model in a folder: its concepts are named after its last part and sit in its own concepts/ folder.
		const nested = await pipeline.concepts(ctx, { model: "props/barrel", prompt: "a barrel", count: 2, seed: 5 });
		expect(nested.images).toEqual(["assets/models/props/barrel/concepts/barrel-5.png", "assets/models/props/barrel/concepts/barrel-6.png"]);
		expect(pipeline.conceptImages(ctx, "props/barrel").map((c) => c.path).sort()).toEqual(nested.images);

		await expect(pipeline.generate(ctx, { model: "Crate!", image: images[0], height: 1 })).rejects.toThrow(/lower-kebab-case/);
		await expect(pipeline.generate(ctx, { model: "x", image: "../../etc/passwd", height: 1 })).rejects.toThrow(/escapes/);
	}, 60_000);

	it("animates a rigged character, rigs a prop with a hinge, and remakes both after re-texturing", async () => {
		const { gen } = service();
		const pipeline = new ModelPipeline(gen);
		const ctx = { cwd: tempDir() };
		const read = (name: string) => JSON.parse(readFileSync(join(ctx.cwd, `assets/models/${name}/model.json`), "utf8")) as ModelManifest;
		const { images } = await pipeline.concepts(ctx, { model: "hero", prompt: "a hero", count: 1, seed: 1 });

		// The fake rig is a UniRig-shaped stick figure (bone_N names).
		await pipeline.generate(ctx, { model: "hero", image: images[0], height: 1.8, rig: true });
		const animated = await pipeline.animate(ctx, { model: "hero" });
		expect(animated.clips).toEqual(["idle", "walk", "wave"]);
		expect(animated.bones).toMatchObject({ hips: "bone_1", "upper_arm.L": "bone_5", "thigh.R": "bone_14" });
		expect(read("hero").stats?.animations).toEqual(["idle", "walk", "wave"]);
		// Re-finalizing uses what the model was built from, not the newest file (a checkout sets file times).
		utimesSync(join(ctx.cwd, "assets/models/hero/source/animated.glb"), new Date(2020, 0), new Date(2020, 0));
		await pipeline.finalize(ctx, { model: "hero" });
		expect(read("hero")).toMatchObject({ source: "source/animated.glb", stats: { animations: ["idle", "walk", "wave"] } });
		await pipeline.retexture(ctx, { model: "hero", image: images[0] });
		expect(read("hero")).toMatchObject({ rig: "auto", clips: ["idle", "walk", "wave"], stats: { animations: ["idle", "walk", "wave"] } });

		// A prop: the hinge rig replaces nothing (it wasn't rigged) and survives a re-texture.
		await pipeline.concepts(ctx, { model: "chest", prompt: "a chest", count: 1, seed: 1 });
		await pipeline.generate(ctx, { model: "chest", image: "assets/models/chest/concepts/chest-1.png", height: 0.6 });
		// The texture had no metallicFactor (glTF default: 1, bare metal), like Hunyuan3D-Paint's: now non-metal.
		expect(glbJson(join(ctx.cwd, "assets/models/chest/chest.glb")).materials[0].pbrMetallicRoughness).toMatchObject({ metallicFactor: 0 });
		await expect(pipeline.animate(ctx, { model: "hero", clips: ["moonwalk"] })).rejects.toThrow(/No clip called "moonwalk"/);
		// Without the animation library only the procedural clips can be made.
		await expect(pipeline.animate(ctx, { model: "hero", clips: ["run"] })).rejects.toThrow(/animation library isn't installed/);
		await expect(pipeline.animate(ctx, { model: "chest" })).rejects.toThrow(/isn't rigged/);
		await pipeline.rigProp(ctx, { model: "chest", split: 0.6, hinge: "back" });
		expect(read("chest")).toMatchObject({ rig: "prop", rigged: true, stats: { bones: 2, animations: ["close", "open"] } });
		// Measured in the rest pose, not a frame of the imported clip (which would have opened the lid).
		expect((read("chest").stats?.size as number[]).map((v) => Math.round(v * 100) / 100)).toEqual([0.6, 0.6, 0.6]);
		// Finalize's weld kept the lid apart from the base: no face is bound to both bones (it would stretch).
		expect(facesOnBothBones(join(ctx.cwd, "assets/models/chest/chest.glb"))).toBe(0);
		await expect(pipeline.animate(ctx, { model: "chest" })).rejects.toThrow(/prop rig/);
		await pipeline.retexture(ctx, { model: "chest", image: "assets/models/chest/concepts/chest-1.png" });
		expect(read("chest")).toMatchObject({ rig: "prop", stats: { bones: 2, animations: ["close", "open"] } });
	}, 120_000);

	// Needs the animation library gen/setup.sh downloads (6.7 MB, CC0); skipped on a machine without it.
	const library = join(homedir(), ".local/share/game-studio/gen/models/animations/universal-animation-library/AnimationLibrary_Godot_Standard.glb");
	it.skipIf(!existsSync(library))("gives a character clips from the animation library, replacing its set each time", async () => {
		process.env.GAME_STUDIO_ANIMATIONS = library;
		try {
			const { gen } = service();
			const pipeline = new ModelPipeline(gen);
			const ctx = { cwd: tempDir() };
			const read = (name: string) => JSON.parse(readFileSync(join(ctx.cwd, `assets/models/${name}/model.json`), "utf8")) as ModelManifest;
			const { images } = await pipeline.concepts(ctx, { model: "hero", prompt: "a hero", count: 1, seed: 1 });
			await pipeline.generate(ctx, { model: "hero", image: images[0], height: 1.7, rig: true });
			const animated = await pipeline.animate(ctx, { model: "hero", clips: ["idle", "run", "attack", "wave"] });
			expect(animated.clips).toEqual(["idle", "run", "attack", "wave"]);
			expect(read("hero").stats?.animations).toEqual(["attack", "idle", "run", "wave"]);
			expect(read("hero").steps.map((s) => s.kind).slice(-3)).toEqual(["animate", "retarget", "finalize"]);
			// Asking again replaces the set (no "idle.001" beside "idle").
			await pipeline.animate(ctx, { model: "hero", clips: ["idle", "walk"] });
			expect(read("hero").stats?.animations).toEqual(["idle", "walk"]);
			// Every clip on offer is one the library really has.
			await pipeline.animate(ctx, { model: "hero", clips: [...ANIMATION_CLIPS] });
			expect(read("hero").stats?.animations).toEqual([...ANIMATION_CLIPS].sort());
			await gen.dispose();
		} finally {
			delete process.env.GAME_STUDIO_ANIMATIONS;
		}
	}, 240_000);
});
