import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { EditHistory } from "./edit-history";
import { tempDir } from "./test-helpers";

let root: string;
let history: EditHistory;
const put = (path: string, text: string) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
};
const read = (path: string) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null);
const edit = (label: string, scopes: string[], change: () => void) => history.record("w", root, label, scopes.map((path) => ({ path })), async () => change());

beforeEach(() => {
	root = tempDir();
	history = new EditHistory(join(tempDir(), "store"));
	put("assets/scenes/main.json", "v1");
	put("assets/sounds/step/sound.json", "s1");
	put("assets/sounds/step/step.ogg", "ogg1");
});

it("undoes and redoes steps, multi-file ones included, and a new edit drops what was undone", async () => {
	await edit("Moved Cube", ["assets/scenes/main.json"], () => put("assets/scenes/main.json", "v2"));
	await edit("Rendered step", ["assets/sounds/step"], () => {
		put("assets/sounds/step/sound.json", "s2");
		put("assets/sounds/step/step-2.ogg", "ogg2");
	});
	await edit("Nothing changed", ["assets/scenes/main.json"], () => {});
	expect(history.steps("w").map((s) => [s.label, s.done, s.files])).toEqual([
		["Moved Cube", true, ["assets/scenes/main.json"]],
		["Rendered step", true, ["assets/sounds/step/sound.json", "assets/sounds/step/step-2.ogg"]],
	]);

	expect(history.undo("w", root)).toBe("Rendered step");
	expect([read("assets/sounds/step/sound.json"), read("assets/sounds/step/step-2.ogg")]).toEqual(["s1", null]);
	expect(history.undo("w", root)).toBe("Moved Cube");
	expect(read("assets/scenes/main.json")).toBe("v1");
	expect(() => history.undo("w", root)).toThrow(/Nothing to undo/);
	expect(history.redo("w", root)).toBe("Moved Cube");
	expect(read("assets/scenes/main.json")).toBe("v2");

	await edit("Moved Cube again", ["assets/scenes/main.json"], () => put("assets/scenes/main.json", "v3"));
	expect(history.steps("w").map((s) => s.label)).toEqual(["Moved Cube", "Moved Cube again"]); // "Rendered step" can't be redone now
	expect(() => history.redo("w", root)).toThrow(/Nothing to redo/);
});

it("undoes a move (files gone and new) and refuses to undo over a later change by someone else", async () => {
	await edit("Renamed step", ["assets/sounds/step", "assets/sounds/footstep"], () => {
		mkdirSync(join(root, "assets/sounds/footstep"), { recursive: true });
		renameSync(join(root, "assets/sounds/step/sound.json"), join(root, "assets/sounds/footstep/sound.json"));
	});
	put("assets/sounds/footstep/sound.json", "an agent's edit");
	expect(() => history.undo("w", root)).toThrow(/Can't undo "Renamed step": assets\/sounds\/footstep\/sound.json changed since/);
	expect(read("assets/sounds/footstep/sound.json")).toBe("an agent's edit"); // untouched

	put("assets/sounds/footstep/sound.json", "s1"); // back as the step left it
	history.undo("w", root);
	expect([read("assets/sounds/step/sound.json"), read("assets/sounds/footstep/sound.json")]).toEqual(["s1", null]);
});

it("keeps timelines per worktree, and forgets one when cleared", async () => {
	await edit("Moved Cube", ["assets/scenes/main.json"], () => put("assets/scenes/main.json", "v2"));
	expect(history.steps("other")).toEqual([]);
	history.clear("w");
	expect(history.steps("w")).toEqual([]);
});
