import { describe, expect, it } from "vitest";
import { effectTextures, parseEffect, summarizeEffectFile, validateParticleTexture } from "./effect";

describe("parseEffect", () => {
	it("reports problems where they are, with the engine's messages", () => {
		const { effect, problems } = parseEffect(
			JSON.stringify({
				loop: true,
				emitters: [
					{ rate: 10, life: 0, shape: { kind: "blob" }, sizee: 1, color: [[0, "red"]] },
					{ sim: "gpu", burst: 5, size: [[0, 1], [0.2, 2], [0.4, 3], [0.6, 2], [1, 0]] },
					{ max: 50000, burst: [{ at: 0, count: 5 }], align: "sideways" },
				],
			}),
		);
		expect(effect).not.toBeNull();
		expect(problems).toEqual([
			"effect: loop needs a duration",
			'emitters[0]: unknown field "sizee"',
			"emitters[0]: life must be above 0 seconds",
			'emitters[0].shape: kind "blob": point, sphere, hemisphere, box, cone, ring or line',
			'emitters[0]: color: "red" is not "#rrggbb"',
			"emitters[1]: GPU emitters are continuous fields: bursts are for CPU emitters",
			"emitters[1]: GPU emitters take at most 4 keys per curve",
			'emitters[2]: align is "camera" or "velocity" or "ground"',
			'emitters[2]: max 50000 is a lot for the CPU: use "sim": "gpu" above about 20000',
		]);
	});

	it("lists the textures an effect uses and summarises it", () => {
		const { effect } = parseEffect(
			JSON.stringify({ emitters: [{ name: "sparks", burst: 20, texture: "effects/textures/spark/spark.png" }, { name: "glow", rate: 5, texture: "effects/textures/spark/spark.png" }] }),
		);
		expect(effectTextures(effect!)).toEqual(["effects/textures/spark/spark.png"]);
		expect(summarizeEffectFile(effect!)).toBe("2 emitters (sparks, glow) · continuous");
	});
});

describe("validateParticleTexture", () => {
	it("needs a known shape, and flipbooks only where frames can differ", () => {
		expect(validateParticleTexture({ mode: "procedural", recipe: { shape: "smoke", flipbook: [4, 4] } })).toEqual([]);
		expect(validateParticleTexture({ mode: "procedural", recipe: { shape: "spark", flipbook: [2, 2] } })).toEqual(["a flipbook animates smoke, dust, ring, not spark"]);
		expect(validateParticleTexture({ mode: "glitter" })).toEqual(["mode is one of glow, solid, procedural"]);
	});
});
