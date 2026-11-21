/**
 * Material shaders (`assets/shaders/<name>.glsl`): GLSL snippets the engine plugs into its lit shader, with a header
 * of `// @param` lines the studio builds controls from. This mirrors the engine's header rules (its
 * material_shaders.odin) so problems show without running the game; compile errors come from the engine
 * (`shader_check`). See the engine's docs/making-a-game.md "Material shaders" and the vault note "M11 Shaders".
 */

export const SHADER_DIR = "assets/shaders";
export const SHADER_PARAM_KINDS = ["float", "vec2", "vec3", "vec4", "color", "texture"] as const;
export type ShaderParamKind = (typeof SHADER_PARAM_KINDS)[number];
export const MAX_SHADER_PARAMS = 8;
export const MAX_SHADER_TEXTURES = 4;

/** A value in a material's `params`: a number, an array (vec2-4, or a colour as 0..1 sRGB), "#rrggbb" or a texture path. */
export type ShaderParamValue = number | number[] | string;

export interface ShaderParamDecl {
	name: string;
	kind: ShaderParamKind;
	/** float: number; vecN: N numbers; color: "#rrggbb"; texture: a path ("" when none). */
	default: ShaderParamValue;
	min?: number;
	max?: number;
	/** 1-based line in the file. */
	line: number;
}

export interface ShaderProblem {
	/** 1-based line in the file; 0 when not tied to a line. */
	line: number;
	message: string;
}

export interface ShaderInfo {
	params: ShaderParamDecl[];
	/** Metres vertex() may move vertices (`// @bounds`). */
	bounds: number;
	hasVertex: boolean;
	hasSurface: boolean;
	/** Calls depth_fade(): needs a transparent material. */
	usesDepth: boolean;
	problems: ShaderProblem[];
}

const VEC_SIZE: Record<ShaderParamKind, number> = { float: 1, vec2: 2, vec3: 3, vec4: 4, color: 3, texture: 0 };
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Reads a shader's header and notes which hooks it defines. */
export function parseShader(src: string): ShaderInfo {
	const info: ShaderInfo = { params: [], bounds: 0, hasVertex: /\bvoid\s+vertex\s*\(/.test(src), hasSurface: /\bvoid\s+surface\s*\(/.test(src), usesDepth: src.includes("depth_fade("), problems: [] };
	let textures = 0;
	src.split("\n").forEach((raw, i) => {
		const line = i + 1;
		const t = raw.trim();
		const problem = (message: string) => info.problems.push({ line, message });
		if (t.startsWith("// @bounds")) {
			const n = Number(t.slice("// @bounds".length).trim());
			if (t.slice("// @bounds".length).trim() === "" || !Number.isFinite(n)) problem("@bounds needs a number (metres)");
			else info.bounds = n;
			return;
		}
		if (!t.startsWith("// @param")) return;
		const body = t.slice("// @param".length).trim();
		const eq = body.indexOf("=");
		const [kind, rawName] = (eq >= 0 ? body.slice(0, eq) : body).trim().split(/\s+/);
		if (!kind || !rawName) return problem("@param needs a kind and a name: // @param float speed = 1 [0, 5]");
		if (!(SHADER_PARAM_KINDS as readonly string[]).includes(kind)) return problem(`unknown @param kind "${kind}" (${SHADER_PARAM_KINDS.join(", ")})`);
		const name = rawName;
		if (!IDENT.test(name) || name.startsWith("gl_") || name.startsWith("u_")) return problem(`@param name "${name}" is not a GLSL identifier (and gl_/u_ are reserved)`);
		if (info.params.some((p) => p.name === name)) return problem(`@param ${name} declared twice`);
		if (info.params.length === MAX_SHADER_PARAMS) return problem(`more than ${MAX_SHADER_PARAMS} @params`);
		if (kind === "texture" && textures++ === MAX_SHADER_TEXTURES) return problem(`more than ${MAX_SHADER_TEXTURES} texture @params`);
		const decl: ShaderParamDecl = { name, kind: kind as ShaderParamKind, default: defaultFor(kind as ShaderParamKind), line };
		if (eq >= 0) {
			let v = body.slice(eq + 1).trim();
			const br = v.indexOf("[");
			if (br >= 0) {
				const range = v.slice(br).replace(/[[\]\s]/g, "").split(",").map(Number);
				if (range.length === 2 && range.every(Number.isFinite)) [decl.min, decl.max] = range;
				else problem(`bad range "${v.slice(br)}" (use [min, max])`);
				v = v.slice(0, br).trim();
			}
			if (kind === "texture") decl.default = v;
			else if (kind === "color") {
				if (HEX.test(v)) decl.default = v.toLowerCase();
				else problem(`bad colour "${v}" (use #rrggbb)`);
			} else {
				const nums = v.replace(/[()]/g, "").split(",").map((x) => Number(x.trim()));
				if (!nums.every(Number.isFinite) || v === "") problem(`bad default "${v}"`);
				else decl.default = kind === "float" ? nums[0] : Array.from({ length: VEC_SIZE[decl.kind] }, (_, k) => nums[k] ?? 0);
			}
		}
		info.params.push(decl);
	});
	return info;
}

function defaultFor(kind: ShaderParamKind): ShaderParamValue {
	if (kind === "float") return 0;
	if (kind === "color") return "#ffffff";
	if (kind === "texture") return "";
	return new Array(VEC_SIZE[kind]).fill(0);
}

/** Problems with a material's `params` for this shader, one line each ("params.speed: …"). `null` (clears a value) is fine. */
export function validateShaderParams(info: ShaderInfo, values: unknown): string[] {
	if (values === undefined) return [];
	if (typeof values !== "object" || values === null || Array.isArray(values)) return ['params must be an object of name: value, e.g. {"speed": 2}'];
	const out: string[] = [];
	const names = info.params.map((p) => p.name);
	for (const [name, v] of Object.entries(values)) {
		const decl = info.params.find((p) => p.name === name);
		if (!decl) {
			out.push(`params.${name}: the shader has no such @param${names.length ? ` (it has ${names.join(", ")})` : ""}`);
			continue;
		}
		if (v === null) continue;
		const bad = checkValue(decl, v);
		if (bad) out.push(`params.${name}: ${bad}`);
	}
	return out;
}

function checkValue(d: ShaderParamDecl, v: unknown): string | undefined {
	const n = VEC_SIZE[d.kind];
	const inRange = (x: number) => (d.min === undefined || d.max === undefined || (x >= d.min && x <= d.max) ? undefined : `${x} is outside [${d.min}, ${d.max}]`);
	switch (d.kind) {
		case "float":
			return typeof v === "number" ? inRange(v) : "must be a number";
		case "texture":
			return typeof v === "string" && v !== "" && !v.startsWith("#") ? undefined : 'must be a texture path under assets/, e.g. "textures/foam.png"';
		case "color":
			if (typeof v === "string") return HEX.test(v) ? undefined : 'must be "#rrggbb"';
			return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? undefined : 'must be "#rrggbb" (or [r, g, b] 0..1)';
		default:
			return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number") ? undefined : `must be ${n} numbers`;
	}
}

/** Each param's value as a material would set it (the default when unset). */
export function shaderValues(info: ShaderInfo, values: Record<string, unknown> = {}): Record<string, ShaderParamValue> {
	const out: Record<string, ShaderParamValue> = {};
	for (const p of info.params) out[p.name] = (values[p.name] ?? p.default) as ShaderParamValue;
	return out;
}

/** A field of the scene environment's `post` block (the engine's Environment.post). Zero leaves the image as it is. */
export interface PostField {
	name: string;
	kind: "number" | "color" | "rgb";
	min: number;
	max: number;
	/** What it does, for tools and the inspector. */
	about: string;
}

export const POST_FIELDS: PostField[] = [
	{ name: "bloom", kind: "number", min: 0, max: 2, about: "glow around light brighter than the threshold (emissive above 1, glints); ~0.5" },
	{ name: "bloom_threshold", kind: "number", min: 0, max: 10, about: "linear brightness where bloom starts (0 = 1)" },
	{ name: "outline", kind: "number", min: 0, max: 1, about: "toon outlines where the depth jumps (silhouettes)" },
	{ name: "outline_width", kind: "number", min: 0, max: 8, about: "outline width in pixels (0 = 1)" },
	{ name: "outline_color", kind: "color", min: 0, max: 1, about: "outline colour, sRGB [r, g, b] (0 = near black)" },
	{ name: "outline_threshold", kind: "number", min: 0, max: 1, about: "relative depth jump that counts as an edge (0 = 0.05)" },
	{ name: "contrast", kind: "number", min: -1, max: 1, about: "contrast around mid grey" },
	{ name: "saturation", kind: "number", min: -1, max: 1, about: "-1 grey .. 1 vivid" },
	{ name: "temperature", kind: "number", min: -1, max: 1, about: "white balance: -1 cool .. 1 warm" },
	{ name: "tint", kind: "number", min: -1, max: 1, about: "white balance: -1 green .. 1 magenta" },
	{ name: "lift", kind: "rgb", min: -0.5, max: 0.5, about: "added to the shadows per channel (~±0.1)" },
	{ name: "gamma", kind: "rgb", min: -1, max: 1, about: "midtones per channel: positive brightens (~±0.3)" },
	{ name: "gain", kind: "rgb", min: -1, max: 1, about: "highlights per channel: 0.1 = ×1.1" },
	{ name: "vignette", kind: "number", min: 0, max: 1, about: "darkening toward the corners" },
	{ name: "chromatic_aberration", kind: "number", min: 0, max: 1, about: "colour fringes toward the edges (~0.3 subtle)" },
];

/** Problems with an environment's `post` block, one line each ("environment.post.bloom: …"). */
export function validatePost(post: unknown): string[] {
	if (post === undefined) return [];
	if (typeof post !== "object" || post === null || Array.isArray(post)) return ["environment.post must be an object of effects"];
	const out: string[] = [];
	for (const [k, v] of Object.entries(post)) {
		const f = POST_FIELDS.find((x) => x.name === k);
		const at = `environment.post.${k}`;
		if (!f) {
			out.push(`${at}: no such effect (${POST_FIELDS.map((x) => x.name).join(", ")})`);
			continue;
		}
		const nums = f.kind === "number" ? (typeof v === "number" ? [v] : null) : Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? (v as number[]) : null;
		if (!nums) out.push(`${at}: must be ${f.kind === "number" ? "a number" : "3 numbers [r, g, b]"}`);
		else if (nums.some((x) => x < f.min || x > f.max)) out.push(`${at}: ${JSON.stringify(v)} is outside [${f.min}, ${f.max}]`);
	}
	return out;
}

/** `shaders/water.glsl` (as materials name it) for a shader's name ("water", "nature/wind"), and back. */
export const shaderPath = (name: string) => `shaders/${name}.glsl`;
export const shaderName = (path: string) => path.replace(/^(assets\/)?shaders\//, "").replace(/\.glsl$/, "");

/**
 * Problems with the material shaders a scene's entities use: missing files, and params that don't fit the shader.
 * `read` returns a shader's source by its engine path ("shaders/water.glsl"), or null when there is no such file.
 */
export function sceneShaderProblems(entities: { id: number; [k: string]: unknown }[], read: (path: string) => string | null): string[] {
	const out: string[] = [];
	const cache = new Map<string, ShaderInfo | null>();
	for (const e of entities) {
		const mr = e.Mesh_Renderer as { material?: { shader?: unknown; params?: unknown; transparent?: unknown } } | undefined;
		const shader = mr?.material?.shader;
		if (typeof shader !== "string" || shader === "") continue;
		const where = `entity ${e.id}${typeof e.Name === "string" ? ` (${e.Name})` : ""}: material`;
		if (!cache.has(shader)) {
			const src = read(shader);
			cache.set(shader, src === null ? null : parseShader(src));
		}
		const info = cache.get(shader);
		if (!info) {
			out.push(`${where}.shader: no assets/${shader}`);
			continue;
		}
		for (const p of validateShaderParams(info, mr?.material?.params)) out.push(`${where}.${p}`);
		if (info.usesDepth && mr?.material?.transparent !== true) out.push(`${where}: ${shader} uses depth_fade, which only works on a transparent material`);
	}
	return out;
}

/** Starting points for a new shader. */
export const SHADER_TEMPLATES: { id: string; label: string; source: string }[] = [
	{
		id: "surface",
		label: "Surface (colour, shine, glow)",
		source: `// What this material looks like, in a line or two.
// @param color tint = #ffffff
// @param float shine = 0.5 [0, 1]

void surface(inout Surface s) {
    s.albedo *= tint;
    s.roughness = mix(0.9, 0.1, shine);
}
`,
	},
	{
		id: "vertex",
		label: "Moving vertices (waves, wind)",
		source: `// What moves, and how.
// @param float amount = 0.1 [0, 1]
// @param float speed = 1.5 [0, 5]
// @bounds 0.2

void vertex(inout Vertex v) {
    float h = clamp(v.local.y + 0.5, 0.0, 1.0); // 0 at the bottom of a built-in mesh, 1 at the top
    v.position.x += sin(u_time * speed + v.position.z) * amount * h;
}

void surface(inout Surface s) {
}
`,
	},
	{
		id: "glow",
		label: "Glow (pulsing emission, blooms)",
		source: `// A glow that breathes over time.
// @param color glow = #ffb347
// @param float strength = 4 [0, 20]
// @param float speed = 2 [0, 10]

void surface(inout Surface s) {
    s.emission = glow * strength * (0.75 + 0.25 * sin(u_time * speed));
}
`,
	},
];

/** A value as it is written after `=` in an @param line. */
export function formatParamDefault(kind: ShaderParamKind, v: ShaderParamValue): string {
	const n = (x: number) => String(Math.round(x * 1000) / 1000);
	if (kind === "texture" || kind === "color") return String(v);
	return Array.isArray(v) ? v.map(n).join(", ") : n(Number(v));
}

/** The source with these values as its @params' defaults (ranges and the rest of each line kept). */
export function setParamDefaults(src: string, values: Record<string, ShaderParamValue>): string {
	const info = parseShader(src);
	const lines = src.split("\n");
	for (const p of info.params) {
		if (!(p.name in values)) continue;
		const line = lines[p.line - 1];
		const head = line.slice(0, line.indexOf(p.name) + p.name.length);
		const range = /\[[^\]]*\]\s*$/.exec(line)?.[0];
		lines[p.line - 1] = `${head} = ${formatParamDefault(p.kind, values[p.name])}${range ? ` ${range}` : ""}`;
	}
	return lines.join("\n");
}
