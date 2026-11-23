import { describe, expect, it } from "vitest";
import { parseScenario, resolveScenario, scenarioValues } from "./scenario";

const file = JSON.stringify({
	title: "Terrain sandbox",
	description: "Walk a generated landscape.",
	scene: "scenes/{environment}.json",
	flags: { biome: "{environment}", seed: "{seed}", "god-mode": "{invincible}", "no-enemies": true, label: "run-{seed}" },
	setup: [
		{ cmd: "console", line: "goto {marker}" },
		{ cmd: "wait", frames: "{settle}" },
	],
	params: [
		{ id: "environment", label: "Environment", type: "choice", options: ["forest", "desert"], default: "desert" },
		{ id: "seed", type: "number", default: 7, min: 0, max: 100, random: true },
		{ id: "invincible", type: "toggle" },
		{ id: "marker", type: "text", default: "Spawn" },
		{ id: "settle", type: "number", default: 30 },
	],
});

describe("scenario", () => {
	it("resolves parameters into the scene, flags and setup, keeping numbers as numbers", () => {
		const { scenario, problems } = parseScenario(file);
		expect(problems).toEqual([]);
		expect(resolveScenario(scenario!)).toEqual({
			values: { environment: "desert", seed: 7, invincible: false, marker: "Spawn", settle: 30 },
			// A toggle that is off leaves its flag out.
			args: ["--biome=desert", "--seed=7", "--no-enemies", "--label=run-7", "--scene=scenes/desert.json"],
			setup: [
				{ cmd: "console", args: { line: "goto Spawn" } },
				{ cmd: "wait", args: { frames: 30 } },
			],
		});
		const picked = resolveScenario(scenario!, { environment: "forest", seed: 42, invincible: true });
		expect(picked.args).toEqual(["--biome=forest", "--seed=42", "--god-mode", "--no-enemies", "--label=run-42", "--scene=scenes/forest.json"]);
	});

	it("falls back to defaults for values that no longer suit the parameter", () => {
		const { scenario } = parseScenario(file);
		expect(scenarioValues(scenario!, { environment: "tundra", seed: 500, invincible: "yes", marker: 3 })).toEqual({ environment: "desert", seed: 100, invincible: false, marker: "Spawn", settle: 30 });
	});

	it("says what is wrong with a file", () => {
		expect(parseScenario("{").problems[0]).toMatch(/^Not valid JSON/);
		const bad = parseScenario(
			JSON.stringify({
				flags: { mode: "window", scene: "x", Biome: "a", ok: "{nope}" },
				setup: [{ line: "x" }, { cmd: "quit" }],
				params: [{ id: "Env", type: "choice" }, { id: "env", type: "choice", options: ["a"], default: "b" }, { id: "env", type: "dial" }, { id: "n", type: "number", default: "1" }],
				extra: 1,
			}),
		).problems;
		expect(bad).toEqual([
			'Unknown field "extra" (a scenario has: title, description, notes, scene, flags, setup, params)',
			'Give it a "title"',
			'params[0]: "id" must be lowercase letters, digits and underscores, starting with a letter',
			'env: its default "b" isn\'t one of its options',
			'Two parameters are called "env"',
			'env: "type" must be choice, number, toggle or text',
			"n: its default must be a number",
			'The flag "mode" is set by the studio for every run: leave it out',
			'Give the scene as "scene", not as a flag',
			'The flag name "Biome" must be lowercase letters, digits and dashes',
			'setup[0] must be a control command: {"cmd": "...", ...}',
			'setup[1]: a scenario leaves the game running for the person: no "quit"',
			"{nope} is used but there's no parameter with that id",
		]);
	});
});
