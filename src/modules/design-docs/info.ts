import { DESIGN_DOCS, DOC_ROOT, docPath } from "../../shared/design-docs";
import type { ModuleInfo } from "../../shared/modules";

export { summarizeMarkdown } from "../../shared/design-docs";

export const designDocs: ModuleInfo = {
	id: "design-docs",
	name: "Design Docs",
	icon: "📖",
	roots: [DOC_ROOT],
	extensions: [".md"],
	agentType: "project-scoping",
	noun: "doc",
	first: DESIGN_DOCS.map(docPath),
};
