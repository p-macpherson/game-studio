import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GenService } from "./gen";
import { tempDir } from "./test-helpers";
import { editScreen, readScreen, UiArtPipeline } from "./ui";

let services: GenService[] = [];
const fakeGen = () => {
	const gen = new GenService({ root: tempDir(), codeDir: resolve("gen"), emit: () => {}, fake: true });
	services.push(gen);
	return gen;
};
afterEach(async () => {
	await Promise.all(services.map((s) => s.dispose()));
	services = [];
});
const json = (cwd: string, path: string) => JSON.parse(readFileSync(join(cwd, path), "utf8"));

describe("UI art", () => {
	it("generates cut-out candidates, then makes the piece with the slice the engine reads beside it", async () => {
		const cwd = tempDir();
		const art = new UiArtPipeline(fakeGen());
		const r = await art.candidates({ cwd }, { name: "frames/panel", kind: "frame", prompt: "a carved wooden border", style: "hand-painted", count: 2, seed: 5 });
		expect(r.candidates.map((c) => c.source)).toEqual(["candidates/panel-5.png", "candidates/panel-6.png"]);
		expect(r.sheet).toMatch(/^data:image\/png;base64,/);
		expect(json(cwd, "assets/ui/art/frames/panel/panel.json")).toEqual({ kind: "frame", prompt: "a carved wooden border" });
		expect(art.candidateRecords(cwd, "frames/panel")["panel-6.png"]).toMatchObject({ seed: 6, style: "hand-painted", slice: [10, 10, 10, 10] });

		const made = await art.make({ cwd }, { name: "frames/panel", source: "candidates/panel-6.png" });
		expect(made).toMatchObject({ file: "ui/art/frames/panel/panel.png", slice: [10, 10, 10, 10] });
		expect(existsSync(join(cwd, "assets", made.file))).toBe(true);
		// The asset file is also the frame's sidecar: the engine reads its slice (screens.odin frame_of).
		expect(json(cwd, "assets/ui/art/frames/panel/panel.json")).toMatchObject({ kind: "frame", source: "candidates/panel-6.png", slice: [10, 10, 10, 10] });
		const fixed = await art.make({ cwd }, { name: "frames/panel", slice: [40, 30, 40, 30] });
		expect(fixed.slice).toEqual([40, 30, 40, 30]);
		// Choosing another candidate takes its own insets, not the old piece's.
		const other = await art.make({ cwd }, { name: "frames/panel", source: "candidates/panel-5.png" });
		expect(other.slice).toEqual([10, 10, 10, 10]);
		await expect(art.candidates({ cwd }, { name: "frames/panel", kind: "icon", prompt: "x" })).rejects.toThrow(/is a frame, not a icon/);
		await expect(art.make({ cwd }, { name: "nothing-yet" })).rejects.toThrow(/generate candidates first/);
	});
});

describe("screens", () => {
	it("edits a screen by id, creating it on request, and reports its problems", () => {
		const cwd = tempDir();
		expect(() => editScreen(cwd, { screen: "pause", edits: [] })).toThrow(/create: true/);
		const r = editScreen(cwd, {
			screen: "pause",
			create: true,
			edits: [
				{ op: "screen", fields: { pauses: true } },
				{ op: "add", element: { id: "box", type: "panel", frame: "ui/art/panel/panel.png", size: [380, 430] } },
				{ op: "add", parent: "box", element: { id: "resume", type: "button", text: "Resume", action: "resume" } },
			],
		});
		expect(r.problems).toEqual(["elements.box.frame: No assets/ui/art/panel/panel.png"]);
		expect(readFileSync(join(cwd, "assets/ui/pause.json"), "utf8")).toContain('"size": [380, 430]');
		expect(readScreen(cwd, "pause").screen?.elements[0].children?.[0].id).toBe("resume");
		expect(() => editScreen(cwd, { screen: "art/panel", edits: [], create: true })).toThrow(/holds UI art/);
	});
});
