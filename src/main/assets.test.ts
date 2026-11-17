import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { summarizeMarkdown } from "../modules/design-docs/info";
import type { AgentTypeInfo } from "../shared/types";
import { AssetService } from "./assets";
import { SessionService } from "./sessions";
import { inProcessHost, makeRepo, tempDir, waitFor } from "./test-helpers";

const scoping: AgentTypeInfo = {
	id: "project-scoping",
	name: "Project Scoping",
	description: "",
	targets: ["project"],
	skills: [],
	prompt: "",
	source: "builtin",
};

describe("summarizeMarkdown", () => {
	it("takes the title from the first heading and the excerpt from the first paragraph", () => {
		const doc = "# Combat\n\n> Quote line one\n> continues\n\n## Rules\nlater";
		expect(summarizeMarkdown(doc, "docs/design/Combat.md")).toEqual({ title: "Combat", excerpt: "Quote line one continues" });
	});

	it("shows link text, not markdown syntax, in excerpts", () => {
		expect(summarizeMarkdown("# A\n\nSee [the **overview**](Overview.md).", "a.md").excerpt).toBe("See the overview.");
	});

	it("falls back to the file name", () => {
		expect(summarizeMarkdown("just text", "docs/design/Lore Bible.md").title).toBe("Lore Bible");
	});
});

describe("AssetService", () => {
	let project: string;
	let sessions: SessionService;
	let assets: AssetService;

	beforeEach(async () => {
		const root = tempDir();
		project = makeRepo(join(root, "game"), { "docs/design/Overview.md": "# My Game\n\nA game about cubes.\n", "src/x.md": "# not a doc" });
		sessions = new SessionService({
			host: await inProcessHost(join(root, "pi")),
			settings: () => ({ engineRepo: join(root, "none"), studioRepo: join(root, "none"), worktreeRoot: join(root, "wt"), recentProjects: [] }),
			projectPath: () => project,
			agentTypes: () => [scoping],
			skillsDir: join(root, "skills"),
			emit: () => {},
		});
		assets = new AssetService(() => project, sessions);
	});

	it("lists design docs from the main checkout plus drafts from session worktrees", async () => {
		const s = await sessions.create({
			agentType: "project-scoping",
			target: "project",
			model: "faux/echo",
			prompt: "write docs/design/Combat.md: # Combat\n\nHit things.",
		});
		await waitFor(() => sessions.get(s.id).status === "idle");
		writeFileSync(join(s.worktreePath, "docs/design/Overview.md"), "# My Game\n\nNow with combat.\n");

		const list = await assets.list("design-docs");
		expect(list.map((a) => [a.path, a.title, a.inMain])).toEqual([
			["docs/design/Combat.md", "Combat", false],
			["docs/design/Overview.md", "My Game", true],
		]);
		expect(list[0].drafts).toEqual([{ sessionId: s.id, sessionTitle: s.title, status: "idle", change: "added" }]);
		expect(list[1].drafts.map((d) => d.change)).toEqual(["modified"]);
		expect(list[1].excerpt).toBe("A game about cubes.");

		expect(assets.read("docs/design/Overview.md")).toContain("cubes");
		expect(assets.read("docs/design/Overview.md", s.id)).toContain("combat");
		expect(assets.search("design-docs", "CUBES")).toEqual([{ path: "docs/design/Overview.md", line: 3, text: "A game about cubes." }]);
	});

	it("only reads module assets inside the project", () => {
		expect(() => assets.read("src/x.md")).toThrow(/isn't a studio asset/);
		expect(() => assets.read("docs/design/../../../etc/passwd.md")).toThrow(/escapes the project/);
		mkdirSync(join(project, "docs/design/sub"), { recursive: true });
		expect(assets.read("docs/design/sub/missing.md")).toBe("");
	});
});
