import { describe, expect, it } from "vitest";
import { assetTree, type TreeNode, treeLeaves } from "./asset-tree";
import { type AssetSummary, type ModuleInfo, moduleOwns } from "./modules";

const module = (roots: string[], extensions: string[]): ModuleInfo => ({ id: "m", name: "M", icon: "", roots, extensions, agentType: "x", noun: "x" });
const asset = (path: string, change?: AssetSummary["change"]): AssetSummary => ({ path, title: path, excerpt: "", inMain: true, ...(change ? { change } : {}) });
/** The tree as indented text: folders end in "/", with their change counts. */
const show = (nodes: TreeNode[], depth = 0): string[] =>
	nodes.flatMap((n) =>
		n.kind === "leaf"
			? [`${"  ".repeat(depth)}${n.name}`]
			: [`${"  ".repeat(depth)}${n.name}/ ${n.changes.added}+${n.changes.modified}~${n.changes.deleted}-`, ...show(n.children, depth + 1)],
	);

describe("assetTree", () => {
	it("shows a folder-shaped asset named after its folder as one leaf, and leaves out excluded files", () => {
		const ui: ModuleInfo = { ...module(["assets/ui"], [".json"]), exclude: ["/candidates/"], folderAssets: ["assets/ui/art"] };
		const files = ["assets/ui/pause.json", "assets/ui/art/panel/panel.json", "assets/ui/art/icons/coin/coin.json", "assets/ui/art/panel/candidates/candidates.json"];
		const owned = files.filter((f) => moduleOwns(ui, f));
		expect(owned).toEqual(files.slice(0, 3));
		expect(show(assetTree(ui, owned.map((p) => asset(p))))).toEqual(["art/ 0+0~0-", "  icons/ 0+0~0-", "    coin", "  panel", "pause"]);
	});


	it("makes a folder-shaped asset one leaf, nests subfolders first, and rolls changes up", () => {
		const tree = assetTree(module(["assets/models"], ["/model.json"]), [
			asset("assets/models/rock/model.json"),
			asset("assets/models/props/crate/model.json", "added"),
			asset("assets/models/props/barrel/model.json", "modified"),
			asset("assets/models/props/small/cup/model.json", "added"),
		]);
		expect(show(tree)).toEqual(["props/ 2+1~0-", "  small/ 1+0~0-", "    cup", "  barrel", "  crate", "rock"]);
	});

	it("shows several roots as top-level folders in the section's order, and drops a lone extension", () => {
		const tree = assetTree(module(["assets/scenes", "assets/prefabs"], [".json"]), [
			asset("assets/prefabs/barrel.json"),
			asset("assets/scenes/clearing.json", "deleted"),
		]);
		expect(show(tree)).toEqual(["scenes/ 0+0~1-", "  clearing", "prefabs/ 0+0~0-", "  barrel"]);
		expect(treeLeaves(tree).map((l) => l.asset.path)).toEqual(["assets/scenes/clearing.json", "assets/prefabs/barrel.json"]);
	});

	it("keeps extensions when a section has several (code)", () => {
		const tree = assetTree(module(["game", "tests"], [".odin", ".jsonl"]), [asset("game/main.odin"), asset("game/ui/hud.odin"), asset("tests/smoke.jsonl")]);
		expect(show(tree)).toEqual(["game/ 0+0~0-", "  ui/ 0+0~0-", "    hud.odin", "  main.odin", "tests/ 0+0~0-", "  smoke.jsonl"]);
	});
});
