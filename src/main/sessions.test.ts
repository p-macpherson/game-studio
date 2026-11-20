import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import type { AgentTypeInfo, Settings } from "../shared/types";
import type { HostCore } from "../session-host/host-core";
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

const helper: AgentTypeInfo = { ...general, id: "helper", name: "Helper", targets: ["project"], delegatesTo: [] };
const lead: AgentTypeInfo = { ...general, id: "lead", name: "Lead", targets: ["project"], delegatesTo: ["helper"], studioTools: [] };

describe("SessionService", () => {
	let root: string;
	let project: string;
	let settings: Settings;
	let service: SessionService;
	let events: StudioEvent[];
	let core: HostCore;

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
		core = host.core;
		service = new SessionService({
			host,
			settings: () => settings,
			projectPath: () => project,
			agentTypes: () => [general, helper, lead],
			skillsDir: join(root, "skills"),
			emit: (e) => events.push(e),
		});
	});

	afterEach(() => service.dispose());

	const settled = (id: string) => waitFor(() => service.get(id).status === "idle");

	it("gives every Pi session the codemode tool", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "hello" });
		await settled(s.id);
		const live = (core as unknown as { sessions: Map<string, { session: { getActiveToolNames(): string[] } }> }).sessions.get(s.id)!;
		expect(live.session.getActiveToolNames()).toContain("codemode");

		// A script reaches both Pi's tools and the studio's.
		const code = 'const r = await tools.bash({ command: "echo from-a-script" }); await tools.set_session_title({ title: "Scripted" }); return r.output.trim();';
		await service.send(s.id, `tool codemode ${JSON.stringify({ code })}`);
		await waitFor(() => service.get(s.id).title === "Scripted", 20_000);
		expect(service.get(s.id).worktreeLabel).toBe("Scripted"); // its worktree, made for it, follows the title
		await settled(s.id);
		expect(JSON.stringify((await service.messages(s.id)).at(-1))).toContain("from-a-script");
	}, 30_000);

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
		expect(sh(project, "log", "-1", "--format=%s")).toMatch(/^studio: worktree .* merged/);
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

	it("runs several sessions in one worktree, a child in its parent's by default, and merges them together", async () => {
		const parent = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "first note", worktreeLabel: "Notes pass" });
		await settled(parent.id);
		const child = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "second note", parentId: parent.id });
		expect(child).toMatchObject({ parentId: parent.id, worktreeId: parent.worktreeId, worktreeLabel: "Notes pass", worktreePath: parent.worktreePath });
		await settled(child.id);
		expect(readFileSync(join(parent.worktreePath, "faux-notes.md"), "utf8")).toBe("first note\nsecond note\n");

		service.renameWorktree(parent.worktreeId, "Two notes");
		expect(service.listWorktrees().find((w) => w.id === parent.worktreeId)).toMatchObject({ label: "Two notes", status: "active", sessionIds: [child.id, parent.id] });
		await service.mergeWorktree(parent.worktreeId);
		for (const id of [parent.id, child.id]) expect(service.get(id)).toMatchObject({ status: "done", outcome: "merged", worktree: "removed" });
		expect(readFileSync(join(project, "faux-notes.md"), "utf8")).toBe("first note\nsecond note\n");
		expect(sh(project, "log", "-1", "--format=%s").trim()).toBe(`studio: worktree ${parent.worktreeId} merged: Two notes`);
		expect(sh(project, "status", "--porcelain")).toBe("");
	});

	it("turns each session from before worktrees into a worktree with the same id, branch and checkout", async () => {
		const legacy = (id: string, extra: Record<string, unknown>) => {
			const dir = join(project, ".studio/sessions", id);
			mkdirSync(dir, { recursive: true });
			const base = sh(project, "rev-parse", "HEAD").trim();
			const record = { id, title: `Old ${id.slice(-4)}`, agentType: "general", target: "project", branch: `studio/${id}`, baseBranch: "main", baseCommit: base, model: "faux/echo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", reviewRequested: false, ...extra };
			writeFileSync(join(dir, "session.json"), JSON.stringify(record));
		};
		// A finished, merged session (its record committed), and an idle one with its checkout still there.
		legacy("20260101-000000-aaaa", { status: "done", worktree: "removed", outcome: "merged" });
		sh(project, "add", "-A");
		sh(project, "commit", "-qm", "old records");
		const open = "20260101-000000-bbbb";
		legacy(open, { status: "idle", worktree: "active", outcome: null });
		const checkout = join(settings.worktreeRoot, "game", open);
		sh(project, "worktree", "add", "-q", "-b", `studio/${open}`, checkout);

		service.load();
		expect(service.get(open)).toMatchObject({ worktreeId: open, worktreeLabel: "Old bbbb", branch: `studio/${open}`, worktreePath: checkout, worktree: "active" });
		expect(service.get("20260101-000000-aaaa")).toMatchObject({ worktreeId: "20260101-000000-aaaa", worktree: "removed" });
		expect(service.listWorktrees().find((w) => w.id === "20260101-000000-aaaa")?.status).toBe("merged");
		expect(JSON.parse(readFileSync(join(project, ".studio/sessions", open, "session.json"), "utf8")).branch).toBeUndefined();
		// The new records are committed with the finished session's (already committed) record.
		await waitFor(() => sh(project, "log", "-1", "--format=%s").startsWith("studio: worktree records"));
		expect(sh(project, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
			".studio/sessions/20260101-000000-aaaa/session.json",
			".studio/worktrees/20260101-000000-aaaa.json",
			`.studio/worktrees/${open}.json`,
		]);
	});

	it("delegates a task to a sub-agent in its worktree and gets its report; only along the graph", async () => {
		const lead1 = await service.create({ agentType: "lead", target: "project", model: "faux/echo", prompt: 'tool delegate {"agentType": "helper", "task": "child note"}' });
		await settled(lead1.id);
		const children = service.list().filter((s) => s.parentId === lead1.id);
		expect(children).toHaveLength(1);
		expect(children[0]).toMatchObject({ agentType: "helper", worktreeId: lead1.worktreeId, status: "idle" });
		expect(readFileSync(join(lead1.worktreePath, "faux-notes.md"), "utf8")).toBe("child note\n");
		// The child's last message comes back as the report.
		const report = JSON.stringify((await service.messages(lead1.id)).at(-1));
		expect(report).toContain("Helper (session");
		expect(report).toContain("Noted: child note");

		// A type outside its edges is refused by the tool's own schema, which lists exactly its edges.
		await service.send(lead1.id, 'tool delegate {"agentType": "general", "task": "x"}');
		await settled(lead1.id);
		expect(JSON.stringify((await service.messages(lead1.id)).at(-1))).toContain('agentType: expected \\"helper\\"');
		expect(service.list().filter((s) => s.parentId === lead1.id)).toHaveLength(1);
		// Sessions without edges get no delegate tool at all.
		const live = (core as unknown as { sessions: Map<string, { session: { getActiveToolNames(): string[] } }> }).sessions;
		expect(live.get(lead1.id)!.session.getActiveToolNames()).toContain("delegate");
		expect(live.get(children[0].id)!.session.getActiveToolNames()).not.toContain("delegate");
		// A type with an empty studioTools list keeps the studio basics but not the generation tools; others get them all.
		expect(live.get(lead1.id)!.session.getActiveToolNames()).toEqual(expect.arrayContaining(["ask_user", "open_in_studio"]));
		expect(live.get(lead1.id)!.session.getActiveToolNames()).not.toContain("generate_concept_images");
		expect(live.get(children[0].id)!.session.getActiveToolNames()).toContain("generate_concept_images");
	}, 30_000);

	it("refuses to merge when the main checkout is on another branch", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "x" });
		await settled(s.id);
		sh(project, "checkout", "-q", "-b", "other");
		await expect(service.merge(s.id)).rejects.toThrow(/switch it to main/);
		expect(service.get(s.id).status).toBe("idle");
	});
});
