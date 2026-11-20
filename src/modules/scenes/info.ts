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

export interface PrefabInfo {
	/** The model its root shows (`assets/models/<name>/…`), for a thumbnail. */
	model?: string;
	/** Scenes (and prefabs) that place it: file name and how many times. */
	usedIn: { name: string; count: number }[];
}

/** For each prefab (by asset path): its model and where it's placed, from the module's files. */
export function prefabIndex(files: { path: string; text: string }[]): Map<string, PrefabInfo> {
	const index = new Map<string, PrefabInfo>();
	const entry = (path: string) => index.get(path) ?? index.set(path, { usedIn: [] }).get(path)!;
	for (const f of files) {
		const scene = parseScene(f.text).scene;
		if (!scene) continue;
		if (isPrefab(f.path)) {
			const mesh = scene.entities.find((e) => !e.prefab && typeof (e.Mesh_Renderer as { mesh?: unknown } | undefined)?.mesh === "string");
			const model = (mesh?.Mesh_Renderer as { mesh: string } | undefined)?.mesh;
			entry(f.path).model = model && `assets/${model}`;
		}
		const counts = new Map<string, number>();
		for (const e of scene.entities) if (e.prefab) counts.set(`assets/${e.prefab}`, (counts.get(`assets/${e.prefab}`) ?? 0) + 1);
		const name = (f.path.split("/").pop() ?? f.path).replace(/\.json$/, "");
		for (const [prefab, count] of counts) entry(prefab).usedIn.push({ name: isPrefab(f.path) ? `${name} (prefab)` : name, count });
	}
	return index;
}

export function summarizeScene(text: string, path: string): { title: string; excerpt: string } {
	const name = (path.split("/").pop() ?? path).replace(/\.json$/, "");
	const title = name;
	const { scene, errors } = parseScene(text);
	if (!scene) return { title, excerpt: errors[0] ?? "" };
	const prefabs = new Map<string, number>();
	for (const e of scene.entities) if (e.prefab) prefabs.set(e.prefab, (prefabs.get(e.prefab) ?? 0) + 1);
	const uses = [...prefabs].map(([p, n]) => `${p.replace(/^.*\//, "").replace(/\.json$/, "")}${n > 1 ? ` ×${n}` : ""}`);
	const facts = [`${scene.entities.length} entit${scene.entities.length === 1 ? "y" : "ies"}`, uses.length && uses.join(", ")].filter(Boolean).join(" · ");
	const excerpt = [scene.notes, facts].filter(Boolean).join(" — ");
	return { title, excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
