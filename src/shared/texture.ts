// Tileable surface textures (M9): the format of assets/textures/<name>/texture.json, the asset. Its folder holds
// candidates/ (generated seamless images, with candidates.json saying how each was made) and, once one is chosen
// and made, <name>.png (colour), <name>_normal.png and <name>_roughness.png, which Materials in scenes use.

/** How a texture is made and used. */
export interface TextureFile {
	/** What it's for, for people and agents. */
	notes?: string;
	/** The generation prompt (the subject; the studio adds "seamless, top-down…"). */
	prompt?: string;
	/** How wide one repeat is in the world, in metres: scenes size their tiling from it. */
	tile: number;
	/** The chosen candidate, relative to the texture's folder (candidates/<name>-<seed>-<method>.png). */
	source?: string;
	/** Relief of the derived normal map (0 flat; default 4). */
	normal_strength?: number;
	/** Roughness from raised parts to crevices, 0..1 (default [0.55, 0.95]). */
	roughness?: [number, number];
}

export const TEXTURE_DEFAULTS = { tile: 2, normal_strength: 4, roughness: [0.55, 0.95] as [number, number] };

export interface TextureProblem {
	at: string;
	message: string;
}

const FIELDS = ["notes", "prompt", "tile", "source", "normal_strength", "roughness"];

export function validateTexture(json: unknown): TextureProblem[] {
	const problems: TextureProblem[] = [];
	if (typeof json !== "object" || json === null || Array.isArray(json)) return [{ at: "", message: "texture.json is a JSON object" }];
	const t = json as Record<string, unknown>;
	for (const k of Object.keys(t)) if (!FIELDS.includes(k)) problems.push({ at: k, message: `Unknown field (fields: ${FIELDS.join(", ")})` });
	for (const k of ["notes", "prompt"]) if (t[k] !== undefined && typeof t[k] !== "string") problems.push({ at: k, message: "A string" });
	if (typeof t.tile !== "number" || !(t.tile > 0) || t.tile > 1000) problems.push({ at: "tile", message: "Metres per repeat, more than 0 (e.g. 2)" });
	if (t.source !== undefined && (typeof t.source !== "string" || !/^candidates\/[^/]+\.png$/.test(t.source))) {
		problems.push({ at: "source", message: "A candidate image: candidates/<file>.png" });
	}
	if (t.normal_strength !== undefined && (typeof t.normal_strength !== "number" || t.normal_strength < 0 || t.normal_strength > 20)) {
		problems.push({ at: "normal_strength", message: "0 (flat) to 20" });
	}
	if (t.roughness !== undefined) {
		const r = t.roughness;
		if (!Array.isArray(r) || r.length !== 2 || !r.every((x) => typeof x === "number" && x >= 0 && x <= 1) || r[0] > r[1]) {
			problems.push({ at: "roughness", message: "[min, max], each 0..1, min ≤ max" });
		}
	}
	return problems;
}

export function parseTexture(text: string): { texture: TextureFile | null; problems: TextureProblem[] } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		return { texture: null, problems: [{ at: "", message: `Not valid JSON: ${(err as Error).message}` }] };
	}
	const problems = validateTexture(json);
	return { texture: problems.length ? null : (json as TextureFile), problems };
}

export const formatTexture = (t: TextureFile) => `${JSON.stringify(t, null, "\t")}\n`;

/** The files a made texture has, relative to its folder: colour, normal, roughness. */
export const textureFiles = (leaf: string) => [`${leaf}.png`, `${leaf}_normal.png`, `${leaf}_roughness.png`];

/** A candidate as candidates.json records it. */
export interface CandidateRecord {
	prompt: string;
	seed: number;
	/** How it was made seamless: "roll" (during generation) or "quilt" (cut afterwards). */
	method: string;
	model: string;
	at: string;
}
