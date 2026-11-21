import { describe, expect, it } from "vitest";
import { applyUiEdits, formatUiScreen, parseUiScreen, screenInterface, type UiScreen, validateUiScreen } from "./ui-screen";

const PAUSE: UiScreen = {
	pauses: true,
	modal: true,
	elements: [
		{ id: "box", type: "panel", frame: "ui/art/panel/panel.png", anchor: "center", size: [380, 430], padding: 48, children: [
			{ id: "title", type: "text", text: "Paused", anchor: "top", font_size: 40, color: "#3b2412" },
			{ id: "gold", type: "text", text: "Gold: {gold} of {total}", visible: "!hide_gold" },
			{ id: "menu", type: "stack", anchor: "bottom", size: [260, 160], gap: 14, children: [
				{ id: "resume", type: "button", text: "Resume", size: [260, 64], action: "resume" },
				{ id: "volume", type: "slider", text: "Volume", bind: "volume", size: [260, 40], action: "volume" },
			] },
		] },
	],
};

describe("UI screens", () => {
	it("accepts a good screen and says what it reads and reports", () => {
		expect(validateUiScreen(PAUSE, { exists: () => true })).toEqual([]);
		expect(screenInterface(PAUSE)).toEqual({ bindings: ["gold", "hide_gold", "total", "volume"], actions: ["resume", "volume"] });
	});

	it("lists every problem, by element id", () => {
		const bad = structuredClone(PAUSE) as unknown as { elements: Record<string, unknown>[] };
		const kids = (bad.elements[0].children as Record<string, unknown>[]);
		kids[0].type = "label";
		kids[1].color = "red";
		kids[1].id = "title";
		const menu = (kids[2].children as Record<string, unknown>[]);
		delete menu[1].bind;
		delete menu[0].action;
		menu[0].size = [260];
		const problems = validateUiScreen(bad, { exists: (p) => !p.includes("panel") }).map((p) => `${p.at}: ${p.message}`);
		expect(problems).toEqual([
			"elements.box.frame: No assets/ui/art/panel/panel.png",
			"elements.box.children.title.type: One of panel, text, image, button, slider, checkbox, bar, stack",
			'elements.box.children.title.color: "#rrggbb" or "#rrggbbaa"',
			"elements.box.children.menu.children.resume.size: [x, y] in UI units",
			"elements.box.children.menu.children.resume.action: A button reports an action when clicked: name it (the game handles it)",
			"elements.box.children.menu.children.volume.bind: A slider shows and changes a binding: give it one",
			'elements.title: The id "title" is used 2 times: ids must be unique in a screen',
		]);
	});

	it("reads comments and trailing commas, and formats so it parses back the same", () => {
		const text = `{ // the pause menu\n "elements": [{"id": "t", "type": "text", "text": "Hi",},],}`;
		const { screen, problems } = parseUiScreen(text);
		expect(problems).toEqual([]);
		const out = formatUiScreen(PAUSE);
		expect(parseUiScreen(out).screen).toEqual(PAUSE);
		expect(out).toContain('"size": [380, 430]');
		expect(screen?.elements[0].text).toBe("Hi");
	});

	it("edits by id: set (null clears), add, move and delete; refuses unknown ids and moving into itself", () => {
		const next = applyUiEdits(PAUSE, [
			{ op: "set", id: "title", fields: { text: "Have a rest", color: null } },
			{ op: "add", parent: "menu", index: 1, element: { id: "quit", type: "button", text: "Quit", size: [260, 64], action: "quit" } },
			{ op: "move", id: "gold", parent: null, index: 0 },
			{ op: "delete", id: "volume" },
			{ op: "screen", fields: { pauses: false } },
		]);
		expect(next.elements.map((e) => e.id)).toEqual(["gold", "box"]);
		const box = next.elements[1];
		expect(box.children?.[0]).toMatchObject({ id: "title", text: "Have a rest" });
		expect(box.children?.[0]).not.toHaveProperty("color");
		expect(box.children?.[1].children?.map((e) => e.id)).toEqual(["resume", "quit"]);
		expect(next.pauses).toBe(false);
		expect(PAUSE.elements[0].children?.[0].text).toBe("Paused"); // a copy
		expect(() => applyUiEdits(PAUSE, [{ op: "set", id: "nope", fields: {} }])).toThrow(/No element "nope"/);
		expect(() => applyUiEdits(PAUSE, [{ op: "move", id: "box", parent: "menu" }])).toThrow(/can't move inside itself/);
		expect(() => applyUiEdits(PAUSE, [{ op: "add", element: { id: "gold", type: "text" } }])).toThrow(/taken/);
	});
});
