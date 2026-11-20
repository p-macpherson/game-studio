import { describe, expect, it } from "vitest";
import { prefabIndex } from "./info";

describe("prefabIndex", () => {
	it("finds each prefab's model and every scene or prefab that places it, with counts", () => {
		const scene = (entities: object[]) => JSON.stringify({ entities });
		const index = prefabIndex([
			{ path: "assets/prefabs/barrel.json", text: scene([{ id: 1, Transform: {}, Mesh_Renderer: { mesh: "models/barrel/barrel.glb" } }]) },
			{ path: "assets/prefabs/camp.json", text: scene([{ id: 1, prefab: "prefabs/barrel.json" }]) },
			{ path: "assets/prefabs/lonely.json", text: scene([{ id: 1, Transform: {}, Mesh_Renderer: { mesh: "cube" } }]) },
			{
				path: "assets/scenes/clearing.json",
				text: scene([
					{ id: 1, prefab: "prefabs/barrel.json" },
					{ id: 2, prefab: "prefabs/barrel.json" },
					{ id: 3, prefab: "prefabs/camp.json" },
				]),
			},
		]);
		expect(index.get("assets/prefabs/barrel.json")).toEqual({
			model: "assets/models/barrel/barrel.glb",
			usedIn: [
				{ name: "camp (prefab)", count: 1 },
				{ name: "clearing", count: 2 },
			],
		});
		expect(index.get("assets/prefabs/camp.json")).toEqual({ usedIn: [{ name: "clearing", count: 1 }] });
		expect(index.get("assets/prefabs/lonely.json")).toEqual({ usedIn: [] }); // a builtin mesh: no model thumbnail
	});
});
