import { describe, expect, it } from "vitest";
import { delegateModel, withModelSettings } from "./agent-models";
import type { AgentTypeInfo } from "./types";

const type = (over: Partial<AgentTypeInfo>): AgentTypeInfo => ({ id: "t", name: "T", description: "", targets: ["project"], skills: [], prompt: "", source: "builtin", ...over });
const all = new Set(["a/small", "a/big", "a/huge"]);

describe("agent models", () => {
	it("starts a sub-agent on its default, and on another model only when its type allows it", () => {
		const t = type({ defaultModel: "a/small", models: ["a/big", "a/gone"] });
		expect(delegateModel(t, "a/huge", all)).toBe("a/small");
		expect(delegateModel(t, "a/huge", all, "a/big")).toBe("a/big");
		expect(delegateModel(t, "a/huge", all, "a/small")).toBe("a/small");
		expect(() => delegateModel(t, "a/huge", all, "a/huge")).toThrow(/choose a\/big, or leave/);
		expect(() => delegateModel(t, "a/huge", all, "a/gone")).toThrow(/choose a\/big/); // allowed, but not available now
		expect(() => delegateModel(type({ defaultModel: "a/small" }), "a/huge", all, "a/big")).toThrow(/only runs on its usual model \(a\/small\)/);
		// A default that isn't available falls back to the parent's model.
		expect(delegateModel(type({ defaultModel: "a/none" }), "a/huge", all)).toBe("a/huge");
	});

	it("applies Settings' choices over AGENT.md and remembers what the file said", () => {
		const types = [type({ id: "x", defaultModel: "a/small", models: ["a/big"] }), type({ id: "y", defaultModel: "a/small" })];
		const [x, y] = withModelSettings(types, { x: { defaultModel: "a/big", models: ["a/big", "a/huge"] } });
		expect(x).toMatchObject({ defaultModel: "a/big", models: ["a/huge"], fileModels: { defaultModel: "a/small", models: ["a/big"] } });
		expect(y).toBe(types[1]);
		expect(withModelSettings(types, undefined)).toBe(types);
	});
});
