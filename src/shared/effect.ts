/**
 * Effects (`assets/effects/<name>.json`, the engine's effects_format.odin) and particle textures
 * (`assets/effects/textures/<name>/<leaf>.json` + `<leaf>.png`). The rules mirror the engine's, with its messages, so
 * problems show without running the game. See the engine's docs/making-a-game.md "Effects" and the vault note
 * "M12 Particles".
 */

export const EFFECT_DIR = "assets/effects";
export const PARTICLE_TEXTURE_DIR = "assets/effects/textures";

export const EMITTER_FIELDS = [
	"name", "sim", "space", "max", "rate", "burst", "delay", "duration", "shape", "offset", "life", "speed", "velocity",
	"gravity", "drag", "force", "noise", "noise_scale", "rotation", "rotation_speed", "size", "size_random", "color",
	"intensity", "texture", "flipbook", "fps", "random_frame", "blend", "soft", "align", "stretch", "sort", "notes",
] as const;
export const SHAPE_KINDS = ["point", "sphere", "hemisphere", "box", "cone", "ring", "line"] as const;
export const MAX_CURVE_KEYS = 8;
export const MAX_GPU_KEYS = 4;

export type Emitter = Partial<Record<(typeof EMITTER_FIELDS)[number], unknown>>;
export interface EffectFile {
	notes?: string;
	duration?: number;
	loop?: boolean;
	emitters: Emitter[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Reads an effect file: the effect (null when it can't be used) and its problems, each saying where it is. */
export function parseEffect(text: string): { effect: EffectFile | null; problems: string[] } {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		return { effect: null, problems: [`not valid JSON: ${(e as Error).message}`] };
	}
	if (!isObject(v)) return { effect: null, problems: ['an effect is an object: {"emitters": [...]}'] };
	const problems = validateEffect(v);
	const ok = Array.isArray(v.emitters) && v.emitters.length > 0 && v.emitters.some(isObject);
	return { effect: ok ? (v as unknown as EffectFile) : null, problems };
}

export function validateEffect(v: Record<string, unknown>): string[] {
	const out: string[] = [];
	const at = (where: string, msg: string) => out.push(`${where}: ${msg}`);
	for (const k of Object.keys(v)) if (!["notes", "duration", "loop", "emitters"].includes(k)) at("effect", `unknown field "${k}"`);
	if (v.duration !== undefined && (!isNum(v.duration) || v.duration < 0)) at("effect", "duration must be seconds (0 = forever)");
	if (v.loop !== undefined && typeof v.loop !== "boolean") at("effect", "loop must be true or false");
	if (v.loop === true && !(isNum(v.duration) && v.duration > 0)) at("effect", "loop needs a duration");
	if (!Array.isArray(v.emitters) || v.emitters.length === 0) {
		at("effect", "emitters must be a list of at least one emitter");
		return out;
	}
	v.emitters.forEach((e, i) => {
		const where = `emitters[${i}]`;
		if (!isObject(e)) return at(where, "must be an object");
		validateEmitter(e, where, at);
	});
	return out;
}

function validateEmitter(e: Record<string, unknown>, where: string, at: (w: string, m: string) => void) {
	for (const k of Object.keys(e)) if (!(EMITTER_FIELDS as readonly string[]).includes(k)) at(where, `unknown field "${k}"`);
	const gpu = e.sim === "gpu";
	const oneOf = (key: string, values: string[]) => {
		if (e[key] !== undefined && !values.includes(e[key] as string)) at(where, `${key} is ${values.map((x) => `"${x}"`).join(" or ")}`);
	};
	oneOf("sim", ["cpu", "gpu"]);
	oneOf("space", ["world", "local"]);
	oneOf("blend", ["alpha", "additive"]);
	oneOf("align", ["camera", "velocity", "ground"]);
	for (const k of ["max", "rate", "delay", "duration", "gravity", "drag", "noise", "noise_scale", "fps", "soft", "stretch", "intensity"]) {
		if (e[k] !== undefined && !isNum(e[k])) at(where, `${k} must be a number`);
	}
	const max = isNum(e.max) ? e.max : 0;
	if (!gpu && max > 20000) at(where, `max ${max} is a lot for the CPU: use "sim": "gpu" above about 20000`);
	for (const k of ["life", "speed", "rotation", "rotation_speed", "size_random"]) {
		const r = e[k];
		if (r !== undefined && !isNum(r) && !(Array.isArray(r) && r.length === 2 && r.every(isNum))) at(where, `${k} must be a number or [min, max]`);
	}
	const life = e.life;
	if ((isNum(life) && life <= 0) || (Array.isArray(life) && isNum(life[0]) && Math.min(life[0], life[1] as number) <= 0)) at(where, "life must be above 0 seconds");
	for (const k of ["offset", "velocity", "force"]) {
		const r = e[k];
		if (r !== undefined && !(Array.isArray(r) && r.length === 3 && r.every(isNum))) at(where, `${k} must be [x, y, z]`);
	}
	// Bursts
	if (e.burst !== undefined) {
		if (gpu) at(where, "GPU emitters are continuous fields: bursts are for CPU emitters");
		else if (Array.isArray(e.burst)) {
			e.burst.forEach((b, j) => {
				if (!isObject(b)) at(where, `burst[${j}] must be {"at": seconds, "count": n or [min, max]}`);
			});
		} else if (!isNum(e.burst)) at(where, 'burst must be a count or [{"at": seconds, "count": n}, ...]');
	}
	if (!gpu && !(isNum(e.rate) && e.rate > 0) && e.burst === undefined) at(where, "emits nothing: give it a rate or a burst");
	// Shape
	if (e.shape !== undefined) {
		const sw = `${where}.shape`;
		if (!isObject(e.shape)) at(sw, 'must be {"kind": "cone", ...}');
		else {
			for (const k of Object.keys(e.shape)) if (!["kind", "radius", "size", "angle", "length", "surface"].includes(k)) at(sw, `unknown field "${k}"`);
			const kind = e.shape.kind;
			if (kind !== undefined && !(SHAPE_KINDS as readonly string[]).includes(kind as string)) at(sw, `kind "${kind}": point, sphere, hemisphere, box, cone, ring or line`);
			if (isNum(e.shape.angle) && (e.shape.angle < 0 || e.shape.angle > 180)) at(sw, `angle ${e.shape.angle} is outside [0, 180]`);
		}
	}
	// Curves and gradients
	const keys = (k: string, n: number) => {
		if (n > MAX_CURVE_KEYS) at(where, `${k}: at most ${MAX_CURVE_KEYS} keys`);
		if (gpu && n > MAX_GPU_KEYS) at(where, `GPU emitters take at most ${MAX_GPU_KEYS} keys per curve`);
	};
	if (e.size !== undefined && !isNum(e.size)) {
		const ok = Array.isArray(e.size) && e.size.length > 0 && e.size.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum));
		if (!ok) at(where, "size must be a number or [[t, value], ...]");
		else {
			const size = e.size as number[][];
			keys("size", size.length);
			if (size.some((p, i, all) => i > 0 && p[0] < all[i - 1][0])) at(where, "size: keys must go up in t");
		}
	}
	if (e.color !== undefined) {
		if (typeof e.color === "string") {
			if (!HEX.test(e.color)) at(where, 'color must be "#rrggbb" or [[t, "#rrggbb", alpha, intensity], ...]');
		} else if (Array.isArray(e.color) && e.color.length > 0) {
			keys("color", e.color.length);
			e.color.forEach((k) => {
				if (!Array.isArray(k) || k.length < 2 || !isNum(k[0])) at(where, 'color keys are [t, "#rrggbb", alpha, intensity] (alpha and intensity optional)');
				else if (typeof k[1] !== "string" || !HEX.test(k[1])) at(where, `color: ${JSON.stringify(k[1])} is not "#rrggbb"`);
			});
		} else at(where, 'color must be "#rrggbb" or [[t, "#rrggbb", alpha, intensity], ...]');
	}
	if (e.flipbook !== undefined && !(Array.isArray(e.flipbook) && e.flipbook.length === 2 && e.flipbook.every((x) => isNum(x) && x >= 1))) at(where, "flipbook must be [columns, rows]");
	if (e.texture !== undefined && typeof e.texture !== "string") at(where, "texture must be a path under assets/");
}

/** Texture paths (assets-relative) an effect's emitters use. */
export function effectTextures(effect: EffectFile): string[] {
	return [...new Set(effect.emitters.flatMap((e) => (typeof e.texture === "string" && e.texture ? [e.texture] : [])))];
}

/** "3 emitters (sparks, flash, dust) · GPU · loops 2 s" */
export function summarizeEffectFile(effect: EffectFile): string {
	const names = effect.emitters.map((e, i) => (typeof e.name === "string" ? e.name : `#${i}`));
	const facts = [
		`${names.length} emitter${names.length === 1 ? "" : "s"} (${names.join(", ")})`,
		effect.emitters.some((e) => e.sim === "gpu") ? "GPU" : "",
		effect.loop ? `loops ${effect.duration} s` : effect.duration ? `${effect.duration} s` : effect.emitters.some((e) => isNum(e.rate) || e.sim === "gpu") ? "continuous" : "one-shot",
	];
	return facts.filter(Boolean).join(" · ");
}

// --- Particle textures -----------------------------------------------------------------------------------------------

export const PARTICLE_MODES = ["glow", "solid", "procedural"] as const;
export type ParticleMode = (typeof PARTICLE_MODES)[number];
export const PROCEDURAL_SHAPES = ["dot", "soft", "smoke", "dust", "spark", "star", "ember", "streak", "ring"] as const;
export const ANIMATED_SHAPES = ["smoke", "dust", "ring"];

export interface ParticleRecipe {
	shape: (typeof PROCEDURAL_SHAPES)[number];
	flipbook?: [number, number];
	seed?: number;
}

/** A particle texture's `<leaf>.json`: how it was made, and its flipbook layout (what effects set as `flipbook`). */
export interface ParticleTextureFile {
	mode: ParticleMode;
	prompt?: string;
	recipe?: ParticleRecipe;
	/** The chosen candidate (generated modes), e.g. "candidates/spark-3.png". */
	source?: string;
	flipbook?: [number, number];
	notes?: string;
}

/** How generated sprites are framed for FLUX, per mode. */
export const PARTICLE_FRAMING: Record<Exclude<ParticleMode, "procedural">, string> = {
	glow: "a single glowing element centred and isolated on a pure black background, nothing else, soft glow, game visual effect sprite",
	solid: "a single element centred and isolated on a plain flat white background, seen straight on, nothing else, game visual effect sprite",
};

export function validateParticleTexture(v: unknown): string[] {
	if (!isObject(v)) return ["must be an object"];
	const out: string[] = [];
	if (!(PARTICLE_MODES as readonly string[]).includes(v.mode as string)) out.push(`mode is one of ${PARTICLE_MODES.join(", ")}`);
	if (v.mode === "procedural") {
		const r = v.recipe;
		if (!isObject(r) || !(PROCEDURAL_SHAPES as readonly string[]).includes(r.shape as string)) out.push(`recipe.shape is one of ${PROCEDURAL_SHAPES.join(", ")}`);
		else if (r.flipbook !== undefined) {
			if (!Array.isArray(r.flipbook) || r.flipbook.length !== 2 || !r.flipbook.every((x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 8)) out.push("recipe.flipbook must be [columns, rows], 1-8 each");
			else if (!ANIMATED_SHAPES.includes(r.shape as string)) out.push(`a flipbook animates ${ANIMATED_SHAPES.join(", ")}, not ${r.shape}`);
		}
	}
	return out;
}

// --- Editing ---------------------------------------------------------------------------------------------------------

/** The file as the studio writes it: one field per line, short arrays (vectors, keys) on one line. */
export function formatEffect(effect: EffectFile): string {
	const compact = (v: unknown) => JSON.stringify(v);
	const field = (k: string, v: unknown, pad: string): string => {
		if (Array.isArray(v) && Array.isArray(v[0]) && compact(v).length > 100) return `${pad}"${k}": [\n${v.map((x) => `${pad}\t${compact(x)}`).join(",\n")}\n${pad}]`;
		if (isObject(v) && compact(v).length > 100) return `${pad}"${k}": {\n${Object.entries(v).map(([kk, vv]) => field(kk, vv, `${pad}\t`)).join(",\n")}\n${pad}}`;
		return `${pad}"${k}": ${compact(v)}`;
	};
	const top = Object.entries(effect).filter(([k]) => k !== "emitters").map(([k, v]) => field(k, v, "\t"));
	const emitters = effect.emitters.map((e) => `\t\t{\n${Object.entries(e).map(([k, v]) => field(k, v, "\t\t\t")).join(",\n")}\n\t\t}`);
	return `{\n${[...top, `\t"emitters": [\n${emitters.join(",\n")}\n\t]`].join(",\n")}\n}\n`;
}

/** Sets (or, with null, removes) a field of the effect or of one emitter. */
export function setEffectField(effect: EffectFile, emitter: number | null, key: string, value: unknown): EffectFile {
	const set = (o: Record<string, unknown>) => {
		const next = { ...o };
		if (value === null || value === undefined) delete next[key];
		else next[key] = value;
		return next;
	};
	if (emitter === null) return { ...(set(effect as unknown as Record<string, unknown>) as unknown as EffectFile), emitters: effect.emitters };
	return { ...effect, emitters: effect.emitters.map((e, i) => (i === emitter ? (set(e) as Emitter) : e)) };
}

export function addEmitter(effect: EffectFile, emitter: Emitter): EffectFile {
	return { ...effect, emitters: [...effect.emitters, emitter] };
}

export function removeEmitter(effect: EffectFile, index: number): EffectFile {
	return { ...effect, emitters: effect.emitters.filter((_, i) => i !== index) };
}

/** How long the effect takes to play out once (for looping the preview and the time scrubber), in seconds. */
export function effectLength(effect: EffectFile): number {
	if (isNum(effect.duration) && effect.duration > 0) {
		const life = Math.max(0, ...effect.emitters.map((e) => rangeMax(e.life, 1)));
		return effect.loop ? effect.duration : effect.duration + life;
	}
	let end = 0;
	for (const e of effect.emitters) {
		const life = rangeMax(e.life, 1);
		const delay = isNum(e.delay) ? e.delay : 0;
		const bursts = isNum(e.burst) ? [0] : Array.isArray(e.burst) ? (e.burst as { at?: number }[]).map((b) => (isNum(b?.at) ? b.at : 0)) : [];
		const continuous = e.sim === "gpu" || (isNum(e.rate) && e.rate > 0);
		end = Math.max(end, delay + (continuous ? (isNum(e.duration) && e.duration > 0 ? e.duration : 3) : Math.max(0, ...bursts)) + life);
	}
	return Math.max(end, 0.5);
}

function rangeMax(v: unknown, def: number): number {
	if (isNum(v)) return v;
	if (Array.isArray(v) && v.length === 2 && v.every(isNum)) return Math.max(v[0], v[1]);
	return def;
}

/** A curve as keys [[t, value], ...] (a plain number becomes one key). */
export function curveKeys(v: unknown, def: number): [number, number][] {
	if (isNum(v)) return [[0, v]];
	if (Array.isArray(v) && v.length && v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) return v as [number, number][];
	return [[0, def]];
}

/** Keys back to the file's form: one key is a plain number. */
export function curveValue(keys: [number, number][]): number | [number, number][] {
	const sorted = [...keys].sort((a, b) => a[0] - b[0]).map(([t, v]) => [round3(t), round3(v)] as [number, number]);
	return sorted.length === 1 ? sorted[0][1] : sorted;
}

export interface ColorStop {
	t: number;
	color: string;
	alpha: number;
	intensity: number;
}

export function gradientStops(v: unknown): ColorStop[] {
	if (typeof v === "string" && HEX.test(v)) return [{ t: 0, color: v.toLowerCase(), alpha: 1, intensity: 1 }];
	if (Array.isArray(v) && v.length) {
		return v.map((k) => {
			const a = Array.isArray(k) ? k : [];
			return { t: isNum(a[0]) ? a[0] : 0, color: typeof a[1] === "string" && HEX.test(a[1]) ? a[1].toLowerCase() : "#ffffff", alpha: isNum(a[2]) ? a[2] : 1, intensity: isNum(a[3]) ? a[3] : 1 };
		});
	}
	return [{ t: 0, color: "#ffffff", alpha: 1, intensity: 1 }];
}

/** Stops back to the file's form: one plain opaque stop is "#rrggbb"; keys leave out alpha and intensity at 1. */
export function gradientValue(stops: ColorStop[]): string | (string | number)[][] {
	const sorted = [...stops].sort((a, b) => a.t - b.t);
	if (sorted.length === 1 && sorted[0].alpha === 1 && sorted[0].intensity === 1) return sorted[0].color;
	return sorted.map((s) => {
		const key: (string | number)[] = [round3(s.t), s.color];
		if (s.alpha !== 1 || s.intensity !== 1) key.push(round3(s.alpha));
		if (s.intensity !== 1) key.push(round3(s.intensity));
		return key;
	});
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Starting points for a new effect. */
export const EFFECT_TEMPLATES: { id: string; label: string; effect: EffectFile }[] = [
	{
		id: "burst",
		label: "Burst (sparks, a hit, an opened chest)",
		effect: {
			notes: "What it is and when it plays.",
			emitters: [
				{ name: "sparks", max: 120, burst: [{ at: 0, count: [60, 80] }], shape: { kind: "cone", angle: 35, radius: 0.1 }, life: [0.5, 1], speed: [2.5, 4.5], gravity: 5, drag: 1, align: "velocity", stretch: 0.08, size: [[0, 0.06], [1, 0.02]], color: [[0, "#fff0b0", 1, 6], [0.5, "#ffb040", 1, 3], [1, "#ff5010", 0]], blend: "additive" },
			],
		},
	},
	{
		id: "smoke",
		label: "Continuous (smoke, steam, embers)",
		effect: {
			notes: "What it is and where it plays.",
			emitters: [
				{ name: "smoke", max: 120, rate: 14, shape: { kind: "cone", angle: 10, radius: 0.15 }, life: [2.5, 4], speed: [0.5, 0.8], gravity: -0.1, drag: 0.3, noise: 0.3, rotation: [0, 360], rotation_speed: [-20, 20], size: [[0, 0.2], [1, 1.2]], color: [[0, "#9a9590", 0], [0.15, "#8a8580", 0.5], [1, "#b0aca8", 0]], soft: 0.3 },
			],
		},
	},
	{
		id: "field",
		label: "Field on the GPU (rain, snow, fireflies)",
		effect: {
			notes: "What fills the area, and how big the area is.",
			emitters: [
				{ name: "motes", sim: "gpu", max: 2000, shape: { kind: "box", size: [8, 2, 8] }, offset: [0, 1, 0], life: [3, 6], speed: [0.02, 0.1], noise: 0.25, drag: 1, size: [[0, 0], [0.2, 0.04], [0.8, 0.04], [1, 0]], color: [[0, "#fff0c0", 1, 2], [1, "#fff0c0", 1, 2]], blend: "additive" },
			],
		},
	},
];
