/** The module contract: one studio section per part of the game. See the vault note "Modules". */

export interface ModuleInfo {
	id: string;
	name: string;
	icon: string;
	/** Folders in the project (repo-relative) holding this module's assets. */
	roots: string[];
	extensions: string[];
	/** Agent type used for "modify" and "new" sessions. */
	agentType: string;
	/** Singular noun for UI text, e.g. "doc". */
	noun: string;
}

/** True if `path` (repo-relative) is one of this module's assets. */
export function moduleOwns(info: ModuleInfo, path: string): boolean {
	return info.roots.some((r) => path.startsWith(`${r}/`)) && info.extensions.some((e) => path.toLowerCase().endsWith(e));
}

export interface AssetSummary {
	path: string;
	title: string;
	excerpt: string;
	/** Exists in the project's main checkout. */
	inMain: boolean;
	updatedAt?: string;
	/** In a worktree: it added, changed or removed this asset (not in the game until the worktree is merged). */
	change?: "added" | "modified" | "deleted";
}

/** What moving or renaming an asset (or a folder of them) did. */
export interface MoveResult {
	/** Where it is now (an asset's path, or a folder). */
	to: string;
	/** How many files moved. */
	files: number;
	/** Files whose references to what moved were rewritten. */
	updated: string[];
	/** Game code or tests moved or changed: build and test before merging. */
	code: boolean;
}

export interface AssetSearchHit {
	path: string;
	line: number;
	text: string;
}
