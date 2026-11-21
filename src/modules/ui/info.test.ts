import { describe, expect, it } from "vitest";
import { artName, dragEdit, screenName, summarizeUi } from "./info";

describe("the UI section", () => {
	it("turns a drag into the offset edit that moves the element with the pointer, whatever its anchor", () => {
		const at = (anchor: string) => dragEdit({ id: "p", anchor, offset: [10, 20] }, { w: 100, h: 50 }, { kind: "move", dx: 60, dy: 30 }, 1440);
		// A 1440-pixel-tall frame: 2 pixels a UI unit, so 30 and 15 units.
		expect(at("top_left")?.fields).toEqual({ offset: [40, 35] });
		expect(at("center")?.fields).toEqual({ offset: [40, 35] });
		expect(at("bottom_right")?.fields).toEqual({ offset: [-20, 5] });
		expect(at("top_right")?.fields).toEqual({ offset: [-20, 35] });
		expect(dragEdit({ id: "p" }, { w: 100, h: 50 }, { kind: "resize", dx: 60, dy: -200 }, 720)?.fields).toEqual({ size: [160, 4] });
		expect(dragEdit({ id: "p" }, { w: 100, h: 50 }, { kind: "move", dx: 0.4, dy: 0.3 }, 720)).toBeNull();
	});

	it("names screens and art from their paths, and summarises each", () => {
		expect(screenName("assets/ui/menus/title.json")).toBe("menus/title");
		expect(artName("assets/ui/art/icons/coin/coin.json")).toBe("icons/coin");
		expect(summarizeUi(JSON.stringify({ pauses: true, elements: [{ id: "t", type: "text", text: "Gold: {gold}" }, { id: "b", type: "button", action: "resume" }] }), "assets/ui/pause.json")).toEqual({
			title: "pause",
			excerpt: "2 elements · pauses · shows gold · actions resume",
		});
		expect(summarizeUi(JSON.stringify({ kind: "icon", prompt: "a coin" }), "assets/ui/art/coin/coin.json")).toEqual({ title: "coin", excerpt: "icon · candidates only · a coin" });
	});
});
