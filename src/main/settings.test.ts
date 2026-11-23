import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "./settings";
import { tempDir } from "./test-helpers";

describe("SettingsStore", () => {
	it("remembers a project folder once, however its path was spelt", () => {
		const file = join(tempDir(), "settings.json");
		// As an older studio left it: the same folders with and without a trailing slash.
		writeFileSync(file, JSON.stringify({ recentProjects: ["/games/trough/", "/games/car", "/games/demo", "/games/car/", ""], lastProject: "/games/trough/" }));
		const store = new SettingsStore(file);
		expect(store.get().recentProjects).toEqual(["/games/trough", "/games/car", "/games/demo"]);
		expect(store.get().lastProject).toBe("/games/trough");
		store.rememberProject("/games/demo/");
		expect(store.get().recentProjects).toEqual(["/games/demo", "/games/trough", "/games/car"]);
		store.forgetProject("/games/demo");
		expect(store.get()).toMatchObject({ recentProjects: ["/games/trough", "/games/car"], lastProject: undefined });
		expect(JSON.parse(readFileSync(file, "utf8")).recentProjects).toEqual(["/games/trough", "/games/car"]);
	});
});
