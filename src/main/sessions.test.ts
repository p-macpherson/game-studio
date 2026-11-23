import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitAttachments } from "../shared/attachments";
import type { StudioEvent } from "../shared/ipc";
import type { AgentTypeInfo, NewSessionRequest, Settings } from "../shared/types";
import type { HostCore } from "../session-host/host-core";
import { RESUME_NOTE, SessionService } from "./sessions";
import { RETRY_NOTE } from "../shared/model-errors";
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

	it("is no longer ready for review once the user sends a follow-up", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: `tool request_review ${JSON.stringify({ summary: "Added the cave" })}` });
		await settled(s.id);
		expect(service.get(s.id).reviewRequested).toBe(true);
		await service.send(s.id, "Make the cave smaller");
		expect(service.get(s.id).reviewRequested).toBe(false);
		await settled(s.id);
		expect(service.get(s.id).reviewRequested).toBe(false); // until the agent asks again
	});

	it("sends pasted images to the agent and saves them in the worktree, out of git", async () => {
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; // one pixel
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "like this", images: [{ data: png, mimeType: "image/png" }] } as NewSessionRequest);
		await settled(s.id);
		await service.send(s.id, "", undefined, [{ data: png, mimeType: "image/jpeg" }]);
		await settled(s.id);
		const users = ((await service.messages(s.id)) as { role: string; content: { type: string; text?: string; data?: string }[] }[]).filter((m) => m.role === "user");
		expect(users).toHaveLength(2);
		// The model gets the picture itself, and the words name where it was saved.
		expect(users[0].content.filter((b) => b.type === "image")).toHaveLength(1);
		const first = splitAttachments(users[0].content.find((b) => b.type === "text")!.text!);
		expect(first.text).toBe("like this");
		expect(first.paths).toHaveLength(1);
		expect(first.paths[0]).toMatch(new RegExp(`^\\.studio/attachments/${s.id}/\\d{14}-1\\.png$`));
		const second = splitAttachments(users[1].content.find((b) => b.type === "text")!.text!);
		expect(second.text).toBe("");
		expect(second.paths[0]).toMatch(/-1\.jpg$/);
		const worktree = service.get(s.id).worktreePath;
		expect(readFileSync(join(worktree, first.paths[0])).toString("base64")).toBe(png);
		expect(sh(worktree, "status", "--porcelain", "--untracked-files=all")).not.toContain("attachments");
		await expect(service.send(s.id, "x", undefined, [{ data: png, mimeType: "image/gif" }])).rejects.toThrow("paste a PNG, JPEG or WebP image");
	});

	it("sends a failed review request back to its agent once, then leaves it for the person", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: `tool request_review ${JSON.stringify({ summary: "Added the cave" })}` });
		await settled(s.id);
		expect(await service.bounceReview(s.id, "[Game Studio] it doesn't build")).toBe(true);
		await settled(s.id);
		expect(service.get(s.id).reviewRequested).toBe(false); // back in progress until it asks again
		expect(JSON.stringify(await service.messages(s.id))).toContain("[Game Studio] it doesn't build");
		// It asks again, still broken: this time it stays with the person.
		await service.send(s.id, `tool request_review ${JSON.stringify({ summary: "Fixed" })}`);
		await settled(s.id);
		expect(await service.bounceReview(s.id, "again")).toBe(true); // the person wrote to it in between: one more allowed
		await settled(s.id);
		(service as unknown as { entries: Map<string, { record: { reviewRequested: boolean } }> }).entries.get(s.id)!.record.reviewRequested = true;
		expect(await service.bounceReview(s.id, "and again")).toBe(false);
		expect(service.get(s.id).reviewRequested).toBe(true);
	});

	it("tries a failed request again by itself when the provider is overloaded, and offers Retry when it gives up", async () => {
		const overloaded = '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"}}';
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: `fail 1 ${overloaded}` });
		await waitFor(() => service.get(s.id).status === "idle", 20_000);
		// The second try got through: no error is left on the session.
		expect(service.get(s.id).error).toBeUndefined();
		expect(JSON.stringify((await service.messages(s.id)).at(-1))).toContain("Got through after 1 failed try");

		// An error that trying again by itself won't fix stops the session; Retry has the agent carry on.
		const t = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "fail 1 The request was malformed" });
		await settled(t.id);
		expect(service.get(t.id).error).toBe("The request was malformed");
		await service.retry(t.id);
		await settled(t.id);
		expect(service.get(t.id).error).toBeUndefined();
		const said = JSON.stringify(await service.messages(t.id));
		expect(said).toContain(RETRY_NOTE.slice(0, 60));
		expect(said).toContain("Noted: [Game Studio] Your last request to the model failed");
	}, 40_000);

	it("shows a question's images when they exist in the session's checkout", async () => {
		mkdirSync(join(project, "shots"), { recursive: true });
		writeFileSync(join(project, "shots/map.png"), "png");
		sh(project, "add", "-A");
		sh(project, "commit", "-qm", "a screenshot");
		const s = await service.create({
			agentType: "general",
			target: "project",
			model: "faux/echo",
			prompt: `tool ask_user ${JSON.stringify({ question: "Is the map right?", images: ["shots/map.png", "shots/missing.png"] })}`,
		});
		await waitFor(() => !!service.get(s.id).pendingQuestion);
		expect(service.get(s.id).pendingQuestion).toMatchObject({ question: "Is the map right?", images: ["shots/map.png"] });
	});

	it("opens a game session with the design docs its type works to, as its worktree has them", async () => {
		mkdirSync(join(project, "docs/design"), { recursive: true });
		writeFileSync(join(project, "docs/design/Art Style.md"), "---\nstatus: not-established\n---\n# Art Style\n\n## For now\nGrey boxes only.\n");
		writeFileSync(join(project, "docs/design/Audio Style.md"), "---\nstatus: established\n---\n# Audio Style\n\nAll kazoo.\n\n## Music\nLoud kazoo.\n");
		sh(project, "add", "-A");
		sh(project, "commit", "-qm", "docs");
		const host = await inProcessHost(join(root, "pi-brief"));
		const opened: { appendSystemPrompt: string[] }[] = [];
		const call = host.call.bind(host) as (...a: unknown[]) => unknown;
		(host as unknown as { call: unknown }).call = (method: string, ...args: unknown[]) => {
			if (method === "openSession") opened.push(args[0] as { appendSystemPrompt: string[] });
			return call(method, ...args);
		};
		const artist: AgentTypeInfo = { ...general, id: "artist", name: "Artist", targets: ["project"], designDocs: ["art-style"] };
		const outsider: AgentTypeInfo = { ...general, id: "outsider", name: "Outsider", designDocs: "none" };
		const briefed = new SessionService({ host, settings: () => settings, projectPath: () => project, agentTypes: () => [artist, outsider], skillsDir: join(root, "skills"), emit: () => {} });
		try {
			const s = await briefed.create({ agentType: "artist", target: "project", model: "faux/echo", prompt: "make a rock" });
			await waitFor(() => briefed.get(s.id).status === "idle");
			const brief = opened[0].appendSystemPrompt.join("\n");
			expect(brief).toContain("### Art Style: NOT ESTABLISHED");
			expect(brief).toContain("Grey boxes only.");
			expect(brief).toContain("- **Audio Style**, established (`docs/design/Audio Style.md`): All kazoo.");
			expect(brief).not.toContain("Loud kazoo");
			const o = await briefed.create({ agentType: "outsider", target: "project", model: "faux/echo", prompt: "hello" });
			await waitFor(() => briefed.get(o.id).status === "idle");
			expect(opened[1].appendSystemPrompt.join("\n")).not.toContain("design direction");
		} finally {
			briefed.dispose();
		}
	}, 30_000);

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
		// Its branch is deleted: main has its work; its diff is still there (the merge commit's).
		expect(sh(project, "branch", "--list", s.branch).trim()).toBe("");
		expect(await service.diff(s.id)).toContain("+add a note");

		// Resume recreates the worktree (a new branch from main, which has its work) and the conversation continues.
		await service.resume(s.id);
		expect(service.get(s.id).status).toBe("idle");
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("add a note\n");
		await service.send(s.id, "second note");
		await settled(s.id);
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("add a note\nsecond note\n");
		const messages = (await service.messages(s.id)) as { role: string }[];
		expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
	});

	it("frees a worktree's disk space only when nothing exists only in its folder; selecting it again brings it back", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "a note" });
		await settled(s.id);
		writeFileSync(join(s.worktreePath, "draft.md"), "only here\n");
		expect(await service.worktreeUnloadBlocker(s.worktreeId)).toMatch(/unsaved changes \(1 file\)/);
		await expect(service.unloadWorktree(s.worktreeId)).rejects.toThrow(/unsaved changes/);
		expect(readFileSync(join(s.worktreePath, "draft.md"), "utf8")).toBe("only here\n");
		rmSync(join(s.worktreePath, "draft.md"));
		expect(await service.worktreeUnloadBlocker(s.worktreeId, true)).toMatch(/generation job/);
		expect(await service.worktreeUnloadBlocker(s.worktreeId)).toBeNull();
		expect(await service.worktreeBytes(s.worktreeId)).toBeGreaterThan(0);

		await service.unloadWorktree(s.worktreeId);
		expect(existsSync(s.worktreePath)).toBe(false);
		expect(service.listWorktrees().find((w) => w.id === s.worktreeId)).toMatchObject({ status: "active", checkout: "removed" });
		expect(service.get(s.id).status).toBe("idle");
		await service.loadWorktree(s.worktreeId);
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("a note\n");
	});

	it("deletes the branches of worktrees merged before merging deleted them, when it loads", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "a note" });
		await settled(s.id);
		await service.merge(s.id);
		sh(project, "branch", s.branch, "main"); // as an older studio left it
		service.load();
		await waitFor(() => sh(project, "branch", "--list", s.branch).trim() === "");
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

	it("starts a type that works in another repo as a session of its own, never as a sub-agent", async () => {
		const mech: AgentTypeInfo = { ...general, id: "mech", name: "Mechanic", targets: ["engine"], delegatesTo: [] };
		const boss: AgentTypeInfo = { ...general, id: "boss", name: "Boss", targets: ["project"], delegatesTo: ["mech"], studioTools: [] };
		const svc = new SessionService({ host: await inProcessHost(join(root, "pi-cross")), settings: () => settings, projectPath: () => project, agentTypes: () => [boss, mech], skillsDir: join(root, "skills"), emit: () => {} });
		try {
			const b = await svc.create({ agentType: "boss", target: "project", model: "faux/echo", prompt: 'tool delegate {"agentType": "mech", "task": "engine note", "title": "Cave mesh streaming"}' });
			await waitFor(() => svc.get(b.id).status === "idle");
			const other = svc.list().find((s) => s.agentType === "mech")!;
			// Its worktree is named for what it changes, not after the game's worktree: several can run at once.
			expect(other.worktreeLabel).toBe("Cave mesh streaming");
			await svc.send(b.id, `tool delegate ${JSON.stringify({ agentType: "mech", task: "Rope physics for climbing\nDetails follow" })}`);
			await waitFor(() => svc.list().filter((s) => s.agentType === "mech").length === 2 && svc.get(b.id).status === "idle");
			expect(svc.list().filter((s) => s.agentType === "mech").map((s) => s.worktreeLabel).sort()).toEqual(["Cave mesh streaming", "Rope physics for climbing"]);
			expect(other.parentId).toBeUndefined();
			expect(other.target).toBe("engine");
			expect(other.worktreeId).not.toBe(b.worktreeId);
			expect(JSON.stringify(await svc.messages(b.id))).toContain("can't be your sub-agent");
			await expect(svc.create({ agentType: "mech", target: "engine", model: "faux/echo", prompt: "", parentId: b.id })).rejects.toThrow(/sub-agent works in its parent's worktree/);
		} finally {
			svc.dispose();
		}
	}, 30_000);

	it("resumes an interrupted session with the sub-agents cut off with it, and gives it their reports", async () => {
		const lead1 = await service.create({ agentType: "lead", target: "project", model: "faux/echo", prompt: 'tool delegate {"agentType": "helper", "task": "child note"}' });
		await settled(lead1.id);
		const child = service.list().find((s) => s.parentId === lead1.id)!;
		// An older sub-agent, cut off some other time: not this interruption's, so it is left alone.
		const stale = await service.create({ agentType: "helper", target: "project", model: "faux/echo", prompt: "an old note", parentId: lead1.id });
		await settled(stale.id);
		// As the studio leaves them when it closes mid-work: both cut off at the same moment.
		const entries = (service as unknown as { entries: Map<string, { record: { status: string; interruptedAt?: string } }> }).entries;
		for (const id of [lead1.id, child.id]) Object.assign(entries.get(id)!.record, { status: "interrupted", interruptedAt: "2026-11-22T10:00:00.000Z" });
		Object.assign(entries.get(stale.id)!.record, { status: "interrupted", interruptedAt: "2026-11-01T10:00:00.000Z" });

		await service.resume(lead1.id);
		expect(service.get(lead1.id).status).toBe("in_progress"); // waiting for its sub-agent
		await settled(lead1.id);
		const texts = async (id: string) => ((await service.messages(id)) as { role: string; content: { text?: string }[] | string }[]).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("")));
		// The sub-agent was told to carry on, finished, and is done again.
		expect((await texts(child.id)).at(-1)).toBe(RESUME_NOTE);
		expect(service.get(child.id).status).toBe("done");
		// The lead got the same note with the sub-agent's report, once.
		const told = (await texts(lead1.id)).filter((t) => t.startsWith(RESUME_NOTE));
		expect(told).toHaveLength(1);
		expect(told[0]).toContain("Helper (session");
		expect(told[0]).toContain("Noted: [Game Studio] You were interrupted");
		expect(service.get(lead1.id).status).toBe("idle");
		expect(service.get(stale.id).status).toBe("interrupted");

		// Stop while it waits for a resumed sub-agent: it stops waiting, and isn't prompted afterwards.
		for (const id of [lead1.id, stale.id]) Object.assign(entries.get(id)!.record, { status: "interrupted", interruptedAt: "2026-11-22T11:00:00.000Z" });
		await service.resume(lead1.id);
		await service.abort(lead1.id);
		expect(service.get(lead1.id).status).toBe("idle");
		await settled(stale.id);
		await new Promise((r) => setTimeout(r, 200));
		expect((await texts(lead1.id)).filter((t) => t.startsWith(RESUME_NOTE))).toHaveLength(1);
	});

	it("keeps a sub-agent interrupted (not done) when the session host dies under it and its parent", async () => {
		const lead1 = await service.create({ agentType: "lead", target: "project", model: "faux/echo", prompt: `tool delegate ${JSON.stringify({ agentType: "helper", task: 'tool ask_user {"question": "Which way?"}' })}` });
		await waitFor(() => !!service.list().find((s) => s.parentId === lead1.id)?.pendingQuestion);
		const child = service.list().find((s) => s.parentId === lead1.id)!;
		(service as unknown as { onHostRestart(): void }).onHostRestart();
		await new Promise((r) => setTimeout(r, 200)); // the cut-off delegate call unwinds
		// (The lead isn't checked: this test's host is still alive, so its delegate call's failure reaches it and it carries on.)
		expect(service.get(child.id).status).toBe("interrupted");
		expect(service.get(child.id).interruptedAt).toBeTruthy();
	});

	it("delegates a task to a sub-agent in its worktree and gets its report; only along the graph", async () => {
		const lead1 = await service.create({ agentType: "lead", target: "project", model: "faux/echo", prompt: 'tool delegate {"agentType": "helper", "task": "child note"}' });
		await settled(lead1.id);
		const children = service.list().filter((s) => s.parentId === lead1.id);
		expect(children).toHaveLength(1);
		// Once its report is back, the sub-agent is done (still resumable).
		expect(children[0]).toMatchObject({ agentType: "helper", worktreeId: lead1.worktreeId, status: "done" });
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
		type Live = { session: { getActiveToolNames(): string[]; agent: { state: { tools: { name: string; executionMode?: string }[] } } } };
		const live = (core as unknown as { sessions: Map<string, Live> }).sessions;
		const helper = await service.create({ agentType: "helper", target: "project", model: "faux/echo", prompt: "a helper of its own" });
		await settled(helper.id);
		expect(live.get(lead1.id)!.session.getActiveToolNames()).toContain("delegate");
		expect(live.get(helper.id)!.session.getActiveToolNames()).not.toContain("delegate");
		// A type with an empty studioTools list keeps the studio basics but not the generation tools; others get them all.
		expect(live.get(lead1.id)!.session.getActiveToolNames()).toEqual(expect.arrayContaining(["ask_user", "open_in_studio"]));
		expect(live.get(lead1.id)!.session.getActiveToolNames()).not.toContain("generate_concept_images");
		expect(live.get(helper.id)!.session.getActiveToolNames()).toContain("generate_concept_images");
		// Studio tools make Pi run a turn's calls one by one (a render must not run while bash writes its file);
		// delegations may run side by side.
		const mode = (name: string) => live.get(lead1.id)!.session.agent.state.tools.find((t) => t.name === name)?.executionMode;
		expect(mode("request_review")).toBe("sequential");
		expect(mode("delegate")).toBeUndefined();
	}, 30_000);

	it("keeps a person's edits unsaved until Save commits them; Revert drops them; Merge refuses while any are unsaved", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "x" });
		await settled(s.id);
		writeFileSync(join(s.worktreePath, "faux-notes.md"), "edited by hand\n");
		writeFileSync(join(s.worktreePath, "new.md"), "a new file\n");
		expect((await service.worktreeUnsaved(s.worktreeId)).sort()).toEqual(["faux-notes.md", "new.md"]);
		await expect(service.mergeWorktree(s.worktreeId)).rejects.toThrow(/unsaved changes \(2 files\)/);

		await service.revertWorktree(s.worktreeId);
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("x\n");
		expect(existsSync(join(s.worktreePath, "new.md"))).toBe(false);

		writeFileSync(join(s.worktreePath, "faux-notes.md"), "edited by hand\n");
		await service.saveWorktree(s.worktreeId, "Scene main: set Transform");
		expect(await service.worktreeUnsaved(s.worktreeId)).toEqual([]);
		expect(sh(s.worktreePath, "log", "-1", "--format=%s").trim()).toBe("Scene main: set Transform");
		await service.mergeWorktree(s.worktreeId);
		expect(readFileSync(join(project, "faux-notes.md"), "utf8")).toBe("edited by hand\n");
	});

	it("runs a session on its agent type's default model when none is given", async () => {
		const typed = new SessionService({
			host: await inProcessHost(join(root, "pi2")),
			settings: () => settings,
			projectPath: () => project,
			agentTypes: () => [{ ...general, defaultModel: "faux/echo" }],
			skillsDir: join(root, "skills"),
			emit: () => {},
		});
		try {
			const s = await typed.create({ agentType: "general", target: "project", prompt: "a note" } as NewSessionRequest);
			await waitFor(() => typed.get(s.id).status === "idle");
			expect(typed.get(s.id).model).toBe("faux/echo");
			expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("a note\n");
		} finally {
			typed.dispose();
		}
	});

	it("updates a worktree from main: only its own work counts as its changes; a conflict waits for resolution, blocks merging, and can be aborted", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "worktree note", worktreeLabel: "Notes" });
		await settled(s.id);
		// main moves on: a file the worktree didn't touch.
		writeFileSync(join(project, "from-main.md"), "main's work\n");
		sh(project, "add", "from-main.md");
		sh(project, "commit", "-qm", "Main adds a file");
		expect(await service.worktreeStatus(s.worktreeId)).toEqual({ behind: 1, conflicts: null });
		expect(await service.updateWorktree(s.worktreeId)).toEqual({ commits: 1, conflicts: [] });
		expect(readFileSync(join(s.worktreePath, "from-main.md"), "utf8")).toBe("main's work\n");
		expect((await service.worktreeChangedFiles(s.worktreeId)).map((f) => f.path)).toEqual(["faux-notes.md"]); // not main's file
		expect((await service.worktreeStatus(s.worktreeId)).behind).toBe(0);

		// Both change the same file: a conflict.
		writeFileSync(join(project, "faux-notes.md"), "main's version\n");
		sh(project, "add", "faux-notes.md");
		sh(project, "commit", "-qm", "Main writes the notes too");
		expect(await service.updateWorktree(s.worktreeId)).toEqual({ commits: 1, conflicts: ["faux-notes.md"] });
		expect(await service.worktreeStatus(s.worktreeId)).toEqual({ behind: 1, conflicts: ["faux-notes.md"] });
		await expect(service.mergeWorktree(s.worktreeId)).rejects.toThrow(/being updated from main/);
		const brief = await service.conflictBrief(s.worktreeId);
		for (const part of ["- faux-notes.md", "Main writes the notes too", "worktree note (general", "session.json"]) expect(brief).toContain(part);

		await service.abortWorktreeUpdate(s.worktreeId);
		expect(await service.worktreeStatus(s.worktreeId)).toEqual({ behind: 1, conflicts: null });
		expect(readFileSync(join(s.worktreePath, "faux-notes.md"), "utf8")).toBe("worktree note\n");
	});

	it("follows main's engine (a submodule) when updating, instead of offering to save the old one back", async () => {
		sh(project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", settings.engineRepo, "engine");
		sh(project, "commit", "-qm", "Add the engine");
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "a note" });
		await settled(s.id);
		// The engine moves on, and main updates to it.
		writeFileSync(join(settings.engineRepo, "new.txt"), "engine work\n");
		sh(settings.engineRepo, "add", "new.txt");
		sh(settings.engineRepo, "commit", "-qm", "Engine work");
		const latest = sh(settings.engineRepo, "rev-parse", "HEAD").trim();
		sh(join(project, "engine"), "-c", "protocol.file.allow=always", "fetch", "-q", settings.engineRepo);
		sh(join(project, "engine"), "checkout", "-q", latest);
		sh(project, "commit", "-qam", "Update engine");

		expect(await service.updateWorktree(s.worktreeId)).toEqual({ commits: 1, conflicts: [] });
		expect(await service.worktreeUnsaved(s.worktreeId)).toEqual([]);
		expect(sh(join(s.worktreePath, "engine"), "rev-parse", "HEAD").trim()).toBe(latest);
	});

	it("refuses to merge when the main checkout is on another branch", async () => {
		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "x" });
		await settled(s.id);
		sh(project, "checkout", "-q", "-b", "other");
		await expect(service.merge(s.id)).rejects.toThrow(/switch it to main/);
		expect(service.get(s.id).status).toBe("idle");
	});

	it("loads the rest when a record is unreadable, and reads a transcript whose last line was cut short", async () => {
		const good = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "hello" });
		const bad = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "hello again" });
		await settled(good.id);
		await settled(bad.id);
		// What a crash in the middle of a write used to leave behind.
		writeFileSync(join(project, ".studio/sessions", bad.id, "session.json"), '{"id": "' + bad.id + '", "title": "hel');
		writeFileSync(join(project, ".studio/worktrees", `${bad.worktreeId}.json`), "");
		const transcript = join(project, ".studio/sessions", good.id, good.piSessionFile ?? service.get(good.id).piSessionFile!);
		writeFileSync(transcript, `${readFileSync(transcript, "utf8")}{"type":"message","message":{"role":"assis`);

		const reloaded = new SessionService({ host: await inProcessHost(join(root, "pi2")), settings: () => settings, projectPath: () => project, agentTypes: () => [general], skillsDir: join(root, "skills"), emit: () => {} });
		try {
			reloaded.load();
			expect(reloaded.list().map((s) => s.id)).toEqual([good.id]);
			expect((await reloaded.messages(good.id)).length).toBeGreaterThan(0);
		} finally {
			reloaded.dispose();
		}
	}, 30_000);

	it("keeps transcripts out of git, and archives work a week after it closed, by worktree", async () => {
		// A transcript committed before they were ignored (an older studio's): untracked when the studio loads.
		mkdirSync(join(project, ".studio/sessions/old"), { recursive: true });
		writeFileSync(join(project, ".studio/sessions/old/2026.jsonl"), "{}\n");
		sh(project, "add", "-f", ".studio/sessions/old/2026.jsonl");
		sh(project, "commit", "-q", "-m", "an old transcript");

		const s = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "add a note" });
		await settled(s.id);
		const other = await service.create({ agentType: "general", target: "project", model: "faux/echo", prompt: "still going" });
		await settled(other.id);
		await service.merge(s.id);
		service.load();
		await service.tidied();
		const tracked = () => sh(project, "ls-files", ".studio").trim().split("\n");
		expect(tracked()).toContain(`.studio/sessions/${s.id}/session.json`);
		expect(tracked().filter((p) => p.endsWith(".jsonl"))).toEqual([]);
		expect(existsSync(join(project, ".studio/sessions/old/2026.jsonl"))).toBe(true); // only untracked, not deleted
		const transcriptName = service.get(s.id).piSessionFile!;
		expect(existsSync(join(project, ".studio/sessions", s.id, transcriptName))).toBe(true);
		expect(sh(project, "status", "--porcelain", "--", `.studio/sessions/${s.id}`)).toBe("");

		// Nothing is archived while it's recent.
		expect(service.listArchived()).toEqual([]);

		// A week later (here: at once): the merged worktree and its session go; the open one stays.
		const later = new SessionService({ host: await inProcessHost(join(root, "pi3")), settings: () => settings, projectPath: () => project, agentTypes: () => [general], skillsDir: join(root, "skills"), emit: () => {}, archiveAfterMs: 0 });
		try {
			later.load();
			await later.tidied();
			expect(later.list().map((x) => x.id)).toEqual([other.id]);
			expect(later.listArchived().map((x) => x.id)).toEqual([s.id]);
			expect(later.listArchived()[0].worktreeLabel).toBe("add a note");
			expect(tracked().some((p) => p.includes(s.id))).toBe(false);
			expect(sh(project, "status", "--porcelain", "--", ".studio")).not.toContain(s.id); // the removal is committed
			expect(existsSync(join(project, ".studio/archive/sessions", s.id, transcriptName))).toBe(true);

		} finally {
			later.dispose();
		}

		// Restoring (in a studio with the usual week) brings back the session, its worktree's record and its transcript;
		// it counts as closed now, so it stays, and it can be resumed.
		await service.restore(s.id);
		await service.tidied();
		expect(service.get(s.id).status).toBe("done");
		expect(service.listArchived()).toEqual([]);
		expect((await service.messages(s.id)).length).toBeGreaterThan(0);
		await service.resume(s.id);
		expect(service.get(s.id).worktree).toBe("active");
	}, 30_000);
});
