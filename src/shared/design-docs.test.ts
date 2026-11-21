import { describe, expect, it } from "vitest";
import { DESIGN_DOCS, designBrief, docPath, docTemplate, missingDocs, parseDoc, setDocBody, setDocStatus, summarizeMarkdown } from "./design-docs";

const def = (id: string) => DESIGN_DOCS.find((d) => d.id === id)!;
const fresh = DESIGN_DOCS.map((d) => ({ path: docPath(d), text: docTemplate(d) }));

describe("design docs", () => {
	it("reads and sets a doc's status, keeping the rest", () => {
		const doc = docTemplate(def("art-style"));
		expect(parseDoc(doc).status).toBe("not-established");
		expect(parseDoc(doc).body.startsWith("# Art Style")).toBe(true);
		const set = setDocStatus("---\nowner: pat\nstatus: draft\n---\n# A\n", "established");
		expect(set).toBe("---\nstatus: established\nowner: pat\n---\n# A\n");
		expect(setDocStatus("# Plain\n", "draft")).toBe("---\nstatus: draft\n---\n# Plain\n");
		expect(parseDoc("# Plain\n")).toEqual({ body: "# Plain\n" });
		expect(setDocBody(set, "# B\n")).toBe("---\nstatus: established\nowner: pat\n---\n# B\n");
	});

	it("summarises past the frontmatter, with the status", () => {
		expect(summarizeMarkdown(docTemplate(def("art-style")), "docs/design/Art Style.md")).toMatchObject({ title: "Art Style", status: "not-established" });
		expect(summarizeMarkdown(docTemplate(def("art-style")), "x.md").excerpt).toMatch(/^How the game looks/);
	});

	it("knows which standard docs a project lacks", () => {
		expect(missingDocs(["docs/design/Game Brief.md", "docs/design/Combat.md"]).map((d) => d.id)).not.toContain("game-brief");
		expect(missingDocs(fresh.map((d) => d.path))).toEqual([]);
	});

	it("briefs an agent: its docs in full with their status, the others listed", () => {
		const brief = designBrief([...fresh, { path: "docs/design/Combat.md", text: "# Combat\n\nHit things.\n" }], ["art-style"]);
		expect(brief).toContain("### Art Style: NOT ESTABLISHED (`docs/design/Art Style.md`)");
		expect(brief).toContain("All art should be simple and minimal");
		// Not its docs: listed, not given in full.
		expect(brief).toContain("- **Audio Style**, not established (`docs/design/Audio Style.md`)");
		expect(brief).not.toContain("Keep audio minimal");
		expect(brief).toContain("- **Combat**, current (`docs/design/Combat.md`): Hit things.");
		expect(brief.indexOf("**Game Brief**")).toBeLessThan(brief.indexOf("**Combat**"));
	});

	it("gives an established doc as the user wrote it", () => {
		const art = { path: "docs/design/Art Style.md", text: "---\nstatus: established\n---\n# Art Style\n\n> Chunky low-poly.\n\n## Palette\nNever pure black.\n" };
		const brief = designBrief([art], ["art-style"]);
		expect(brief).toContain("### Art Style: ESTABLISHED");
		expect(brief).toContain("Never pure black.");
		expect(designBrief([], ["art-style"])).toBe("");
	});
});
