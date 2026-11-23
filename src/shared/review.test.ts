import { describe, expect, it } from "vitest";
import type { AssetSummary, ModuleInfo } from "./modules";
import { groupChanges, reviewMessages } from "./review";

const mod = (id: string, roots: string[], extensions: string[]): ModuleInfo => ({ id, name: id, icon: "x", roots, extensions }) as unknown as ModuleInfo;
const modules = [mod("game-code", ["game"], [".odin"]), mod("3d-models", ["assets/models"], ["/model.json"]), mod("scenes", ["assets/scenes"], [".json"])];
const asset = (path: string, change?: AssetSummary["change"]): AssetSummary => ({ path, title: "", excerpt: "", inMain: change !== "added", ...(change ? { change } : {}) });
const listed = [
	{ module: modules[0], asset: asset("game/main.odin", "modified") },
	{ module: modules[1], asset: asset("assets/models/cave/rock/model.json") },
	{ module: modules[1], asset: asset("assets/models/barrel/model.json", "added") },
	{ module: modules[2], asset: asset("assets/scenes/main.json", "deleted") },
];

describe("review", () => {
	it("groups changed files under the assets that own them; code and stray files are read as a diff", () => {
		const { items, code } = groupChanges(modules, listed, [
			{ path: "game/main.odin", change: "modified" },
			{ path: "assets/models/cave/rock/rock.glb", change: "modified" },
			{ path: "assets/models/cave/rock/thumbnail.png", change: "modified" },
			{ path: "assets/models/barrel/model.json", change: "added" },
			{ path: "assets/scenes/main.json", change: "deleted" },
			{ path: "README.md", change: "modified" },
			{ path: ".studio/sessions/x/session.json", change: "added" },
		]);
		expect(code.map((f) => f.path)).toEqual(["game/main.odin", "README.md"]);
		expect(items.map((i) => [i.path, i.change, i.files.length])).toEqual([
			["assets/models/barrel/model.json", "added", 1],
			// Its manifest didn't change, but its files did.
			["assets/models/cave/rock/model.json", "modified", 2],
			["assets/scenes/main.json", "deleted", 1],
		]);
		expect(items[1].name).toBe("rock");
	});

	it("writes one message per session with the notes, and nothing when all is fine", () => {
		const { items } = groupChanges(modules, listed, [
			{ path: "assets/models/cave/rock/rock.glb", change: "modified" },
			{ path: "assets/models/barrel/model.json", change: "added" },
			{ path: "assets/scenes/main.json", change: "deleted" },
		]);
		items[0].sessionId = "modeller";
		const fine = Object.fromEntries(items.map((i) => [i.path, { verdict: "fine" as const }]));
		expect(reviewMessages(items, fine, "lead")).toEqual([]);
		const sent = reviewMessages(items, { ...fine, [items[0].path]: { verdict: "redo", note: "too clean, add wear" }, [items[2].path]: { verdict: "redo" } }, "lead", "Good start.");
		expect(sent.map((m) => m.sessionId)).toEqual(["modeller", "lead"]);
		expect(sent[0].text).toContain("- 3d-models: barrel (assets/models/barrel/model.json): too clean, add wear");
		expect(sent[0].text).not.toContain("Good start.");
		expect(sent[1].text).toContain("Good start.");
		expect(sent[1].text).toContain("- scenes: main (assets/scenes/main.json)");
		expect(sent[1].text).toContain("These are fine as they are, leave them: rock.");
		// A general note alone still reaches the lead.
		expect(reviewMessages(items, fine, "lead", "Lovely.")).toHaveLength(1);
	});
});
