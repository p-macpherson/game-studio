// What a manual edit from a section is called in the undo history, and which files it may change.
import type { SceneEdit } from "../shared/scene";
import type { Scope } from "./edit-history";

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
const MODEL_STEPS: Record<string, string> = {
	generate_concepts: "concepts",
	generate_model: "generated",
	retexture_model: "retextured",
	rig_model: "rigged",
	rig_prop: "prop rig",
	animate_model: "animated",
	finalize_model: "finalized",
};

/** A section's step (`worktrees.run`) as a history step; null for steps that change nothing (previews). */
export function manualStep(method: string, params: Record<string, unknown>): { label: string; scopes: Scope[] } | null {
	const name = String(params.name ?? params.model ?? "");
	if (method === "edit_scene") {
		const path = String(params.path);
		const what = [...new Set(((params.edits as SceneEdit[]) ?? []).map(describeSceneEdit))].join(", ");
		return { label: `Scene ${leaf(path)}: ${what || "edited"}`, scopes: [{ path }] };
	}
	if (method in MODEL_STEPS) return { label: `Model ${name}: ${MODEL_STEPS[method]}`, scopes: [{ path: `assets/models/${name}` }] };
	if (method === "edit_sound" || method === "render_sound" || method === "generate_sound") {
		const set = Object.keys((params.set as Record<string, unknown>) ?? {});
		const what = method === "generate_sound" ? "new takes" : method === "render_sound" ? "rendered" : [...(params.variants ? ["variants"] : []), ...set].join(", ") || "edited";
		return { label: `Sound ${name}: ${what}`, scopes: [{ path: `assets/sounds/${name}` }] };
	}
	if (method === "generate_texture" || method === "make_texture") {
		return { label: `Texture ${name}: ${method === "generate_texture" ? "new candidates" : "made"}`, scopes: [{ path: `assets/textures/${name}` }] };
	}
	if (method === "edit_song" || method === "render_song") {
		return { label: `Music ${name}: ${method === "render_song" ? "rendered" : "edited"}`, scopes: [{ path: `assets/music/${name}` }] };
	}
	return null;
}

function describeSceneEdit(e: SceneEdit): string {
	switch (e.op) {
		case "set":
			return `set ${e.component}`;
		case "remove_component":
			return `removed ${e.component}`;
		case "add":
			return "added an entity";
		case "delete":
			return "deleted an entity";
		case "duplicate":
			return "duplicated an entity";
		case "notes":
			return "notes";
		case "environment":
			return "environment";
	}
}

/** Moving `from` to `to`: both places (a folder-shaped asset's whole folder), and every file that can refer to them. */
export function moveStep(from: string, to: string): { label: string; scopes: Scope[] } {
	const place = (p: string) => (/\/(model|sound|song)\.json$/.test(p) ? p.slice(0, p.lastIndexOf("/")) : p);
	const [a, b] = [place(from), place(to)];
	const sameFolder = a.slice(0, a.lastIndexOf("/")) === b.slice(0, b.lastIndexOf("/"));
	return {
		label: sameFolder ? `Renamed ${leaf(a)} → ${leaf(b)}` : `Moved ${leaf(a)} to ${b.slice(0, b.lastIndexOf("/"))}`,
		scopes: [
			{ path: a },
			{ path: b },
			{ path: "assets", only: /\.json$/ },
			{ path: "game", only: /\.(odin|json|jsonl)$/ },
			{ path: "tests" },
			{ path: "docs", only: /\.md$/ },
		],
	};
}
