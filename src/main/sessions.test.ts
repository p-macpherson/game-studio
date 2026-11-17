import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import type { AgentTypeInfo, Settings } from "../shared/types";
import { SessionService } from "./sessions";
import { inProcessHost, makeRepo, sh, tempDir, waitFor } from "./test-helpers";

const general: AgentTypeInfo = {
	id: "general",
	name: "General",
	description: "",
	targets: ["project", "engine", "studio"],
	skills: [],
	prompt: "Be helpful.",
	source: "builtin",
};

describe("SessionService", () => {
	let root: string;
	let project: string;
	let settings: Settings;
	let service: SessionService;
	let events: StudioEvent[];

	beforeEach(async () => {
		root = tempDir();
		project = makeRepo(join(root, "game"));
		settings = {
			engineRepo: makeRepo(join(root, "engine")),
			studioRepo: makeRepo(join(root, "studio")),
			worktreeRoot: join(root, "worktrees"),
			recentProjects: [],
		};
		events = [];
		const host = await inProcessHost(join(root, "pi"));
		service = new SessionService({
			host,
			settings: () => settings,
			projectPath: () => project,
			agentTypes: () => [general],
			skillsDir: join(root, "skills"),
			emit: (e) => events.push(e),
		});
	});

	afterEach(() => service.dispose());

	const settled = (id: string) => waitFor(() => service.get(id).status === "idle");

	it("runs a session in its own worktree through to merge, then resumes it", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "add a note" });
		expect(s.branch).toBe(`studio/${s.id}`);
		await settled(s.id);

		// The agent's commit is on the session branch in the worktree, not on main.
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("add a note\n");
		expect(existsSync(join(project, "faux-notes.md"))).toBe(false);
		expect(sh(project, "log", "--format=%s", s.branch)).toContain("faux: add a note");
		expect(events.some((e) => e.type === "session_event" && e.event.type === "agent_settled")).toBe(true);

		// The record and Pi transcript live in the main checkout.
		const record = join(project, ".studio/sessions", s.id);
		expect(JSON.parse(readFileSync(join(record, "session.json"), "utf8")).status).toBe("idle");
		expect(service.raw(s.id)).toContain("add a note");
		expect(await service.diff(s.id)).toContain("+add a note");

		await service.merge(s.id);
		const merged = service.get(s.id);
		expect(merged).toMatchObject({ status: "done", outcome: "merged", worktree: "removed" });
		expect(readFileSync(join(project, "faux-notes.md"), "utf8")).toBe("add a note\n");
		expect(existsSync(s.worktreePath)).toBe(false);
		expect(sh(project, "log", "-1", "--format=%s")).toMatch(/^studio: session .* merged/);
		expect(sh(project, "status", "--porcelain")).toBe("");

		// Resume recreates the worktree on the up-to-date branch and the conversation continues.
		await service.resume(s.id);
		expect(service.get(s.id).status).toBe("idle");
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("add a note\n");
		await service.send(s.id, "second note");
		await settled(s.id);
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("add a note\nsecond note\n");
		const messages = (await service.messages(s.id)) as { role: string }[];
		expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
	});

	it("discards a session, keeping its branch so it can still be resumed", async () => {
		const s = await service.create({ agentType: "general", target: "engine", model: "faux/echo", prompt: "engine tweak" });
		await settled(s.id);
		await service.discard(s.id);
		expect(service.get(s.id)).toMatchObject({ status: "done", outcome: "discarded", worktree: "removed" });
		expect(existsSync(join(settings.engineRepo, "faux-notes.md"))).toBe(false);
		expect(existsSync(join(settings.engineRepo, ".studio/sessions", s.id, "session.json"))).toBe(true);

		await service.resume(s.id);
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("engine tweak\n");
	});

	it("reads transcripts from disk when the Pi session isn't loaded", async () => {
		const s = await service.create({ agentType: "general", target: "studio", model: "faux/echo", prompt: "hello" });
		await settled(s.id);
		await service.markDone(s.id);
		const messages = (await service.messages(s.id)) as { role: string }[];
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("marks sessions left running as interrupted when records are reloaded", async () => {
		const id = "20260101-000000-abcd";
		const dir = join(project, ".studio/sessions", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "session.json"),
			JSON.stringify({ id, title: "t", agentType: "general", target: "project", status: "in_progress", branch: `studio/${id}`, baseBranch: "main", baseCommit: "HEAD", model: "faux/echo", createdAt: "", updatedAt: "", worktree: "removed", outcome: null, reviewRequested: false }),
		);
		service.load();
		expect(service.get(id).status).toBe("interrupted");
	});

	it("refuses to merge when the main checkout is on another branch", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "x" });
		await settled(s.id);
		sh(project, "checkout", "-q", "-b", "other");
		await expect(service.merge(s.id)).rejects.toThrow(/switch it to main/);
		expect(service.get(s.id).status).toBe("idle");
	});
});
