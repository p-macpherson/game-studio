import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { models3d } from "../modules/3d-models/info";
import { designDocs } from "../modules/design-docs/info";
import { scenes } from "../modules/scenes/info";
import { sounds } from "../modules/sounds/info";
import { textures } from "../modules/textures/info";
import { moveAsset } from "./asset-move";
import { tempDir } from "./test-helpers";

let root: string;
const put = (path: string, text: string) => {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), text);
};
const read = (path: string) => readFileSync(join(root, path), "utf8");
const has = (path: string) => existsSync(join(root, path));

beforeEach(() => {
	root = tempDir();
	put("assets/models/barrel/model.json", '{\n\t"name": "barrel",\n\t"concept": "concepts/barrel-1.png"\n}\n');
	put("assets/models/barrel/barrel.glb", "glb");
	put("assets/models/barrel/concepts/barrel-1.png", "png");
	put("assets/models/rock/model.json", '{"name": "rock"}');
	put("assets/sounds/step/sound.json", '{"variants": []}');
	put("assets/sounds/step/step.ogg", "a");
	put("assets/sounds/step/step-2.ogg", "b");
	put("assets/sounds/step/takes/main-1.wav", "w");
	put("assets/sounds/step/render.json", '{"files": ["step.ogg", "step-2.ogg"]}');
	put("assets/prefabs/barrel.json", '{"entities": [{"id": 1, "Mesh_Renderer": {"mesh": "models/barrel/barrel.glb"}}]}');
	put("assets/scenes/main.json", '{"entities": [{"id": 1, "prefab": "prefabs/barrel.json"}, {"id": 2, "Audio_Source": {"clip": "sounds/step/step.ogg"}}]}');
	put("game/main.odin", 'play("sounds/step/step-2.ogg"); load("scenes/main.json"); x := "models/rock/rock.glb"');
	put("docs/design/Overview.md", "# Game\n\nSee [combat](Combat.md#rules) and [art](art/Style.md).\n");
	put("docs/design/Combat.md", "# Combat\n\nBack to [the overview](Overview.md).\n");
	put("docs/design/art/Style.md", "# Style\n");
});

describe("moveAsset", () => {
	it("moves and renames a model: its folder, its own files, its manifest's name, and the references to it", () => {
		const r = moveAsset(root, models3d, "assets/models/barrel/model.json", "assets/models/props/cask/model.json");
		expect(r).toMatchObject({ to: "assets/models/props/cask/model.json", files: 3, code: false });
		expect(has("assets/models/barrel")).toBe(false);
		expect(read("assets/models/props/cask/cask.glb")).toBe("glb");
		expect(has("assets/models/props/cask/concepts/barrel-1.png")).toBe(true); // concepts keep their names
		expect(JSON.parse(read("assets/models/props/cask/model.json"))).toEqual({ name: "props/cask", concept: "concepts/barrel-1.png" });
		expect(read("assets/prefabs/barrel.json")).toContain('"mesh": "models/props/cask/cask.glb"');
		expect(r.updated).toEqual(["assets/models/props/cask/model.json", "assets/prefabs/barrel.json"]);
	});

	it("renames a sound's variants and its render record, and updates scenes and game code", () => {
		const r = moveAsset(root, sounds, "assets/sounds/step/sound.json", "assets/sounds/footstep/sound.json");
		expect(has("assets/sounds/footstep/footstep-2.ogg") && has("assets/sounds/footstep/takes/main-1.wav")).toBe(true);
		expect(JSON.parse(read("assets/sounds/footstep/render.json")).files).toEqual(["footstep.ogg", "footstep-2.ogg"]);
		expect(read("assets/scenes/main.json")).toContain('"clip": "sounds/footstep/footstep.ogg"');
		expect(read("game/main.odin")).toContain('play("sounds/footstep/footstep-2.ogg")');
		expect(r.code).toBe(true);
	});

	it("moves a folder of assets, keeping their names", () => {
		moveAsset(root, models3d, "assets/models/barrel/model.json", "assets/models/props/barrel/model.json");
		moveAsset(root, models3d, "assets/models/props", "assets/models/scenery");
		expect(read("assets/prefabs/barrel.json")).toContain('"models/scenery/barrel/barrel.glb"');
		expect(JSON.parse(read("assets/models/scenery/barrel/model.json")).name).toBe("scenery/barrel");
		expect(has("assets/models/props")).toBe(false);
	});

	it("moves a prefab and updates the scenes placing it", () => {
		moveAsset(root, scenes, "assets/prefabs/barrel.json", "assets/prefabs/props/barrel.json");
		expect(read("assets/scenes/main.json")).toContain('"prefab": "prefabs/props/barrel.json"');
	});

	it("relinks markdown both ways: links to the moved doc, and the moved doc's own links", () => {
		moveAsset(root, designDocs, "docs/design/Combat.md", "docs/design/rules/Fighting.md");
		expect(read("docs/design/Overview.md")).toContain("[combat](rules/Fighting.md#rules) and [art](art/Style.md)");
		expect(read("docs/design/rules/Fighting.md")).toContain("[the overview](../Overview.md)");
	});

	it("renames a texture's maps with it (grass_normal.png), not its candidates, and updates the scenes using them", () => {
		put("assets/textures/grass/texture.json", '{"tile": 2, "source": "candidates/grass-1-quilt.png"}');
		for (const f of ["grass.png", "grass_normal.png", "grass_roughness.png", "candidates/grass-1-quilt.png"]) put(`assets/textures/grass/${f}`, "png");
		put("assets/scenes/field.json", '{"entities": [{"id": 1, "Mesh_Renderer": {"mesh": "plane", "material": {"texture": "textures/grass/grass.png", "normal_map": "textures/grass/grass_normal.png"}}}]}');
		moveAsset(root, textures, "assets/textures/grass/texture.json", "assets/textures/ground/turf/texture.json");
		expect(["turf.png", "turf_normal.png", "turf_roughness.png", "candidates/grass-1-quilt.png"].every((f) => has(`assets/textures/ground/turf/${f}`))).toBe(true);
		expect(JSON.parse(read("assets/textures/ground/turf/texture.json")).source).toBe("candidates/grass-1-quilt.png");
		expect(read("assets/scenes/field.json")).toContain('"normal_map": "textures/ground/turf/turf_normal.png"');
	});

	it("refuses, changing nothing: a taken name, an asset inside another, leaving the root, a new extension", () => {
		const m = (from: string, to: string, info = models3d) => () => moveAsset(root, info, from, to);
		expect(m("assets/models/barrel/model.json", "assets/models/rock/model.json")).toThrow(/already exists/);
		expect(m("assets/models/barrel/model.json", "assets/models/rock/barrel/model.json")).toThrow(/can't go inside/);
		expect(m("assets/models/barrel/model.json", "assets/sounds/barrel/model.json")).toThrow(/stay in assets\/models/);
		expect(m("assets/models/barrel/model.json", "assets/models/Big Barrel/model.json")).toThrow(/lower-kebab-case/);
		expect(m("docs/design/Combat.md", "docs/design/Combat.txt", designDocs)).toThrow(/Keep the .md/);
		expect(has("assets/models/barrel/barrel.glb")).toBe(true);
	});
});
