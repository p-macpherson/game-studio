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
	/** In a worktree: it added or changed this asset (not in the game until the worktree is merged). */
	change?: "added" | "modified";
}

export interface AssetSearchHit {
	path: string;
	line: number;
	text: string;
}
