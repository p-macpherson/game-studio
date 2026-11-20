// The session orchestrator: owns session records, worktrees and the lifecycle, and drives Pi sessions in
// the session host. See the vault note "Sessions & Worktrees".
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HostEvent, PromptMode, StudioRequestMethod } from "../shared/host";
import type { StudioEvent } from "../shared/ipc";
import type { AgentTypeInfo, NewSessionRequest, PendingQuestion, SessionRecord, SessionSummary, Settings, Target, WorktreeRecord, WorktreeSummary } from "../shared/types";
import { findAgentType } from "../shared/agents";
import * as g from "./git";
import type { HostLink } from "./host-link";
import { type FileChange, type Worktree, WORKTREES_DIR, WorktreeStore } from "./worktrees";

export const SESSIONS_DIR = ".studio/sessions";

export interface SessionServiceDeps {
	host: HostLink;
	settings(): Settings;
	projectPath(): string | null;
	agentTypes(): AgentTypeInfo[];
	skillsDir: string;
	emit(event: StudioEvent): void;
	/** Dispose Pi sessions that have been quiet this long. */
	idleTimeoutMs?: number;
	/** Serves an agent tool's call into the studio (asset generation). `cwd` is the session's worktree. */
	studioRequest?(req: StudioRequest): Promise<unknown>;
	cancelStudioRequest?(requestId: string): void;
}

export interface StudioRequest {
	sessionId: string;
	requestId: string;
	cwd: string;
	method: StudioRequestMethod;
	params: Record<string, unknown>;
	progress(text: string): void;
}

interface Entry {
	record: SessionRecord;
	repoPath: string;
}

const isRunning = (status: SessionRecord["status"]) => status === "in_progress" || status === "starting";

/** The text of the last assistant message in a transcript (a sub-agent's report). */
function lastAssistantText(messages: unknown[]): string {
	for (const m of [...(messages as { role?: string; content?: unknown }[])].reverse()) {
		if (m.role !== "assistant") continue;
		const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "";
		if (text.trim()) return text.trim();
	}
	return "";
}

/** A session record from before worktrees (it had its own branch and checkout). */
type LegacySession = Omit<SessionRecord, "worktreeId"> & { branch?: string; baseBranch?: string; baseCommit: string; worktree?: "active" | "removed" };

export function newSessionId(now = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export class SessionService {
	private readonly entries = new Map<string, Entry>();
	private readonly live = new Set<string>();
	private readonly lastActivity = new Map<string, number>();
	private readonly questions = new Map<string, PendingQuestion>();
	private readonly idleTimer?: NodeJS.Timeout;
	readonly worktrees: WorktreeStore;
	/** A parent's pending `delegate` call → the child session doing it. */
	private readonly delegations = new Map<string, string>();
	/** Called when a session stops running (settles, fails or ends). */
	private readonly settleWaiters = new Map<string, (() => void)[]>();

	constructor(private readonly deps: SessionServiceDeps) {
		this.worktrees = new WorktreeStore({ settings: deps.settings, changed: () => deps.emit({ type: "sessions_changed" }) });
		deps.host.onEvent((e) => this.onHostEvent(e));
		deps.host.onRestart(() => this.onHostRestart());
		if (deps.idleTimeoutMs) this.idleTimer = setInterval(() => this.disposeIdle(), Math.min(deps.idleTimeoutMs, 60_000));
	}

	dispose(): void {
		clearInterval(this.idleTimer);
	}

	// ── repos and records ───────────────────────────────────────────────────────────────────────────

	repoFor(target: Target): string {
		const s = this.deps.settings();
		if (target === "engine") return s.engineRepo;
		if (target === "studio") return s.studioRepo;
		const project = this.deps.projectPath();
		if (!project) throw new Error("No project is open");
		return project;
	}

	private repos(): { target: Target; path: string }[] {
		const out: { target: Target; path: string }[] = [];
		for (const target of ["project", "engine", "studio"] as const) {
			try {
				out.push({ target, path: this.repoFor(target) });
			} catch {
				// no project open
			}
		}
		return out;
	}

	private sessionDir(e: Entry): string {
		return join(e.repoPath, SESSIONS_DIR, e.record.id);
	}

	private worktreeOf(e: Entry): Worktree {
		return this.worktrees.get(e.record.worktreeId);
	}

	worktreePath(e: Entry): string {
		return this.worktrees.path(this.worktreeOf(e));
	}

	private save(e: Entry): void {
		e.record.updatedAt = new Date().toISOString();
		mkdirSync(this.sessionDir(e), { recursive: true });
		writeFileSync(join(this.sessionDir(e), "session.json"), `${JSON.stringify(e.record, null, "\t")}\n`);
		this.deps.emit({ type: "sessions_changed" });
		if (!isRunning(e.record.status)) {
			const waiters = this.settleWaiters.get(e.record.id);
			this.settleWaiters.delete(e.record.id);
			for (const w of waiters ?? []) w();
		}
	}

	/** Resolves once the session isn't running (it settled, failed or ended). */
	private whenSettled(id: string): Promise<void> {
		if (!isRunning(this.entry(id).record.status)) return Promise.resolve();
		return new Promise((resolve) => this.settleWaiters.set(id, [...(this.settleWaiters.get(id) ?? []), resolve]));
	}

	/** The agent types of a session and of every session above it. */
	private chainTypes(e: Entry): Set<string> {
		const types = new Set<string>();
		const all = this.deps.agentTypes();
		for (let x: Entry | undefined = e; x; x = x.record.parentId ? this.entries.get(x.record.parentId) : undefined) {
			types.add(findAgentType(all, x.record.agentType)?.id ?? x.record.agentType);
		}
		return types;
	}

	/** (Re)reads every record from the project, engine and studio repos. Sessions left running become interrupted. */
	load(): void {
		const seen = new Set<string>();
		const repos = this.repos();
		this.worktrees.load(repos);
		for (const { target, path } of repos) {
			const dir = join(path, SESSIONS_DIR);
			if (!existsSync(dir)) continue;
			const migrated: string[] = [];
			for (const id of readdirSync(dir)) {
				const file = join(dir, id, "session.json");
				if (!existsSync(file)) continue;
				const known = this.entries.get(id);
				let record: SessionRecord = known && known.repoPath === path ? known.record : { ...JSON.parse(readFileSync(file, "utf8")), target };
				if (!record.worktreeId) {
					record = this.migrate(record as unknown as LegacySession, path);
					if (record.status === "done") migrated.push(join(SESSIONS_DIR, id));
				}
				const entry = { record, repoPath: path };
				this.entries.set(id, entry);
				seen.add(id);
				if ((record.status === "in_progress" || record.status === "starting") && !this.live.has(id)) {
					record.status = "interrupted";
					this.save(entry);
				}
			}
			// Commit the new worktree records with the records of finished sessions (which were committed already);
			// active sessions' records are committed when they end, as before.
			if (migrated.length) {
				void g.commitPaths(path, [WORKTREES_DIR, ...migrated], "studio: worktree records (one per existing session)").catch((err) => console.error("could not commit migrated records:", err));
			}
		}
		for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
		this.deps.emit({ type: "sessions_changed" });
	}

	/** A record from before worktrees: the session had its own branch and checkout. It becomes a worktree with its id. */
	private migrate(old: LegacySession, repoPath: string): SessionRecord {
		const { branch, baseBranch, baseCommit, worktree, ...rest } = old;
		if (!this.worktrees.find(old.id)) {
			const record: WorktreeRecord = {
				id: old.id,
				label: old.title,
				target: old.target,
				branch: branch ?? `studio/${old.id}`,
				baseBranch: baseBranch ?? "main",
				baseCommit,
				status: old.outcome === "merged" ? "merged" : old.outcome === "discarded" ? "discarded" : "active",
				checkout: worktree === "active" ? "active" : "removed",
				createdAt: old.createdAt,
				updatedAt: old.updatedAt,
			};
			this.worktrees.adopt(record, repoPath);
		}
		const record: SessionRecord = { ...rest, worktreeId: old.id };
		const dir = join(repoPath, SESSIONS_DIR, old.id);
		writeFileSync(join(dir, "session.json"), `${JSON.stringify(record, null, "\t")}\n`);
		return record;
	}

	private entry(id: string): Entry {
		const e = this.entries.get(id);
		if (!e) throw new Error(`Unknown session ${id}`);
		return e;
	}

	list(): SessionSummary[] {
		return [...this.entries.values()]
			.map((e) => {
				const w = this.worktrees.find(e.record.worktreeId);
				return {
					...e.record,
					repoPath: e.repoPath,
					worktreePath: w ? this.worktrees.path(w) : "",
					worktreeLabel: w?.record.label ?? "",
					branch: w?.record.branch ?? "",
					baseBranch: w?.record.baseBranch ?? "",
					worktree: w && this.worktrees.hasCheckout(w) ? ("active" as const) : ("removed" as const),
					live: this.live.has(e.record.id),
					pendingQuestion: this.questions.get(e.record.id),
				};
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	get(id: string): SessionSummary {
		const summary = this.list().find((s) => s.id === id);
		if (!summary) throw new Error(`Unknown session ${id}`);
		return summary;
	}

	// ── creating and driving sessions ───────────────────────────────────────────────────────────────

	async create(req: NewSessionRequest): Promise<SessionSummary> {
		const agentType = findAgentType(this.deps.agentTypes(), req.agentType);
		if (!agentType) throw new Error(`Unknown agent type ${req.agentType}`);
		if (!agentType.targets.includes(req.target)) throw new Error(`${agentType.name} sessions can't target the ${req.target}`);
		const repoPath = this.repoFor(req.target);
		const id = newSessionId();
		const now = new Date().toISOString();
		const title = req.title ?? (req.prompt.split("\n")[0].slice(0, 60) || agentType.name);
		const parent = req.parentId ? this.entry(req.parentId) : undefined;
		// The given worktree, else the parent's (if it's in the same repo), else a new one.
		let worktree = req.worktreeId ? this.worktrees.get(req.worktreeId) : parent && parent.repoPath === repoPath ? this.worktreeOf(parent) : undefined;
		if (worktree && worktree.repoPath !== repoPath) throw new Error(`Worktree "${worktree.record.label}" isn't in the ${req.target} repo`);
		worktree ??= await this.worktrees.create(repoPath, req.target, id, req.worktreeLabel ?? title);
		const entry: Entry = {
			repoPath,
			record: {
				id,
				title,
				agentType: agentType.id,
				target: req.target,
				status: "starting",
				worktreeId: worktree.record.id,
				...(parent ? { parentId: parent.record.id } : {}),
				model: req.model,
				thinking: req.thinking ?? agentType.thinking,
				linkedAsset: req.linkedAsset,
				createdAt: now,
				updatedAt: now,
				outcome: null,
				reviewRequested: false,
			},
		};
		this.entries.set(id, entry);
		this.save(entry);
		try {
			await this.ensureWorktree(entry);
			if (req.prompt.trim()) {
				await this.open(entry);
				this.prompt(entry, req.prompt);
			} else {
				entry.record.status = "idle";
				this.save(entry);
			}
		} catch (err) {
			entry.record.status = "idle";
			entry.record.error = err instanceof Error ? err.message : String(err);
			this.save(entry);
		}
		return this.get(id);
	}

	private preamble(e: Entry, agentType: AgentTypeInfo): string {
		const r = e.record;
		const w = this.worktreeOf(e).record;
		const lines = [
			`You are working inside Game Studio, an agent-driven game development IDE, as a "${agentType.name}" session.`,
			`Target repository: the ${r.target} (${basename(e.repoPath)}). Your working directory is the git worktree "${w.label}" on branch \`${w.branch}\`, created from \`${w.baseBranch}\`. Other sessions may work in it too.`,
			"",
			"- Commit your work on this branch as you go, with clear messages. Never switch branches, rebase, push, or touch the base branch: the user reviews and merges your branch from Game Studio.",
			"- Don't edit anything under `.studio/`; it belongs to Game Studio.",
			"- Call `set_session_title` early with a short title for the task.",
			"- When your work is committed and ready, call `request_review` with a summary.",
			"- Use `ask_user` when you need a decision from the user.",
		];
		const parent = r.parentId ? this.entries.get(r.parentId) : undefined;
		if (parent) {
			const parentType = findAgentType(this.deps.agentTypes(), parent.record.agentType)?.name ?? parent.record.agentType;
			lines.push(`- You are a sub-agent: the ${parentType} session "${parent.record.title}" handed you this task and is waiting for you. Your last message is your report to it: what you did, where it is, and anything left or uncertain.`);
		}
		lines.push("- Other sessions may work in this worktree at the same time: commit only your own files (`git add <paths>`, not `-A`), and if git says index.lock exists, wait a moment and try again.");
		if (r.linkedAsset) {
			lines.push(`- This session was started from \`${r.linkedAsset}\` in Game Studio: that's the asset the user wants to discuss or change.`);
		} else {
			lines.push("- If you create a new asset (a design doc, model, track…), call `open_in_studio` with its path once it exists.");
		}
		lines.push("- To move or rename an asset (or a folder of them), use `move_asset`, not mv: it rewrites every reference to it.");
		const project = this.deps.projectPath();
		if (r.target === "engine" && project) {
			lines.push(
				`- The open game project is at ${project}. Test an engine change against it with \`ENGINE_DIR=${this.worktreePath(e)} ${project}/build.sh test\`.`,
			);
		}
		return lines.join("\n");
	}

	private async open(e: Entry): Promise<void> {
		const agentType = findAgentType(this.deps.agentTypes(), e.record.agentType);
		if (!agentType) throw new Error(`Agent type ${e.record.agentType} no longer exists`);
		const sessionFile = e.record.piSessionFile ? join(this.sessionDir(e), e.record.piSessionFile) : undefined;
		const { sessionFile: file } = await this.deps.host.call("openSession", {
			id: e.record.id,
			cwd: this.worktreePath(e),
			sessionDir: this.sessionDir(e),
			sessionFile: sessionFile && existsSync(sessionFile) ? sessionFile : undefined,
			model: e.record.model,
			thinking: e.record.thinking,
			appendSystemPrompt: [this.preamble(e, agentType), agentType.prompt].filter(Boolean),
			skillPaths: agentType.skills.map((s) => join(this.deps.skillsDir, s)).filter((p) => existsSync(p)),
			delegatesTo: this.delegatesTo(e, agentType),
			...(agentType.studioTools ? { studioTools: agentType.studioTools } : {}),
		});
		this.live.add(e.record.id);
		this.touch(e.record.id);
		if (e.record.piSessionFile !== file) {
			e.record.piSessionFile = file;
			this.save(e);
		}
	}

	/** Who a session may delegate to: its type's edges, minus any type already above it in its chain of sessions. */
	private delegatesTo(e: Entry, agentType: AgentTypeInfo): { id: string; name: string; description: string }[] {
		const chain = this.chainTypes(e);
		const types = this.deps.agentTypes();
		return (agentType.delegatesTo ?? [])
			.filter((id) => !chain.has(id))
			.flatMap((id) => types.filter((t) => t.id === id))
			.map((t) => ({ id: t.id, name: t.name, description: t.description }));
	}

	/**
	 * A parent's `delegate` call: a child session of `agentType` (an edge of the delegation graph, not a type already
	 * above it) working in the parent's worktree, and its last message as the report once it settles.
	 */
	private async delegate(parent: Entry, p: { agentType?: string; task?: string; title?: string }, requestId: string, progress: (text: string) => void): Promise<string> {
		const types = this.deps.agentTypes();
		const parentType = findAgentType(types, parent.record.agentType);
		const type = p.agentType ? findAgentType(types, p.agentType) : undefined;
		if (!type) throw new Error(`There's no agent type "${p.agentType}"`);
		const allowed = parentType ? this.delegatesTo(parent, parentType) : [];
		if (!allowed.some((t) => t.id === type.id)) {
			const why = this.chainTypes(parent).has(type.id) ? `a ${type.name} is already above you in this chain of sub-agents` : `it isn't one of the types you delegate to`;
			throw new Error(`Can't delegate to ${type.name}: ${why} (you can delegate to: ${allowed.map((t) => t.id).join(", ") || "nobody"})`);
		}
		if (!p.task?.trim()) throw new Error("Describe the task");
		// The parent's repo when the type works there; otherwise its own (an Engine Engineer under a game session).
		const target = type.targets.includes(parent.record.target) ? parent.record.target : type.targets[0];
		if (!target) throw new Error(`${type.name} has no repos to work in`);
		// The child's own default model when it's available (a Sonnet specialist under an Opus director), else the parent's.
		const available = new Set((await this.deps.host.call("models").catch(() => [])).map((m) => m.ref));
		const model = type.defaultModel && available.has(type.defaultModel) ? type.defaultModel : parent.record.model;
		const child = await this.create({
			agentType: type.id,
			target,
			model,
			prompt: p.task,
			title: p.title,
			parentId: parent.record.id,
			...(target === parent.record.target ? {} : { worktreeLabel: `${this.worktreeOf(parent).record.label} (${target})` }),
		});
		this.delegations.set(requestId, child.id);
		progress(`${type.name} is working on it in session “${child.title}”`);
		try {
			await this.whenSettled(child.id);
		} finally {
			this.delegations.delete(requestId);
		}
		const done = this.get(child.id);
		if (done.error) return `${type.name} (session “${done.title}”) stopped with an error: ${done.error}`;
		const report = lastAssistantText(await this.messages(child.id));
		return `${type.name} (session “${done.title}”) finished${done.reviewRequested ? " and asked for review" : ""}. Its report:\n\n${report || "(it wrote no report)"}`;
	}

	private async ensureOpen(e: Entry): Promise<void> {
		if (this.live.has(e.record.id)) return;
		await this.ensureWorktree(e);
		await this.open(e);
	}

	private prompt(e: Entry, text: string, mode?: PromptMode): void {
		if (e.record.status === "done") e.record.outcome = null;
		e.record.status = "in_progress";
		e.record.error = undefined;
		this.save(e);
		this.touch(e.record.id);
		void this.deps.host.call("prompt", e.record.id, text, mode).catch((err: Error) => this.fail(e, err.message));
	}

	async send(id: string, text: string, mode?: PromptMode): Promise<void> {
		const e = this.entry(id);
		await this.ensureOpen(e);
		this.prompt(e, text, mode);
	}

	/** Stops a session's agent, and its running sub-agents first. */
	async abort(id: string): Promise<void> {
		for (const c of this.entries.values()) if (c.record.parentId === id && isRunning(c.record.status)) await this.abort(c.record.id);
		if (this.live.has(id)) await this.deps.host.call("abort", id);
	}

	async setModel(id: string, model: string): Promise<void> {
		const e = this.entry(id);
		if (this.live.has(id)) await this.deps.host.call("setModel", id, model);
		e.record.model = model;
		this.save(e);
	}

	async answer(id: string, questionId: string, answer: string): Promise<void> {
		this.questions.delete(id);
		await this.deps.host.call("answerQuestion", id, questionId, answer);
		this.deps.emit({ type: "sessions_changed" });
	}

	async messages(id: string): Promise<unknown[]> {
		const e = this.entry(id);
		if (this.live.has(id)) return this.deps.host.call("messages", id);
		const raw = this.raw(id);
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: { role: string } })
			.filter((entry) => entry.type === "message" && entry.message && entry.message.role !== "system")
			.map((entry) => entry.message as unknown);
	}

	raw(id: string): string {
		const e = this.entry(id);
		if (!e.record.piSessionFile) return "";
		const file = join(this.sessionDir(e), e.record.piSessionFile);
		return existsSync(file) ? readFileSync(file, "utf8") : "";
	}

	/** Changes in the session's worktree since it was made, including uncommitted work. */
	async diff(id: string): Promise<string> {
		return this.worktrees.diff(this.worktreeOf(this.entry(id)));
	}

	/** Files the session's worktree has changed, committed or not. */
	async changedFiles(id: string): Promise<FileChange[]> {
		return this.worktrees.changedFiles(this.worktreeOf(this.entry(id)));
	}

	// ── worktrees ────────────────────────────────────────────────────────────────────────────────────

	listWorktrees(): WorktreeSummary[] {
		const sessions = this.list();
		return this.worktrees
			.all()
			.map((w) => ({ ...w.record, repoPath: w.repoPath, path: this.worktrees.path(w), sessionIds: sessions.filter((s) => s.worktreeId === w.record.id).map((s) => s.id) }))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/** A new, empty worktree of a repo (for work started from the studio's sections). */
	async createWorktree(target: Target, label: string): Promise<WorktreeSummary> {
		const w = await this.worktrees.create(this.repoFor(target), target, newSessionId(), label);
		await this.worktrees.ensureCheckout(w, (dir) => this.initSubmodules(dir));
		return this.listWorktrees().find((x) => x.id === w.record.id)!;
	}

	renameWorktree(id: string, label: string): void {
		this.worktrees.rename(this.worktrees.get(id), label);
	}

	worktreeChangedFiles(id: string): Promise<FileChange[]> {
		return this.worktrees.changedFiles(this.worktrees.get(id));
	}

	worktreeDiff(id: string): Promise<string> {
		return this.worktrees.diff(this.worktrees.get(id));
	}

	private sessionsIn(worktreeId: string): Entry[] {
		return [...this.entries.values()].filter((e) => e.record.worktreeId === worktreeId);
	}

	/** Uncommitted changes in a worktree's checkout (not the studio's records): what a Save commits, or Revert drops. */
	async worktreeUnsaved(id: string): Promise<string[]> {
		const w = this.worktrees.get(id);
		if (!this.worktrees.hasCheckout(w)) return [];
		return (await g.status(this.worktrees.path(w))).files.map((f) => f.path).filter((p) => !p.startsWith(".studio/"));
	}

	/** Commits a worktree's unsaved changes (a person's edits in the sections) as one commit. */
	async saveWorktree(id: string, message: string): Promise<void> {
		const w = this.worktrees.get(id);
		this.assertIdleWorktree(id, "saving");
		const paths = await this.worktreeUnsaved(id);
		if (paths.length) await g.commitPaths(this.worktrees.path(w), paths, message.trim() || "Manual edits");
		w.record.updatedAt = new Date().toISOString();
		this.worktrees.save(w);
		this.deps.emit({ type: "sessions_changed" });
	}

	/** Puts a worktree's unsaved changes back to its last commit (new files removed). */
	async revertWorktree(id: string): Promise<void> {
		const w = this.worktrees.get(id);
		this.assertIdleWorktree(id, "reverting");
		const dir = this.worktrees.path(w);
		const files = (await g.status(dir)).files.filter((f) => !f.path.startsWith(".studio/"));
		const tracked = files.filter((f) => f.index !== "?").map((f) => f.path);
		if (tracked.length) await g.git(dir, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
		for (const f of files.filter((x) => x.index === "?")) rmSync(join(dir, f.path), { force: true });
		w.record.updatedAt = new Date().toISOString();
		this.worktrees.save(w);
		this.deps.emit({ type: "sessions_changed" });
	}

	/** Saving or reverting while an agent works there could take its half-written files: wait for it. */
	private assertIdleWorktree(id: string, doing: string): void {
		const running = this.sessionsIn(id).filter((e) => e.record.status === "in_progress" || e.record.status === "starting");
		if (running.length) throw new Error(`Wait for ${running.map((e) => e.record.title).join(", ")} to finish before ${doing}`);
	}

	/** Merges a worktree's branch into its base; every session in it ends as merged. Unsaved changes must be saved first. */
	async mergeWorktree(id: string): Promise<void> {
		const w = this.worktrees.get(id);
		const sessions = this.sessionsIn(id);
		const running = sessions.filter((e) => e.record.status === "in_progress" || e.record.status === "starting");
		if (running.length) throw new Error(`Stop the agent${running.length > 1 ? "s" : ""} first: ${running.map((e) => e.record.title).join(", ")}`);
		const unsaved = await this.worktreeUnsaved(id);
		if (unsaved.length) throw new Error(`“${w.record.label}” has unsaved changes (${unsaved.length} file${unsaved.length > 1 ? "s" : ""}): save or revert them first`);
		await this.worktrees.merge(w, `${w.record.label}\n\nUncommitted work in worktree ${id}, committed by Game Studio when merging it.`);
		for (const e of sessions) this.end(e, "merged");
		await this.commitRecords(w, sessions, "merged");
	}

	/** Removes a worktree's checkout (its branch stays); every session in it ends as discarded. */
	async discardWorktree(id: string): Promise<void> {
		const w = this.worktrees.get(id);
		const sessions = this.sessionsIn(id);
		for (const e of sessions) if (e.record.status === "in_progress") await this.abort(e.record.id);
		await this.worktrees.discard(w);
		for (const e of sessions) this.end(e, "discarded");
		await this.commitRecords(w, sessions, "discarded");
	}

	// ── lifecycle ────────────────────────────────────────────────────────────────────────────────────

	private assertNotRunning(e: Entry): void {
		if (e.record.status === "in_progress" || e.record.status === "starting") throw new Error("Stop the agent before doing that");
	}

	private close(id: string): void {
		if (!this.live.has(id)) return;
		this.live.delete(id);
		void this.deps.host.call("closeSession", id).catch(() => {});
	}

	private hasWorktree(e: Entry): boolean {
		return this.worktrees.hasCheckout(this.worktreeOf(e));
	}

	/** Makes the session's worktree checkout if it's missing (reopening a merged or discarded worktree). */
	async ensureWorktree(e: Entry): Promise<void> {
		await this.worktrees.ensureCheckout(this.worktreeOf(e), (dir) => this.initSubmodules(dir));
	}

	/** Populates the engine submodule from the local engine repo (no network) and shares its built libraries. */
	private async initSubmodules(wt: string): Promise<void> {
		if (!existsSync(join(wt, ".gitmodules"))) return;
		const engineRepo = this.deps.settings().engineRepo;
		try {
			await g.git(wt, ["-c", "protocol.file.allow=always", "-c", `submodule.engine.url=${engineRepo}`, "submodule", "update", "--init", "-q"]);
		} catch {
			await g.git(wt, ["submodule", "update", "--init", "-q"]);
		}
		await linkEngineLibs(join(wt, "engine"), engineRepo);
	}

	/** Merges the session's worktree (with every other session in it). */
	async merge(id: string): Promise<void> {
		await this.mergeWorktree(this.entry(id).record.worktreeId);
	}

	/** Discards the session's worktree (with every other session in it). */
	async discard(id: string): Promise<void> {
		await this.discardWorktree(this.entry(id).record.worktreeId);
	}

	async markDone(id: string): Promise<void> {
		const e = this.entry(id);
		this.assertNotRunning(e);
		this.close(id);
		e.record.status = "done";
		e.record.reviewRequested = false;
		this.save(e);
		await this.commitRecord(e);
	}

	private end(e: Entry, outcome: "merged" | "discarded"): void {
		this.close(e.record.id);
		this.questions.delete(e.record.id);
		e.record.status = "done";
		e.record.outcome = outcome;
		e.record.reviewRequested = false;
		this.save(e);
	}

	async resume(id: string): Promise<void> {
		const e = this.entry(id);
		await this.ensureWorktree(e);
		if (e.record.status === "done") {
			e.record.status = "idle";
			e.record.outcome = null;
		}
		this.save(e);
	}

	private async commitRecord(e: Entry): Promise<void> {
		const r = e.record;
		try {
			await g.commitPaths(e.repoPath, [join(SESSIONS_DIR, r.id)], `studio: session ${r.id} ${r.outcome ?? "done"}: ${r.title}`);
		} catch (err) {
			console.error(`could not commit session record ${r.id}:`, err);
		}
	}

	private async commitRecords(w: Worktree, sessions: Entry[], outcome: "merged" | "discarded"): Promise<void> {
		const paths = [join(WORKTREES_DIR, `${w.record.id}.json`), ...sessions.map((e) => join(SESSIONS_DIR, e.record.id))];
		try {
			await g.commitPaths(w.repoPath, paths, `studio: worktree ${w.record.id} ${outcome}: ${w.record.label}`);
		} catch (err) {
			console.error(`could not commit the records of worktree ${w.record.id}:`, err);
		}
	}

	/** For "Open in terminal": the host must let go of the transcript while the Pi CLI owns it. */
	async releaseForTerminal(id: string): Promise<{ cwd: string; sessionFile: string }> {
		const e = this.entry(id);
		this.assertNotRunning(e);
		await this.ensureWorktree(e);
		if (!e.record.piSessionFile) throw new Error("This session has no transcript yet");
		this.close(id);
		return { cwd: this.worktreePath(e), sessionFile: join(this.sessionDir(e), e.record.piSessionFile) };
	}

	// ── host events ──────────────────────────────────────────────────────────────────────────────────

	private touch(id: string): void {
		this.lastActivity.set(id, Date.now());
	}

	private fail(e: Entry, error: string): void {
		e.record.status = "idle";
		e.record.error = error;
		this.save(e);
	}

	private onHostEvent(event: HostEvent): void {
		if (event.type === "login_notice" || event.type === "login_prompt") {
			this.deps.emit(event);
			return;
		}
		const e = this.entries.get(event.id);
		if (!e) return;
		this.touch(event.id);
		const r = e.record;
		switch (event.type) {
			case "studio_request": {
				const { requestId } = event;
				const reply = (ok: boolean, value: unknown) => void this.deps.host.call("studioReply", requestId, ok, value).catch(() => {});
				if (event.method === "delegate") {
					const progress = (text: string) => void this.deps.host.call("studioProgress", requestId, text).catch(() => {});
					this.delegate(e, event.params, requestId, progress).then((v) => reply(true, v), (err: Error) => reply(false, err.message));
					break;
				}
				if (!this.deps.studioRequest) {
					reply(false, "This studio can't serve that request");
					break;
				}
				this.deps
					.studioRequest({
						sessionId: r.id,
						requestId,
						cwd: this.worktreePath(e),
						method: event.method,
						params: event.params,
						progress: (text) => void this.deps.host.call("studioProgress", requestId, text).catch(() => {}),
					})
					.then((value) => reply(true, value), (err: Error) => reply(false, err.message));
				break;
			}
			case "studio_request_cancel": {
				// A cancelled delegate call stops its sub-agent.
				const child = this.delegations.get(event.requestId);
				if (child) void this.abort(child).catch(() => {});
				this.deps.cancelStudioRequest?.(event.requestId);
				break;
			}
			case "session_event": {
				this.deps.emit(event);
				const ev = event.event;
				if (ev.type === "agent_start" && r.status !== "in_progress") {
					r.status = "in_progress";
					this.save(e);
				} else if (ev.type === "agent_settled") {
					r.status = "idle";
					this.save(e);
				} else if (ev.type === "message_end") {
					const m = ev.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
					if (m?.role === "assistant" && m.stopReason === "error") {
						r.error = m.errorMessage ?? "The model returned an error";
						this.save(e);
					}
				}
				break;
			}
			case "session_error":
				this.fail(e, event.error);
				break;
			case "studio_tool":
				if (event.tool === "set_session_title") {
					// A worktree made for this session follows its title, unless someone renamed it.
					const w = this.worktrees.find(r.worktreeId);
					if (w && w.record.id === r.id && w.record.label === r.title) this.worktrees.rename(w, event.params.title);
					r.title = event.params.title;
				}
				else if (event.tool === "request_review") r.reviewRequested = true;
				else if (event.tool === "open_in_studio") {
					// A session started to create something adopts the first asset it shows as its own.
					r.linkedAsset ??= event.params.path;
					this.deps.emit({ type: "focus_asset", path: event.params.path, sessionId: r.id });
				}
				this.save(e);
				break;
			case "ask_user":
				this.questions.set(event.id, { questionId: event.questionId, question: event.question, options: event.options });
				this.deps.emit({ type: "sessions_changed" });
				break;
		}
	}

	private onHostRestart(): void {
		this.live.clear();
		this.questions.clear();
		for (const e of this.entries.values()) {
			if (e.record.status === "in_progress" || e.record.status === "starting") {
				e.record.status = "interrupted";
				this.save(e);
			}
		}
	}

	private disposeIdle(): void {
		const cutoff = Date.now() - (this.deps.idleTimeoutMs ?? Infinity);
		for (const id of [...this.live]) {
			const e = this.entries.get(id);
			if (e && e.record.status !== "in_progress" && !this.questions.has(id) && (this.lastActivity.get(id) ?? 0) < cutoff) this.close(id);
		}
	}
}

/**
 * Shares the engine repo's built native libraries with another engine checkout, so it doesn't rebuild them.
 * The engine ignores `/third_party/lib/`, which doesn't match a symlink, so the link is excluded locally.
 */
export async function linkEngineLibs(engineCheckout: string, engineRepo: string): Promise<void> {
	const libs = join(engineRepo, "third_party/lib");
	const target = join(engineCheckout, "third_party/lib");
	if (!existsSync(libs) || !existsSync(join(engineCheckout, "third_party")) || existsSync(target)) return;
	symlinkSync(libs, target);
	const exclude = (await g.git(engineCheckout, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
	mkdirSync(join(exclude, ".."), { recursive: true });
	appendFileSync(exclude, "/third_party/lib\n");
}
