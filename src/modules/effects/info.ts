import { leafName } from "../../shared/asset-names";
import { EFFECT_DIR, PARTICLE_TEXTURE_DIR, parseEffect, summarizeEffectFile, validateParticleTexture } from "../../shared/effect";
import type { ModuleInfo } from "../../shared/modules";

/**
 * Visual effects (M12): effect files (`assets/effects/<name>.json`: emitters of particles the engine plays) and the
 * particle textures they use (`assets/effects/textures/<name>/`). See the vault note "M12 Particles".
 */
export const effects: ModuleInfo = {
	id: "effects",
	name: "Effects",
	icon: "🎆",
	roots: [EFFECT_DIR],
	extensions: [".json"],
	exclude: ["/candidates/"],
	folderAssets: [PARTICLE_TEXTURE_DIR],
	agentType: "vfx-artist",
	noun: "effect",
};

export const isTexture = (path: string) => path.startsWith(`${PARTICLE_TEXTURE_DIR}/`);
/** An effect's name from its path: `assets/effects/chest/open.json` is "chest/open" (what effect_play takes, as effects/<name>.json). */
export const effectName = (path: string) => path.slice(EFFECT_DIR.length + 1).replace(/\.json$/, "");
/** A texture's name: its folder under assets/effects/textures. */
export const textureName = (path: string) => path.slice(PARTICLE_TEXTURE_DIR.length + 1, path.lastIndexOf("/"));
/** The image effects use for a texture (assets-relative). */
export const textureImage = (name: string) => `effects/textures/${name}/${leafName(name)}.png`;

export function summarizeEffect(text: string, path: string): { title: string; excerpt: string } {
	if (isTexture(path)) {
		const name = textureName(path);
		try {
			const t = JSON.parse(text);
			if (validateParticleTexture(t).length) return { title: name, excerpt: "problems in its .json" };
			const what = t.mode === "procedural" ? `procedural ${t.recipe.shape}` : `${t.mode}${t.source ? "" : " · candidates only"}`;
			return { title: name, excerpt: [what, t.flipbook ? `flipbook ${t.flipbook[0]}×${t.flipbook[1]}` : "", t.notes ?? t.prompt ?? ""].filter(Boolean).join(" · ") };
		} catch {
			return { title: name, excerpt: "not valid JSON" };
		}
	}
	const { effect, problems } = parseEffect(text);
	const name = effectName(path);
	if (!effect) return { title: name, excerpt: problems[0] ?? "can't be read" };
	return { title: name, excerpt: [effect.notes, summarizeEffectFile(effect), problems.length ? `${problems.length} problem${problems.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ") };
}
