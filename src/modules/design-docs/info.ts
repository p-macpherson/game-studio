import type { ModuleInfo } from "../../shared/modules";

export const designDocs: ModuleInfo = {
	id: "design-docs",
	name: "Design Docs",
	icon: "📖",
	roots: ["docs/design"],
	extensions: [".md"],
	agentType: "project-scoping",
	noun: "doc",
};

/** Title from the first `# heading` (else the file name); excerpt from the first paragraph after it. */
export function summarizeMarkdown(text: string, path: string): { title: string; excerpt: string } {
	const lines = text.split("\n");
	const headingIndex = lines.findIndex((l) => /^#\s+\S/.test(l));
	const title = headingIndex >= 0 ? lines[headingIndex].replace(/^#\s+/, "").trim() : (path.split("/").pop() ?? path).replace(/\.md$/i, "");
	const paragraph: string[] = [];
	for (const raw of lines.slice(headingIndex + 1)) {
		const line = raw.replace(/^>\s?/, "").trim();
		if (!line) {
			if (paragraph.length) break;
			continue;
		}
		if (/^(#|\||```|---|- |\* |\d+\. )/.test(line)) {
			if (paragraph.length) break;
			continue;
		}
		paragraph.push(line);
	}
	const excerpt = paragraph
		.join(" ")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "");
	return { title, excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 177)}…` : excerpt };
}
