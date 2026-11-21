import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ParticleTexturePipeline } from "./effects";
import { GenService } from "./gen";
import { tempDir } from "./test-helpers";

let services: GenService[] = [];
const fakeGen = () => {
	const gen = new GenService({ root: tempDir(), codeDir: resolve("gen"), emit: () => {}, fake: true });
	services.push(gen);
	return gen;
};
afterEach(async () => {
	await Promise.all(services.map((s) => s.dispose()));
	services = [];
});
const json = (cwd: string, path: string) => JSON.parse(readFileSync(join(cwd, path), "utf8"));

describe("Particle textures", () => {
	it("generates cut-out candidates and makes one; or makes one procedurally, recording its flipbook", async () => {
		const cwd = tempDir();
		const tex = new ParticleTexturePipeline(fakeGen());
		const r = await tex.candidates({ cwd }, { name: "sparks/star", mode: "glow", prompt: "a four-pointed sparkle", count: 2, seed: 4 });
		expect(r.candidates.map((c) => c.source)).toEqual(["candidates/star-4.png", "candidates/star-5.png"]);
		expect(r.sheet).toMatch(/^data:image\/png;base64,/);
		expect(json(cwd, "assets/effects/textures/sparks/star/star.json")).toEqual({ mode: "glow", prompt: "a four-pointed sparkle" });
		const made = await tex.make({ cwd }, { name: "sparks/star", source: "candidates/star-5.png" });
		expect(made.file).toBe("effects/textures/sparks/star/star.png");
		expect(existsSync(join(cwd, "assets", made.file))).toBe(true);
		expect(json(cwd, "assets/effects/textures/sparks/star/star.json")).toMatchObject({ mode: "glow", source: "candidates/star-5.png" });
		await expect(tex.candidates({ cwd }, { name: "sparks/star", mode: "solid", prompt: "x" })).rejects.toThrow(/is a glow texture, not solid/);

		const smoke = await tex.make({ cwd }, { name: "smoke", recipe: { shape: "smoke", flipbook: [4, 4] } });
		expect(smoke).toMatchObject({ file: "effects/textures/smoke/smoke.png", flipbook: [4, 4] });
		expect(json(cwd, "assets/effects/textures/smoke/smoke.json")).toEqual({ mode: "procedural", recipe: { shape: "smoke", flipbook: [4, 4] }, flipbook: [4, 4] });
		await expect(tex.make({ cwd }, { name: "sparks/star", source: "candidates/none.png" })).rejects.toThrow(/isn't in/);
		await expect(tex.make({ cwd }, { name: "bad", recipe: { shape: "spark", flipbook: [2, 2] } })).rejects.toThrow(/a flipbook animates smoke, dust, ring, not spark/);
	}, 30_000);
});
