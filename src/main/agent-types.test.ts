import { describe, expect, it } from "vitest";
import type { AgentTypeInfo } from "../shared/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./test-helpers";
import { findAgentType } from "../shared/agents";
import { checkDelegation, loadAgentTypes } from "./agent-types";

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

	it("reports an AGENT.md it can't read instead of failing every type", () => {
		const dir = join(tempDir(), "types");
		mkdirSync(join(dir, "broken"), { recursive: true });
		mkdirSync(join(dir, "fine"), { recursive: true });
		writeFileSync(join(dir, "broken/AGENT.md"), "---\nname: Broken\ndescription: a: b\n---\nhi");
		writeFileSync(join(dir, "fine/AGENT.md"), "---\nname: Fine\n---\nhi");
		const types = loadAgentTypes(dir);
		expect(types.map((t) => [t.id, t.problems?.[0]?.split(":")[0]])).toEqual([["broken", "AGENT.md can't be read"], ["fine", undefined]]);
	});

	it("loads the built-in types: a valid graph, and old sessions of the General type open as the Chief Director", () => {
		const types = loadAgentTypes(join(process.cwd(), "agent-types"));
		expect(types.flatMap((t) => (t.problems ?? []).map((p) => `${t.id}: ${p}`))).toEqual([]);
		expect(findAgentType(types, "general")?.id).toBe("chief-director");
		const by = Object.fromEntries(types.map((t) => [t.id, t.delegatesTo]));
		expect(by["chief-director"]).toEqual(["project-scoping", "art-director", "ui-designer", "shader-author", "audio-director", "level-designer", "gameplay-engineer", "engine-engineer", "studio-engineer"]);
		expect(by["art-director"]).toEqual(["concept-artist", "3d-modeller", "texture-artist", "ui-designer", "shader-author"]);
		expect(by["ui-designer"] ?? []).toEqual([]);
		expect(by["shader-author"] ?? []).toEqual([]);
		expect(by["level-designer"]).toEqual(["art-director", "audio-director", "gameplay-engineer"]);
	});
});
