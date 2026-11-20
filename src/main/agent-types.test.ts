import { describe, expect, it } from "vitest";
import type { AgentTypeInfo } from "../shared/types";
import { checkDelegation } from "./agent-types";

const type = (id: string, delegatesTo: string[]): AgentTypeInfo => ({ id, name: id.toUpperCase(), description: "", targets: ["project"], skills: [], prompt: "", source: "builtin", delegatesTo });

describe("checkDelegation", () => {
	it("keeps the delegation graph acyclic and pointing at real types", () => {
		const out = checkDelegation([type("a", ["b", "ghost"]), type("b", ["c", "b"]), type("c", ["a", "d"]), type("d", [])]);
		const by = Object.fromEntries(out.map((t) => [t.id, t]));
		expect(by.a.delegatesTo).toEqual(["b"]);
		expect(by.a.problems).toEqual(['Can\'t delegate to "ghost": no such agent type']);
		expect(by.b.delegatesTo).toEqual(["c"]); // delegating to itself is dropped quietly
		expect(by.c.delegatesTo).toEqual(["d"]); // c → a would close a → b → c → a
		expect(by.c.problems?.[0]).toMatch(/^Delegating to "a" would make a cycle/);
		expect(by.d.problems).toBeUndefined();
	});
});
