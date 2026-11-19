import type { ModelManifest } from "../../shared/gen";
import type { ModuleInfo } from "../../shared/modules";

/**
 * A model is a folder, `assets/models/<name>/`. Its `model.json` stands for it as the module's asset: it exists
 * from the first concepts on, it's text (searchable, diffable), and every generation step updates it, so a
 * session working on a model shows up as a draft.
 */
export const models3d: ModuleInfo = {
	id: "3d-models",
	name: "3D Models",
	icon: "🧊",
	roots: ["assets/models"],
	extensions: ["/model.json"],
	agentType: "3d-modeller",
	noun: "model",
};

/** "treasure-chest" -> "Treasure chest". */
export const modelTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

/** The model's folder name from its asset path (`assets/models/<name>/model.json`). */
export const modelName = (assetPath: string) => assetPath.split("/").at(-2) ?? assetPath;

export function summarizeModel(text: string, path: string): { title: string; excerpt: string } {
	let m: Partial<ModelManifest> = {};
	try {
		m = JSON.parse(text);
	} catch {
		// A half-written or hand-broken manifest still lists, by folder name.
	}
	const name = m.name ?? modelName(path);
	const facts = m.stats
		? [m.height && `${m.height} m`, m.textured && "textured", m.rigged && "rigged", typeof m.stats.triangles === "number" && `${m.stats.triangles.toLocaleString("en")} tris`]
		: ["concepts only"];
	const description = m.description ?? m.conceptSource?.prompt ?? "";
	const excerpt = [description, facts.filter(Boolean).join(" · ")].filter(Boolean).join(" — ");
	return { title: modelTitle(name), excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
