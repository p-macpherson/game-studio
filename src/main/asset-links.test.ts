import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { models3d } from "../modules/3d-models/info";
import { gameCode } from "../modules/game-code/info";
import { scenes } from "../modules/scenes/info";
import { sounds } from "../modules/sounds/info";
import { usersOf } from "../shared/asset-links";
import { assetLinks } from "./asset-links";
import { tempDir } from "./test-helpers";

it("links assets to what uses them, through prefabs and code, ignoring an asset's own files", () => {
	const root = tempDir();
	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	put("assets/models/props/barrel/model.json", '{"name": "props/barrel", "concept": "concepts/barrel-1.png"}');
	put("assets/models/rock/model.json", "{}");
	put("assets/sounds/step/sound.json", "{}");
	put("assets/sounds/step/render.json", '{"files": ["assets/sounds/step/step.ogg"]}');
	put("assets/prefabs/barrel.json", '{"entities": [{"Mesh_Renderer": {"mesh": "models/props/barrel/barrel.glb"}}]}');
	put("assets/scenes/clearing.json", '{"entities": [{"prefab": "prefabs/barrel.json"}, {"Audio_Source": {"clip": "sounds/step/step-2.ogg"}}]}');
	put("game/main.odin", 'engine.load_scene("scenes/clearing.json")');
	const assets = [
		"assets/models/props/barrel/model.json",
		"assets/models/rock/model.json",
		"assets/sounds/step/sound.json",
		"assets/prefabs/barrel.json",
		"assets/scenes/clearing.json",
		"game/main.odin",
	];
	const links = assetLinks(root, [models3d, sounds, scenes, gameCode], assets);
	expect(links).toEqual({
		"assets/models/props/barrel/model.json": ["assets/prefabs/barrel.json"],
		"assets/prefabs/barrel.json": ["assets/scenes/clearing.json"],
		"assets/sounds/step/sound.json": ["assets/scenes/clearing.json"],
		"assets/scenes/clearing.json": ["game/main.odin"],
	});
	expect([...usersOf(links, "assets/models/props/barrel/model.json")].sort()).toEqual(["assets/prefabs/barrel.json", "assets/scenes/clearing.json", "game/main.odin"]);
	expect(usersOf(links, "assets/models/rock/model.json").size).toBe(0); // not used anywhere
});
