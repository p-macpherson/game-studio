import { describe, expect, it } from "vitest";
import {
	curveKeys,
	curveValue,
	EFFECT_TEMPLATES,
	effectLength,
	effectTextures,
	formatEffect,
	gradientStops,
	gradientValue,
	parseEffect,
	setEffectField,
	summarizeEffectFile,
	validateParticleTexture,
} from "./effect";

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

describe("editing effects", () => {
	it("writes one field per line with keys on one line, and reads back the same", () => {
		const effect = EFFECT_TEMPLATES[0].effect;
		const text = formatEffect(effect);
		expect(JSON.parse(text)).toEqual(effect);
		expect(text).toContain('\t\t\t"shape": {"kind":"cone","angle":35,"radius":0.1}');
		expect(text.split("\n").length).toBeGreaterThan(15);
		const next = setEffectField(setEffectField(effect, 0, "gravity", null), null, "loop", true);
		expect(next.emitters[0].gravity).toBeUndefined();
		expect(next.loop).toBe(true);
		expect(effect.emitters[0].gravity).toBe(5); // untouched
	});

	it("turns curves and gradients into keys and back to the shortest form", () => {
		expect(curveKeys(0.3, 1)).toEqual([[0, 0.3]]);
		expect(curveValue([[1, 0], [0, 0.25]])).toEqual([[0, 0.25], [1, 0]]);
		expect(curveValue([[0, 0.5]])).toBe(0.5);
		const stops = gradientStops([[0, "#FFF0B0", 1, 6], [1, "#ff5010", 0]]);
		expect(stops).toEqual([{ t: 0, color: "#fff0b0", alpha: 1, intensity: 6 }, { t: 1, color: "#ff5010", alpha: 0, intensity: 1 }]);
		expect(gradientValue(stops)).toEqual([[0, "#fff0b0", 1, 6], [1, "#ff5010", 0]]);
		expect(gradientValue([{ t: 0, color: "#aabbcc", alpha: 1, intensity: 1 }])).toBe("#aabbcc");
	});

	it("knows how long an effect plays out", () => {
		expect(effectLength(EFFECT_TEMPLATES[0].effect)).toBe(1); // a burst at 0, life up to 1 s
		expect(effectLength({ duration: 2, loop: true, emitters: [{ rate: 5, life: 3 }] })).toBe(2);
		expect(effectLength({ emitters: [{ rate: 5, life: [1, 2], delay: 0.5 }] })).toBe(5.5); // continuous: 3 s shown
	});
});
