import { describe, expect, it } from "vitest";
import { MODULES } from "../main/assets";
import type { AssetSummary } from "./modules";
import { type Listed, type TranscriptMessage, pathFinder, sessionAssets, touches } from "./session-assets";

const modules = MODULES.map((m) => m.info);
const mod = (id: string) => modules.find((m) => m.id === id)!;
const asset = (id: string, path: string, change?: AssetSummary["change"]): Listed => ({ module: mod(id), asset: { path, title: path, excerpt: "", inMain: change !== "added", ...(change ? { change } : {}) } });

let n = 0;
const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
const said = (text: string): TranscriptMessage => ({ role: "assistant", content: [{ type: "text", text }] });
function call(name: string, args: Record<string, unknown>, result = "ok", isError = false): TranscriptMessage[] {
	const id = `c${++n}`;
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
		{ role: "toolResult", toolCallId: id, content: [{ type: "text", text: result }], isError },
	];
}

const build = (messages: TranscriptMessage[], listed: Listed[], checkout: string | null = "w1") =>
	sessionAssets({
		messages,
		modules,
		listed,
		checkout,
		previewOf: (path, m) => (m.id === "3d-models" ? { kind: "image", path: path.replace("model.json", "thumbnail.png") } : m.id === "sounds" ? { kind: "audio", path: path.replace("sound.json", "thud.ogg") } : undefined),
		isFile: (p) => p === "build/shot.png",
	});

describe("pathFinder", () => {
	const find = pathFinder(modules);
	it("finds paths under the sections' folders, in prose and inside absolute paths", () => {
		expect(find("I wrote assets/models/barrel/model.json and game/main.odin.")).toEqual(["assets/models/barrel/model.json", "game/main.odin"]);
		expect(find("/home/x/worktrees/g/20261122/assets/scenes/yard.json")).toEqual(["assets/scenes/yard.json"]);
		expect(find("see docs/design/Art Style.md for the palette")).toEqual(["docs/design/Art Style.md", "docs/design/Art"]);
		expect(find("the folder assets/models/barrel/ holds it")).toEqual(["assets/models/barrel"]);
		expect(find("myassets/models/x.json and endgame/main.odin")).toEqual([]);
	});
});

describe("touches", () => {
	it("takes what writing tools name, by turn, and nothing from tools that only look or failed", () => {
		const turns = touches(
			[
				user("make a barrel"),
				...call("read", { path: "assets/scenes/yard.json" }),
				...call("bash", { command: "cat game/main.odin" }),
				...call("write", { path: "game/extra.odin", content: 'load("assets/scenes/yard.json")' }),
				...call("generate_model", { name: "barrel" }, "Made assets/models/barrel/barrel.glb"),
				...call("edit", { path: "game/broken.odin" }, "no such text", true),
				user("and a sound"),
				...call("generate_sound_takes", { name: "thud", prompt: "a heavy thud" }),
				...call("open_in_studio", { path: "./assets/sounds/thud/sound.json" }),
			],
			modules,
		);
		expect(turns[0]).toEqual([]);
		expect(turns[1].map((t) => t.path)).toEqual(["game/extra.odin", "assets/models/barrel/barrel.glb", "barrel"]);
		expect(turns[1][2].sections).toEqual(["3d-models"]);
		expect(turns[2]).toEqual([
			{ path: "thud", source: "tool", sections: ["sounds"] },
			{ path: "assets/sounds/thud/sound.json", source: "shown" },
		]);
	});
});

describe("sessionAssets", () => {
	const listed = [
		asset("3d-models", "assets/models/barrel/model.json", "added"),
		asset("3d-models", "assets/models/props/crate/model.json"),
		asset("sounds", "assets/sounds/thud/sound.json", "modified"),
		asset("scenes", "assets/scenes/yard.json"),
		asset("scenes", "assets/scenes/old.json", "deleted"),
		asset("game-code", "game/main.odin", "modified"),
		asset("ui", "assets/ui/art/frame/frame.json", "added"),
		asset("design-docs", "docs/design/Art Style.md"),
	];

	it("gives each turn a card per asset it changed, with its section, change and preview", () => {
		const { turns } = build(
			[
				user("make a barrel"),
				...call("generate_model", { name: "barrel" }, "Made assets/models/barrel/barrel.glb"),
				...call("write", { path: "game/main.odin", content: "" }),
				said("Done."),
				user("tidy up"),
				...call("delete_asset", { path: "assets/scenes/old.json" }),
				...call("make_ui_art", { name: "frame" }, "Wrote assets/ui/art/frame/frame.png"),
			],
			listed,
		);
		expect(turns[1]).toEqual([
			{ path: "assets/models/barrel/model.json", name: "barrel", module: { id: "3d-models", name: mod("3d-models").name, icon: "🧊" }, checkout: "w1", change: "added", preview: { kind: "image", path: "assets/models/barrel/thumbnail.png" } },
			expect.objectContaining({ path: "game/main.odin", name: "main.odin", change: "modified" }),
		]);
		expect(turns[2].map((c) => [c.path, c.name, c.change])).toEqual([
			["assets/scenes/old.json", "old", "deleted"],
			["assets/ui/art/frame/frame.json", "frame", "added"],
		]);
		expect(turns[2][0].preview).toBeUndefined();
	});

	it("leaves out what was only read or named, unless the agent showed it", () => {
		const { turns } = build(
			[
				user("look around"),
				...call("codemode", { code: 'read("assets/scenes/yard.json"); write("assets/sounds/thud/sound.json")' }),
				...call("edit_scene", { path: "assets/scenes/yard.json" }),
				...call("open_in_studio", { path: "assets/models/props/crate/model.json" }),
				...call("open_in_studio", { path: "build/shot.png" }),
				...call("open_in_studio", { path: "build/missing.png" }),
			],
			listed,
		);
		expect(turns[1].map((c) => [c.path, c.shown ?? false])).toEqual([
			["assets/sounds/thud/sound.json", false],
			["assets/models/props/crate/model.json", true],
			["build/shot.png", true],
		]);
		expect(turns[1][2]).toEqual({ path: "build/shot.png", name: "shot.png", checkout: "w1", preview: { kind: "image", path: "build/shot.png" }, shown: true });
	});

	it("once the worktree is merged, trusts the writing tools and not a script's mentions", () => {
		const merged = listed.filter((l) => l.asset.change !== "deleted").map((l) => asset(l.module.id, l.asset.path));
		const { turns } = build(
			[user("go"), ...call("codemode", { code: 'read("assets/scenes/yard.json")' }), ...call("write", { path: "game/main.odin" }), ...call("generate_model", { name: "barrel" })],
			merged,
			null,
		);
		expect(turns[1].map((c) => [c.path, c.checkout, c.change])).toEqual([
			["game/main.odin", null, undefined],
			["assets/models/barrel/model.json", null, undefined],
		]);
	});

	it("maps the paths the agent wrote to the assets they name", () => {
		const { mentions } = build(
			[said("I placed `assets/models/barrel/barrel.glb` in assets/scenes/yard.json, following docs/design/Art Style.md. The folder assets/models/props/crate is untouched; assets/models/nope/model.json doesn't exist.")],
			listed,
		);
		expect(Object.fromEntries(Object.entries(mentions).map(([k, c]) => [k, c.path]))).toEqual({
			"assets/models/barrel/barrel.glb": "assets/models/barrel/model.json",
			"assets/scenes/yard.json": "assets/scenes/yard.json",
			"docs/design/Art Style.md": "docs/design/Art Style.md",
			"assets/models/props/crate": "assets/models/props/crate/model.json",
		});
	});
});
