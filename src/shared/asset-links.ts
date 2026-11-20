// Which assets use which: a scene places a prefab, a prefab shows a model, game code plays a sound or loads a scene.
// Found by the main process (asset-links in src/main) from quoted paths; here, what the sections do with them.
import type { ModuleInfo } from "./modules";

/** For each asset (by path), the assets that refer to it directly. */
export type AssetLinks = Record<string, string[]>;

/** Everything that uses `path`, directly or through what uses that (a model ← a prefab ← a scene ← game code). */
export function usersOf(links: AssetLinks, path: string): Set<string> {
	const seen = new Set<string>();
	const todo = [...(links[path] ?? [])];
	while (todo.length) {
		const next = todo.pop()!;
		if (seen.has(next) || next === path) continue;
		seen.add(next);
		todo.push(...(links[next] ?? []));
	}
	return seen;
}

/** The asset owning a repo path: the file itself, or the folder-shaped asset (its manifest's path) it's inside. */
export function ownerOf(modules: ModuleInfo[], assets: Set<string>, path: string): string | null {
	if (assets.has(path)) return path;
	for (const m of modules) {
		if (!m.extensions.every((e) => e.startsWith("/")) || !m.roots.some((r) => path.startsWith(`${r}/`))) continue;
		for (let dir = path.slice(0, path.lastIndexOf("/")); dir.includes("/"); dir = dir.slice(0, dir.lastIndexOf("/"))) {
			const manifest = `${dir}${m.extensions[0]}`;
			if (assets.has(manifest)) return manifest;
		}
	}
	return null;
}

/** A short name for an asset, as its section's tree shows it: `clearing`, `barrel`, `main.odin`. */
export function assetLabel(modules: ModuleInfo[], path: string): { name: string; module?: ModuleInfo } {
	const module = modules.find((m) => m.roots.some((r) => path.startsWith(`${r}/`)) && m.extensions.some((e) => path.endsWith(e)));
	const manifest = module?.extensions.every((e) => e.startsWith("/"));
	const file = manifest ? path.slice(0, path.lastIndexOf("/")) : path;
	let name = file.slice(file.lastIndexOf("/") + 1);
	if (module && !manifest && module.extensions.length === 1 && name.endsWith(module.extensions[0])) name = name.slice(0, -module.extensions[0].length);
	return { name, module };
}
