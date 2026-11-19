// The real models on the real GPU, through the service. Opt-in (a few minutes): npm run test:gpu
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ModelManifest } from "../shared/gen";
import { GenService } from "./gen";
import { ModelPipeline } from "./models";
import { tempDir } from "./test-helpers";

describe.runIf(process.env.GAME_STUDIO_GEN_GPU === "1")("generation on the GPU", () => {
	it("makes a textured, rigged, engine-ready character from a prompt", async () => {
		const gen = new GenService({ root: process.env.GAME_STUDIO_GEN ?? join(process.env.HOME!, ".local/share/game-studio/gen"), codeDir: resolve("gen"), emit: () => {} });
		expect(gen.status().ready).toBe(true);
		const pipeline = new ModelPipeline(gen);
		const cwd = tempDir();
		const ctx = { cwd, progress: (t: string) => console.log(t) };
		try {
			const { images } = await pipeline.concepts(ctx, {
				model: "goblin",
				prompt: "a small cartoon goblin adventurer with a leather satchel, standing in an A-pose, front view",
				count: 1,
				seed: 7,
			});
			const made = await pipeline.generate(ctx, { model: "goblin", image: images[0], height: 1.2, rig: true });
			const manifest = JSON.parse(readFileSync(join(cwd, "assets/models/goblin/model.json"), "utf8")) as ModelManifest;
			console.log(JSON.stringify(manifest, null, 2), `\noutputs in ${cwd}`);
			expect(made.glb).toBe("assets/models/goblin/goblin.glb");
			expect(manifest.stats).toMatchObject({ primitives: expect.any(Number) });
			expect(manifest.stats!.max_primitive_vertices as number).toBeLessThanOrEqual(65535);
			expect(manifest.stats!.bones as number).toBeGreaterThan(5);
			expect((manifest.stats!.size as number[])[1]).toBeCloseTo(1.2, 2);

			// A generated character is recognised as a biped and gets its clips.
			const animated = await pipeline.animate(ctx, { model: "goblin" });
			console.log(JSON.stringify(animated.bones));
			expect(animated.clips).toEqual(["idle", "walk", "wave"]);
			expect(Object.keys(animated.bones ?? {})).toEqual(expect.arrayContaining(["hips", "head", "upper_arm.L", "upper_arm.R", "thigh.L", "thigh.R"]));
		} finally {
			await gen.dispose();
		}
	}, 900_000);
});
