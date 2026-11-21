import { describe, expect, it } from "vitest";
import { parseShader, sceneShaderProblems, validatePost, validateShaderParams } from "./shader";

const WATER = `// Water
// @param float wave_height = 0.05 [0, 0.3]
// @param color deep = #1D4A5A
// @param vec2 direction = 1, 0.5
// @param texture foam = textures/foam.png
// @param colour oops
// @param float wave_height = 1
// @param float 2fast
// @bounds 0.4
void vertex(inout Vertex v) { v.position.y += wave_height; }
void surface(inout Surface s) { s.alpha = depth_fade(s, 0.5); }
`;

describe("parseShader", () => {
	it("reads params with defaults and ranges, and reports bad lines by number, as the engine does", () => {
		const info = parseShader(WATER);
		expect(info.params).toEqual([
			{ name: "wave_height", kind: "float", default: 0.05, min: 0, max: 0.3, line: 2 },
			{ name: "deep", kind: "color", default: "#1d4a5a", line: 3 },
			{ name: "direction", kind: "vec2", default: [1, 0.5], line: 4 },
			{ name: "foam", kind: "texture", default: "textures/foam.png", line: 5 },
		]);
		expect(info.problems.map((p) => p.line)).toEqual([6, 7, 8]);
		expect(info).toMatchObject({ bounds: 0.4, hasVertex: true, hasSurface: true, usesDepth: true });
	});

	it("caps textures at four", () => {
		const src = [1, 2, 3, 4, 5].map((i) => `// @param texture t${i}`).join("\n");
		expect(parseShader(src).problems).toEqual([{ line: 5, message: "more than 4 texture @params" }]);
	});
});

describe("validateShaderParams", () => {
	const info = parseShader(WATER);
	it("checks names, kinds and ranges; null clears a value", () => {
		expect(validateShaderParams(info, { wave_height: 0.1, deep: "#102030", direction: [0, 1], foam: "textures/x.png", deep2: 1 })).toEqual([
			"params.deep2: the shader has no such @param (it has wave_height, deep, direction, foam)",
		]);
		expect(validateShaderParams(info, { wave_height: 2, deep: "blue", direction: [1], foam: null })).toEqual([
			"params.wave_height: 2 is outside [0, 0.3]",
			'params.deep: must be "#rrggbb"',
			"params.direction: must be 2 numbers",
		]);
	});
});

describe("validatePost", () => {
	it("knows the engine's effects and their ranges", () => {
		expect(validatePost({ bloom: 0.5, lift: [0, 0, 0.05], glow: 1, vignette: 3, gain: 0.1 })).toEqual([
			"environment.post.glow: no such effect (bloom, bloom_threshold, outline, outline_width, outline_color, outline_threshold, contrast, saturation, temperature, tint, lift, gamma, gain, vignette, chromatic_aberration)",
			"environment.post.vignette: 3 is outside [0, 1]",
			"environment.post.gain: must be 3 numbers [r, g, b]",
		]);
	});
});

describe("sceneShaderProblems", () => {
	it("flags missing shaders, params they don't declare, and depth_fade on an opaque material", () => {
		const read = (path: string) => (path === "shaders/water.glsl" ? WATER : null);
		const mr = (material: Record<string, unknown>) => ({ Mesh_Renderer: { mesh: "grid", material } });
		const problems = sceneShaderProblems(
			[
				{ id: 1, Name: "Pond", ...mr({ shader: "shaders/water.glsl", transparent: true, params: { wave_height: 0.1 } }) },
				{ id: 2, ...mr({ shader: "shaders/water.glsl", params: { speed: 1 } }) },
				{ id: 3, ...mr({ shader: "shaders/lava.glsl" }) },
				{ id: 4, ...mr({ color: [1, 0, 0, 1] }) },
			],
			read,
		);
		expect(problems).toEqual([
			"entity 2: material.params.speed: the shader has no such @param (it has wave_height, deep, direction, foam)",
			"entity 2: material: shaders/water.glsl uses depth_fade, which only works on a transparent material",
			"entity 3: material.shader: no assets/shaders/lava.glsl",
		]);
	});
});
