import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatScene, parseScene } from "../shared/scene";
import { normalizeSceneFile } from "./scenes";
import { tempDir } from "./test-helpers";

const SCENE = { entities: [{ id: 1, Name: "Sun", Light: { kind: "Directional" } }, { id: 2, Name: "Path", Transform: { position: [0, 0.01, 0] }, Path: { points: [[0, 0, 0], [1, 0, 2]], width: 1.3 } }] };

describe("normalizeSceneFile", () => {
	it("puts a scene a script pretty-printed back to one entity per line, losing nothing", () => {
		const file = join(tempDir(), "clearing.json");
		writeFileSync(file, `${JSON.stringify(SCENE, null, 1)}\n`);
		expect(normalizeSceneFile(file)).toBe(true);
		const text = readFileSync(file, "utf8");
		expect(text).toBe(formatScene(parseScene(text).scene!));
		expect(text.split("\n").filter((l) => l.includes('"id":')).length).toBe(2);
		expect(parseScene(text).scene).toEqual(SCENE);
		expect(normalizeSceneFile(file)).toBe(false);
	});

	it("leaves a file with comments (which the layout can't keep) or errors alone", () => {
		const dir = tempDir();
		const commented = `{\n // the clearing\n "entities": [{"id": 1, "Name": "Sun"}]\n}\n`;
		writeFileSync(join(dir, "a.json"), commented);
		expect(normalizeSceneFile(join(dir, "a.json"))).toBe(false);
		expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(commented);
		writeFileSync(join(dir, "b.json"), "{ not json");
		expect(normalizeSceneFile(join(dir, "b.json"))).toBe(false);
	});
});
