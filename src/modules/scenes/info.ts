import type { ModuleInfo } from "../../shared/modules";
import { parseScene } from "../../shared/scene";

/** Scenes (`assets/scenes/*.json`) and prefabs (`assets/prefabs/*.json`): the engine's scene files, edited structurally. */
export const scenes: ModuleInfo = {
	id: "scenes",
	name: "Scenes",
	icon: "🗺️",
	roots: ["assets/scenes", "assets/prefabs"],
	extensions: [".json"],
	agentType: "level-designer",
	noun: "scene",
};

export const isPrefab = (path: string) => path.startsWith("assets/prefabs/");
/** The path the engine loads it by (relative to assets/). */
export const enginePath = (path: string) => path.replace(/^assets\//, "");

export function summarizeScene(text: string, path: string): { title: string; excerpt: string } {
	const name = (path.split("/").pop() ?? path).replace(/\.json$/, "");
	const title = isPrefab(path) ? `${name} (prefab)` : name;
	const { scene, errors } = parseScene(text);
	if (!scene) return { title, excerpt: errors[0] ?? "" };
	const prefabs = new Map<string, number>();
	for (const e of scene.entities) if (e.prefab) prefabs.set(e.prefab, (prefabs.get(e.prefab) ?? 0) + 1);
	const uses = [...prefabs].map(([p, n]) => `${p.replace(/^.*\//, "").replace(/\.json$/, "")}${n > 1 ? ` ×${n}` : ""}`);
	const facts = [`${scene.entities.length} entit${scene.entities.length === 1 ? "y" : "ies"}`, uses.length && uses.join(", ")].filter(Boolean).join(" · ");
	const excerpt = [scene.notes, facts].filter(Boolean).join(" — ");
	return { title, excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
