import { describe, expect, it } from "vitest";
import { MODULES } from "./assets";
import { assetRequests, moveStep } from "./asset-move";
import type { GenService } from "./gen";
import { musicRequests } from "./music";
import { sceneRequests } from "./scenes";
import { soundRequests } from "./sounds";
import { handler, studioRequests } from "./studio-requests";

const gen = { cancel() {} } as unknown as GenService;
const never = {} as never;
const request = (method: string, params: unknown) => ({ sessionId: "s", requestId: "r", cwd: "/nowhere", method, params, progress() {} }) as never;

describe("studio requests", () => {
	it("names a person's run of a step for the undo history, and records nothing for a preview", () => {
		const requests = studioRequests(gen, musicRequests(never), soundRequests(never), sceneRequests(), assetRequests(MODULES.map((m) => m.info)));
		expect(requests.step("edit_song", { name: "theme", tempo: 96, space: "hall" })).toEqual({ label: "Music theme: space hall, tempo 96", scopes: [{ path: "assets/music/theme" }] });
		expect(requests.step("edit_sound", { name: "ui/click", set: { pitch: 2 } })?.label).toBe("Sound ui/click: pitch");
		expect(requests.step("edit_scene", { path: "assets/scenes/main.json", edits: [{ op: "delete", id: 3 }] })?.label).toBe("Scene main: deleted an entity");
		expect(requests.step("preview_scene", { scene: "assets/scenes/main.json" })).toBeNull();
		expect(requests.step("no_such_step", {})).toBeNull();
	});

	it("moves a folder-shaped asset as its folder, whatever section it belongs to", () => {
		const modules = MODULES.map((m) => m.info);
		expect(moveStep(modules, "assets/textures/grass/texture.json", "assets/textures/ground/grass/texture.json").scopes.slice(0, 2)).toEqual([{ path: "assets/textures/grass" }, { path: "assets/textures/ground/grass" }]);
		expect(moveStep(modules, "assets/prefabs/rock.json", "assets/prefabs/stone.json").label).toBe("Renamed rock → stone");
	});

	it("refuses what it has no handler for, parameters that aren't an object, and two handlers for one request", async () => {
		const requests = studioRequests(gen, { render_song: handler(() => "rendered") });
		await expect(requests.studioRequest(request("render_song", { name: "x" }))).resolves.toBe("rendered");
		await expect(requests.studioRequest(request("render_sound", { name: "x" }))).rejects.toThrow(/can't serve/);
		await expect(requests.studioRequest(request("render_song", "x"))).rejects.toThrow(/object of parameters/);
		expect(() => studioRequests(gen, { render_song: handler(() => 1) }, { render_song: handler(() => 2) })).toThrow(/Two handlers/);
	});
});
