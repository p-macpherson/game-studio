import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenService } from "./gen";
import { tempDir } from "./test-helpers";
import { TexturePipeline } from "./textures";

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

describe("TexturePipeline", () => {
	it("generates candidates two ways per seed, records them, then makes the texture's maps from the chosen one", async () => {
		const cwd = tempDir();
		const textures = new TexturePipeline(fakeGen());
		const r = await textures.candidates({ cwd }, { name: "ground/grass", prompt: "short stylised grass", count: 2, seed: 7 });
		expect(r.candidates.map((c) => c.source)).toEqual(["candidates/grass-7-roll.png", "candidates/grass-7-quilt.png", "candidates/grass-8-roll.png", "candidates/grass-8-quilt.png"]);
		expect(r.sheet).toMatch(/^data:image\/png;base64,/);
		expect(json(cwd, "assets/textures/ground/grass/texture.json")).toEqual({ prompt: "short stylised grass", tile: 2 });
		expect(textures.candidateRecords(cwd, "ground/grass")["grass-8-quilt.png"]).toMatchObject({ prompt: "short stylised grass", seed: 8, method: "quilt", model: "fake" });

		const made = await textures.make({ cwd }, { name: "ground/grass", source: "candidates/grass-8-quilt.png", tile: 3 });
		expect(made.files).toEqual(["assets/textures/ground/grass/grass.png", "assets/textures/ground/grass/grass_normal.png", "assets/textures/ground/grass/grass_roughness.png"]);
		for (const f of made.files) expect(existsSync(join(cwd, f))).toBe(true);
		expect(made.preview).toMatch(/^data:image\/png;base64,/);
		expect(json(cwd, "assets/textures/ground/grass/texture.json")).toEqual({ prompt: "short stylised grass", tile: 3, source: "candidates/grass-8-quilt.png" });
	});

	it("refuses a bad texture without changing texture.json: tile size, a source outside candidates/, a missing one, none chosen", async () => {
		const cwd = tempDir();
		const textures = new TexturePipeline(fakeGen());
		await textures.candidates({ cwd }, { name: "planks", prompt: "wooden planks", count: 1, seed: 1 });
		const before = readFileSync(join(cwd, "assets/textures/planks/texture.json"), "utf8");
		await expect(textures.make({ cwd }, { name: "planks" })).rejects.toThrow(/No candidate chosen/);
		await expect(textures.make({ cwd }, { name: "planks", source: "candidates/planks-1-roll.png", tile: 0 })).rejects.toThrow(/tile: Metres per repeat/);
		await expect(textures.make({ cwd }, { name: "planks", source: "../../models/x.png" })).rejects.toThrow(/source: A candidate image/);
		await expect(textures.make({ cwd }, { name: "planks", source: "candidates/planks-9-roll.png" })).rejects.toThrow(/isn't in assets\/textures\/planks/);
		await expect(textures.make({ cwd }, { name: "planks", source: "candidates/planks-1-roll.png", roughness: [0.9, 0.2] })).rejects.toThrow(/roughness/);
		expect(readFileSync(join(cwd, "assets/textures/planks/texture.json"), "utf8")).toBe(before);
	});
});
