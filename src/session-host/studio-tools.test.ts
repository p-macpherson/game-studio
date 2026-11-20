import { describe, expect, it } from "vitest";
import { studioTools } from "./studio-tools";

/** JSON Schema forms from before draft 2020-12, which the Claude API rejects (a whole session then fails). */
function oldForms(schema: unknown, at = ""): string[] {
	if (typeof schema !== "object" || schema === null) return [];
	const s = schema as Record<string, unknown>;
	const here = [
		...(Array.isArray(s.items) ? [`${at}: items as an array (a tuple: use prefixItems, or an array with minItems/maxItems)`] : []),
		...("additionalItems" in s ? [`${at}: additionalItems`] : []),
		...("definitions" in s ? [`${at}: definitions (use $defs)`] : []),
	];
	return [...here, ...Object.entries(s).flatMap(([k, v]) => (Array.isArray(v) ? v.flatMap((x, i) => oldForms(x, `${at}/${k}/${i}`)) : oldForms(v, `${at}/${k}`)))];
}

describe("studio tools", () => {
	it("declare their parameters in JSON Schema 2020-12 (the API refuses a session with an older form)", () => {
		const tools = studioTools({
			sessionId: "s",
			post: () => {},
			ask: async () => "",
			request: async () => ({}),
			delegatesTo: [{ id: "helper", name: "Helper", description: "" }],
		});
		expect(tools.length).toBeGreaterThan(10);
		expect(tools.flatMap((t) => oldForms(t.parameters, t.name))).toEqual([]);
	});
});
