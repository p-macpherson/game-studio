// A section's assets as a file-explorer tree: the project's folders, with each asset a leaf. A folder-shaped asset
// (assets/models/barrel/model.json) is one leaf named after its folder; its insides belong to the asset's view.
import type { AssetSummary, ModuleInfo } from "./modules";

export interface ChangeCounts {
	added: number;
	modified: number;
	deleted: number;
}
export interface TreeFolder {
	kind: "folder";
	/** Repo-relative path of the folder. */
	key: string;
	name: string;
	children: TreeNode[];
	/** What the selected worktree changed inside it. */
	changes: ChangeCounts;
}
export interface TreeLeaf {
	kind: "leaf";
	key: string;
	/** The file (or asset folder) name, without the extension when the section has only one. */
	name: string;
	asset: AssetSummary;
}
export type TreeNode = TreeFolder | TreeLeaf;

/**
 * The tree of a section's assets. With one root its contents are the top level; with several (Scenes: scenes and
 * prefabs) each root is a top-level folder, in the section's order. Elsewhere folders come first, then leaves, by name.
 */
export function assetTree(info: ModuleInfo, assets: AssetSummary[]): TreeNode[] {
	const manifest = info.extensions.every((e) => e.startsWith("/"));
	const top: TreeFolder = folder("", "");
	// Several roots: a top-level folder each, in the section's order (empty ones dropped at the end).
	const roots = new Map(info.roots.length > 1 ? info.roots.map((r) => [r, folder(r, r.split("/").pop()!)] as const) : []);
	top.children.push(...roots.values());
	for (const asset of assets) {
		const root = info.roots.find((r) => asset.path.startsWith(`${r}/`));
		if (!root) continue;
		const segments = asset.path.slice(root.length + 1).split("/");
		if (manifest) segments.pop();
		let at = top;
		let key = root;
		if (roots.size) at = roots.get(root)!;
		for (const name of segments.slice(0, -1)) {
			key = `${key}/${name}`;
			let next = at.children.find((c): c is TreeFolder => c.kind === "folder" && c.key === key);
			if (!next) at.children.push((next = folder(key, name)));
			at = next;
		}
		const file = segments.at(-1) ?? "";
		const name = !manifest && info.extensions.length === 1 && file.toLowerCase().endsWith(info.extensions[0]) ? file.slice(0, -info.extensions[0].length) : file;
		at.children.push({ kind: "leaf", key: asset.path, name, asset });
	}
	const finish = (f: TreeFolder, sort: boolean) => {
		if (sort) f.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "folder" ? -1 : 1));
		for (const c of f.children) {
			if (c.kind === "folder") finish(c, true);
			const counts = c.kind === "folder" ? c.changes : count(c.asset.change);
			f.changes.added += counts.added;
			f.changes.modified += counts.modified;
			f.changes.deleted += counts.deleted;
		}
	};
	// Several roots keep the section's order (Scenes before Prefabs).
	finish(top, info.roots.length === 1);
	return top.children.filter((c) => c.kind === "leaf" || c.children.length > 0);
}

/** Every leaf, in the order the tree shows them. */
export function treeLeaves(nodes: TreeNode[]): TreeLeaf[] {
	return nodes.flatMap((n) => (n.kind === "leaf" ? [n] : treeLeaves(n.children)));
}

function folder(key: string, name: string): TreeFolder {
	return { kind: "folder", key, name, children: [], changes: { added: 0, modified: 0, deleted: 0 } };
}
function count(change: AssetSummary["change"]): ChangeCounts {
	return { added: change === "added" ? 1 : 0, modified: change === "modified" ? 1 : 0, deleted: change === "deleted" ? 1 : 0 };
}
