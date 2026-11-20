import { leafName, nameFromPath } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { parseTexture } from "../../shared/texture";

/**
 * A texture is a folder, `assets/textures/<name>/`: a tileable surface (ground, path, wall, floor…). Its
 * `texture.json` stands for it as the module's asset; `<name>.png`, `_normal.png` and `_roughness.png` are what
 * scenes use (see the vault note "M9 Textures").
 */
export const textures: ModuleInfo = {
	id: "textures",
	name: "Textures",
	icon: "🧱",
	roots: ["assets/textures"],
	extensions: ["/texture.json"],
	agentType: "texture-artist",
	noun: "texture",
};

/** The texture's name from its asset path: its folder under assets/textures (`ground/grass`). */
export const textureName = (assetPath: string) => nameFromPath("assets/textures", assetPath);

/** Its files as the engine loads them (relative to assets/): colour, normal, roughness. */
export function texturePaths(name: string): { texture: string; normal_map: string; roughness_map: string } {
	const base = `textures/${name}/${leafName(name)}`;
	return { texture: `${base}.png`, normal_map: `${base}_normal.png`, roughness_map: `${base}_roughness.png` };
}

export function summarizeTexture(text: string, path: string): { title: string; excerpt: string } {
	const { texture, problems } = parseTexture(text);
	const facts = texture ? [`${texture.tile} m tile`, texture.source ? "made" : "candidates only"] : [`${problems.length} problem${problems.length > 1 ? "s" : ""} in texture.json`];
	const excerpt = [texture?.notes ?? texture?.prompt, facts.join(" · ")].filter(Boolean).join(" — ");
	return { title: leafName(textureName(path)), excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
