import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	addEntity,
	deleteEntity,
	duplicateEntity,
	effectiveComponents,
	eulerToQuat,
	formatScene,
	parseScene,
	quatToEuler,
	setComponent,
	validateScene,
	type ComponentSchema,
	type SceneFile,
} from "./scene";

const schemas = JSON.parse(readFileSync(new URL("./fixtures/demo-components.json", import.meta.url), "utf8")) as ComponentSchema[];

// Goblin Gold's clearing as it was hand-written (JSON5 comments), shortened.
const CLEARING = `{
  // Goblin Gold's clearing
  "environment": {"sky_zenith": [0.25, 0.45, 0.75], "fog_density": 0.02},
  "entities": [
    {"id": 1, "Name": "Sun", "Transform": {"rotation": [50, 30, 0]}, "Light": {"kind": "Directional", "intensity": 1.3, "shadows": true}},

    {"id": 10, "prefab": "prefabs/goblin.json", "Transform": {"position": [0, 0, 0]}},
    {"id": 20, "prefab": "prefabs/chest.json", "Name": "Chest 1", "Transform": {"position": [4, 0, 6], "rotation": [0, 210, 0]}},
    {"id": 30, "Name": "Post", "Transform": {"position": [1, 0, 1]}, "Mesh_Renderer": {"mesh": "cube"}},
    {"id": 31, "Name": "Post Lamp", "Transform": {"position": [0, 2, 0], "parent": 30}, "Light": {"range": 4}},
  ]
}`;

function load(text = CLEARING): SceneFile {
	const { scene, errors } = parseScene(text);
	expect(errors).toEqual([]);
	return scene!;
}

describe("scene files", () => {
	it("reads JSON5 comments and writes plain JSON that reads back the same", () => {
		const scene = load();
		const text = formatScene(scene);
		expect(text).not.toContain("//");
		expect(JSON.parse(text)).toEqual(scene);
		expect(text.split("\n").filter((l) => l.includes('"id":'))).toHaveLength(5);
		expect(text).toContain(`    {"id": 20, "prefab": "prefabs/chest.json", "Name": "Chest 1", "Transform": {"position": [4, 0, 6], "rotation": [0, 210, 0]}},`);
	});

	it("round-trips demo-game's real scene and prefabs", () => {
		for (const path of ["scenes/clearing.json", "prefabs/chest.json", "prefabs/goblin.json"]) {
			let text: string;
			try {
				text = readFileSync(new URL(`../../../demo-game/assets/${path}`, import.meta.url), "utf8");
			} catch {
				continue;
			}
			const scene = load(text);
			expect(JSON.parse(formatScene(scene))).toEqual(scene);
			expect(validateScene(scene, { schemas })).toEqual([]);
		}
	});

	it("an edit changes only its entity's line", () => {
		const scene = load();
		const before = formatScene(scene).split("\n");
		const after = formatScene(setComponent(scene, 20, "Transform", { position: [5, 0, 6.5] })).split("\n");
		const changed = after.filter((l, i) => l !== before[i]);
		expect(changed).toEqual([`    {"id": 20, "prefab": "prefabs/chest.json", "Name": "Chest 1", "Transform": {"position": [5, 0, 6.5], "rotation": [0, 210, 0]}},`]);
	});

	it("keeps prefab references and lets null fall back to the prefab", () => {
		let scene = setComponent(load(), 10, "Transform", { position: [2, 0, 3] });
		expect(scene.entities[1]).toEqual({ id: 10, prefab: "prefabs/goblin.json", Transform: { position: [2, 0, 3] } });
		scene = setComponent(scene, 20, "Transform", { rotation: null });
		expect(scene.entities[2].Transform).toEqual({ position: [4, 0, 6] });
		const eff = effectiveComponents({ id: 5, prefab: "p", Transform: { position: [1, 0, 0] }, Chest: { gold: 25 } }, {
			id: 1,
			Name: "Chest",
			Transform: {},
			Chest: { gold: 10 },
		});
		expect(eff.Chest.value).toEqual({ gold: 25 });
		expect(eff.Chest.fromPrefab).toEqual({ gold: 10 });
		expect(eff.Name.value).toBe("Chest");
	});

	it("deletes children with their parent, and duplicates them with new ids", () => {
		const scene = load();
		expect(deleteEntity(scene, 30).deleted).toEqual([30, 31]);
		const dup = duplicateEntity(scene, 30, [9, 0, 9]);
		expect(dup.id).toBe(32);
		expect(dup.scene.entities.slice(-2)).toEqual([
			{ id: 32, Name: "Post", Transform: { position: [9, 0, 9] }, Mesh_Renderer: { mesh: "cube" } },
			{ id: 33, Name: "Post Lamp", Transform: { position: [0, 2, 0], parent: 32 }, Light: { range: 4 } },
		]);
		expect(addEntity(scene, { prefab: "prefabs/rock.json" }).id).toBe(32);
	});

	it("reports what the engine would warn about", () => {
		let scene = setComponent(load(), 20, "Transfrom", { position: [0, 0, 0] });
		scene = setComponent(scene, 30, "Light", { kind: "Torch", rang: 3 });
		scene = setComponent(scene, 31, "Transform", { parent: 99, position: [1, 2] });
		expect(validateScene(scene, { schemas, prefabs: ["prefabs/goblin.json"] })).toEqual([
			"entity 20 (Chest 1): prefab prefabs/chest.json not found",
			"entity 20 (Chest 1): unknown component Transfrom",
			"entity 30 (Post): Light.kind must be one of Point, Directional, Spot",
			"entity 30 (Post): Light has no field rang",
			"entity 31 (Post Lamp): Transform.position must be 3 numbers",
			"entity 31 (Post Lamp): Transform.parent refers to unknown id 99",
		]);
		expect(parseScene('{"entities": [{"id": 0}]}').errors).toEqual(['entities[0]: "id" must be a positive whole number']);
	});

	it("converts rotations like the engine", () => {
		const q = eulerToQuat([20, 210, -10]);
		expect(quatToEuler(q)).toEqual([20, -150, -10]);
		// yaw 90 turns +Z forward to +X
		const [x, y, z, w] = eulerToQuat([0, 90, 0]);
		expect([x, y, z, w].map((n) => Math.round(n * 1000) / 1000)).toEqual([0, 0.707, 0, 0.707]);
	});
});

describe("lenient parsing", () => {
	it("drops trailing commas and comments, but never touches text inside strings", () => {
		const text = '{ "entities": [ {"id": 1, "notes": "a, b,] and {c,}", "Name": "Gate", }, // the last one\n ], }';
		const { scene, errors } = parseScene(text);
		expect(errors).toEqual([]);
		expect(scene?.entities[0].notes).toBe("a, b,] and {c,}");
	});

	it("checks entity references in arrays too", () => {
		const { scene } = parseScene('{"entities": [{"id": 1, "Squad": {"members": [1, 7, 0]}}]}');
		const schemas = [{ name: "Squad", flags: [], fields: [{ name: "members", type: "[3]Entity" }] }];
		expect(validateScene(scene!, { schemas })).toEqual(["entity 1 (#1): Squad.members refers to unknown id 7"]);
	});
});
