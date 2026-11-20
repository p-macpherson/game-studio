// Finds which assets use which in a checkout: every quoted path in the game's data, code and tests (as the engine
// loads them, from assets/, or from the repo root), resolved to the asset that owns it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AssetLinks, ownerOf } from "../shared/asset-links";
import type { ModuleInfo } from "../shared/modules";
import { walk } from "./assets";

/** Files that can refer to assets: scenes, prefabs and manifests; game code; tests. */
const SOURCES = [/^assets\/.*\.json$/, /^game\/.*\.(odin|json|jsonl)$/, /^tests\/.*\.(jsonl|json|odin)$/];

/** For every asset in `assets` (paths, as the sections list them), what refers to it; an asset's own files don't count. */
export function assetLinks(root: string, modules: ModuleInfo[], assets: string[]): AssetLinks {
	const known = new Set(assets);
	const links: Record<string, Set<string>> = {};
	const files = ["assets", "game", "tests"].flatMap((d) => walk(join(root, d), root)).filter((p) => SOURCES.some((r) => r.test(p)));
	for (const file of files) {
		const user = ownerOf(modules, known, file);
		if (!user) continue;
		const text = readFileSync(join(root, file), "utf8");
		for (const [, s] of text.matchAll(/"([^"\n]+\/[^"\n]+)"/g)) {
			const used = ownerOf(modules, known, s.startsWith("assets/") || s.startsWith("game/") || s.startsWith("tests/") ? s : `assets/${s}`);
			if (used && used !== user) (links[used] ??= new Set()).add(user);
		}
	}
	return Object.fromEntries(Object.entries(links).map(([k, v]) => [k, [...v].sort()]));
}
