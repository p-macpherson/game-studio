import { describe, expect, it } from "vitest";
import { NavHistory, type Place, placeOf } from "./nav-history";

const at = (view: string, over: Partial<Place> = {}): Place => ({ view, session: null, asset: null, worktree: null, review: null, changes: null, changesFile: null, settingsTab: null, ...over });
const all = () => true;

describe("NavHistory", () => {
	it("goes back and forward, and a new place drops what was ahead", () => {
		const h = new NavHistory();
		h.visit(at("sessions", { session: "s1" }));
		h.visit(at("module:3d-models", { asset: "assets/models/rock/model.json", worktree: "w1" }));
		h.visit(at("play", { worktree: "w1" }));
		h.visit(at("play", { worktree: "w1" })); // the same place: not a second entry
		expect(h.go(-1, all)).toMatchObject({ view: "module:3d-models", worktree: "w1" });
		expect(h.go(-1, all)).toMatchObject({ view: "sessions", session: "s1", worktree: null });
		expect(h.go(-1, all)).toBeNull();
		expect(h.go(1, all)?.view).toBe("module:3d-models");
		h.visit(at("settings", { settingsTab: "agents" }));
		expect(h.go(1, all)).toBeNull();
		expect(h.go(-1, all)?.view).toBe("module:3d-models");
	});

	it("counts a section opening its first asset by itself as the same visit", () => {
		const h = new NavHistory();
		h.visit(at("sessions"));
		h.visit(at("module:music"));
		h.visit(at("module:music", { asset: "assets/music/theme/song.json" })); // picked by the section
		h.visit(at("module:music", { asset: "assets/music/boss/song.json" })); // picked by the person
		expect(h.go(-1, all)?.asset).toBe("assets/music/theme/song.json");
		expect(h.go(-1, all)?.view).toBe("sessions");
	});

	it("skips places that no longer exist", () => {
		const h = new NavHistory();
		h.visit(at("sessions", { session: "s1" }));
		h.visit(at("worktrees", { review: "gone" }));
		h.visit(at("play"));
		const exists = (p: Place) => p.review !== "gone";
		expect(h.peek(-1, exists)).toBe(0);
		expect(h.go(-1, exists)?.session).toBe("s1");
		expect(h.go(1, exists)?.view).toBe("play");
	});

	it("reads a place from the studio's state, leaving out what the page doesn't show", () => {
		const state = { view: "module:scenes", selectedSession: "s1", focus: { path: "assets/models/rock/model.json" }, selected: "w1", reviewOf: "w2", changesOf: null, changesFile: null, settingsTab: "general" };
		const owns = (view: string, path: string) => view === "module:3d-models" && path.startsWith("assets/models/");
		// The session, the review and the settings tab belong to other pages; the focused asset to another section.
		expect(placeOf(state, owns)).toEqual(at("module:scenes", { worktree: "w1" }));
		expect(placeOf({ ...state, view: "module:3d-models" }, owns).asset).toBe("assets/models/rock/model.json");
		expect(placeOf({ ...state, view: "worktrees" }, owns)).toEqual(at("worktrees", { worktree: "w1", review: "w2" }));
	});
});
