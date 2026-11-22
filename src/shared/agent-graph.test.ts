import { describe, expect, it } from "vitest";
import { layoutAgentGraph } from "./agent-graph";

describe("layoutAgentGraph", () => {
	it("puts each type one column past the deepest type that delegates to it", () => {
		const g = layoutAgentGraph([
			{ id: "chief", name: "Chief", delegatesTo: ["art", "ui", "code"] },
			{ id: "art", name: "Art", delegatesTo: ["ui", "model"] },
			{ id: "ui", name: "UI" },
			{ id: "model", name: "Model" },
			{ id: "code", name: "Code" },
			{ id: "loner", name: "Loner" },
		]);
		const at = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
		expect([at.chief.col, at.art.col, at.code.col, at.ui.col, at.model.col, at.loner.col]).toEqual([0, 1, 1, 2, 2, 0]);
		expect(g.cols).toBe(3);
		expect(g.edges).toHaveLength(5);
		expect(at.chief.row).toBeLessThan(at.loner.row); // the type outside the graph goes below the one that delegates
		// No two types share a place.
		expect(new Set(g.nodes.map((n) => `${n.col}:${n.row}`)).size).toBe(6);
	});
});
