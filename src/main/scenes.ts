// Scenes: structured edits to scene and prefab files in a checkout (the Scenes section's buttons, run in a
// session's worktree through `workspace.run`). The file is the truth; see src/shared/scene.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { applyEdits, formatScene, parseScene, type SceneEdit, stripJson5, validateScene } from "../shared/scene";
import { safeJoin } from "./assets";

export const SCENE_ROOTS = ["assets/scenes", "assets/prefabs"];

/** Applies edits to a scene or prefab file (repo-relative) and writes it back formatted. */
/**
 * Puts a scene or prefab file in the studio's layout (one entity per line), as edit_scene and the Scenes section
 * write it, when it parses cleanly and isn't already: an agent that rewrote it with a script (pretty-printed) would
 * otherwise turn a small change into a diff of the whole file. Files with comments or other JSON5 are left alone
 * (the layout can't keep them). True when it rewrote the file.
 */
export function normalizeSceneFile(file: string): boolean {
	const text = readFileSync(file, "utf8");
	if (stripJson5(text) !== text) return false;
	const { scene, errors } = parseScene(text);
	if (!scene || errors.length) return false;
	const formatted = formatScene(scene);
	if (formatted === text) return false;
	writeFileSync(file, formatted);
	return true;
}

export function editScene(cwd: string, p: { path: string; edits: SceneEdit[] }): { created: number[]; deleted: number[]; problems: string[] } {
	if (!SCENE_ROOTS.some((r) => p.path.startsWith(`${r}/`)) || !p.path.endsWith(".json")) {
		throw new Error(`Not a scene or prefab: ${p.path} (they live in ${SCENE_ROOTS.join(" and ")})`);
	}
	const file = safeJoin(cwd, p.path);
	if (!existsSync(file)) throw new Error(`No ${p.path} in this checkout`);
	const parsed = parseScene(readFileSync(file, "utf8"));
	if (!parsed.scene || parsed.errors.length) throw new Error(`${p.path} can't be edited until it's fixed: ${parsed.errors.join("; ")}`);
	const r = applyEdits(parsed.scene, p.edits);
	writeFileSync(file, formatScene(r.scene));
	const prefabs = r.scene.entities.flatMap((e) => (e.prefab ? [e.prefab] : [])).filter((x) => !existsSync(safeJoin(cwd, `assets/${x}`)));
	return { created: r.created, deleted: r.deleted, problems: [...validateScene(r.scene), ...prefabs.map((x) => `prefab ${x} not found`)] };
}
