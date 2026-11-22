import { describe, expect, it } from "vitest";
import { addDocImage, designBrief, docImages } from "./design-docs";

describe("reference images in design docs", () => {
	it("finds a doc's images as repo paths, skipping web images", () => {
		const text = "# Art Style\n![palette and light](references/forest%20glade.png)\n![](../shared/logo.png)\n![web](https://example.com/a.png)\n";
		expect(docImages("docs/design/Art Style.md", text)).toEqual([
			{ path: "docs/design/references/forest glade.png", caption: "palette and light" },
			{ path: "docs/shared/logo.png", caption: "" },
		]);
	});

	it("adds an image at the end of the References section, making the section when there's none", () => {
		const first = addDocImage("# Art Style\n\n## Palette\nGreens.\n", "references/a.png", "palette");
		expect(first).toBe("# Art Style\n\n## Palette\nGreens.\n\n## References\n![palette](references/a.png)\n");
		const withLater = `${first}\n## To decide\n- Fonts\n`;
		expect(addDocImage(withLater, "references/b c.png", "props")).toBe(
			"# Art Style\n\n## Palette\nGreens.\n\n## References\n![palette](references/a.png)\n![props](references/b%20c.png)\n\n## To decide\n- Fonts\n",
		);
	});

	it("lists a followed doc's images in the brief, telling the agent to look at them", () => {
		const art = { path: "docs/design/Art Style.md", text: "---\nstatus: draft\n---\n# Art Style\n## References\n![palette](references/a.png)\n" };
		const audio = { path: "docs/design/Audio Style.md", text: "# Audio Style\n![wave](references/w.png)\n" };
		const brief = designBrief([art, audio], ["art-style"]);
		expect(brief).toContain("**Reference images** for this doc. Look at each (open it with `read`)");
		expect(brief).toContain("- `docs/design/references/a.png`: palette");
		expect(brief).not.toContain("references/w.png`"); // only the docs an agent follows are briefed in full
	});
});
