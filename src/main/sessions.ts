// The session orchestrator: owns session records, worktrees and the lifecycle, and drives Pi sessions in
// the session host. See the vault note "Sessions & Worktrees".
import { ATTACHMENTS_DIR, MAX_PASTED_IMAGES, PASTED_IMAGE_TYPES, type PastedImage, withAttachments } from "../shared/attachments";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { designBrief } from "../shared/design-docs";
import { readDesignDocs } from "./design-docs";
import { delegateModel, delegateOptions } from "../shared/agent-models";
import type { DelegateTarget, HostEvent, PromptMode, StudioRequestMethod } from "../shared/host";
import type { StudioEvent } from "../shared/ipc";
import { RESUME_NOTE } from "../shared/types";
import { SCENARIO_DIR } from "../shared/scenario";
import { RETRY_NOTE } from "../shared/model-errors";
import type { AgentTypeInfo, ContextUsage, GitCommit, NewSessionRequest, PendingQuestion, SessionRecord, SessionSummary, Settings, Target, WorktreeRecord, WorktreeSummary } from "../shared/types";
import { findAgentType } from "../shared/agents";
import * as g from "./git";
import type { HostLink } from "./host-link";
import { writeFileAtomic, writeJsonAtomic } from "./json-file";
import { type FileChange, type Worktree, WORKTREES_DIR, WorktreeStore } from "./worktrees";

export const SESSIONS_DIR = ".studio/sessions";
/** Where the records and transcripts of work closed long ago go: in the repo's folder, out of git. */
export const ARCHIVE_DIR = ".studio/archive";
const ARCHIVE_AFTER_MS = 7 * 24 * 3600_000;
export const STUDIO_IGNORE_FILE = ".studio/.gitignore";
/**
 * What is tracked: the small records of open and recently closed work. What isn't: transcripts (large, and a log of
 * the work rather than part of the game), and everything closed more than a week ago.
 */
export const STUDIO_IGNORE = `# Game Studio keeps these on this machine, out of git: sessions' transcripts (large, and a log of the work rather
# than part of the game), and the records of work closed more than a week ago.
sessions/*/*.jsonl
archive/
*.tmp
`;

/** Writes the repo's `.studio/.gitignore` if it is missing or out of date. */
export function ensureStudioIgnore(repoPath: string): void {
	const file = join(repoPath, STUDIO_IGNORE_FILE);
	if (existsSync(file) && readFileSync(file, "utf8") === STUDIO_IGNORE) return;
	mkdirSync(join(repoPath, ".studio"), { recursive: true });
	writeFileAtomic(file, STUDIO_IGNORE);
}

export interface SessionServiceDeps {
	host: HostLink;
	settings(): Settings;
	projectPath(): string | null;
	agentTypes(): AgentTypeInfo[];
	skillsDir: string;
	emit(event: StudioEvent): void;
	/** Dispose Pi sessions that have been quiet this long. */
	idleTimeoutMs?: number;
	/** Archive work closed this long ago (default: seven days). */
	archiveAfterMs?: number;
	/** Serves an agent tool's call into the studio (asset generation). `cwd` is the session's worktree. */
	studioRequest?(req: StudioRequest): Promise<unknown>;
	cancelStudioRequest?(requestId: string): void;
	/** A session asked for review (its work is committed): the studio checks the worktree itself. */
	reviewRequested?(session: SessionSummary): void;
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

export { RESUME_NOTE };

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
	/** Sessions being resumed that still wait for their resumed sub-agents (Stop ends the wait). */
	private readonly resuming = new Map<string, { cancelled: boolean }>();
	/** Sessions being interrupted because the studio is leaving their project (see leaveProject). */
	private readonly leaving = new Set<string>();
	/** Called when a session stops running (settles, fails or ends). */
	private readonly settleWaiters = new Map<string, (() => void)[]>();
	/** Repos whose `.studio/.gitignore` has been checked this run. */
	private readonly ignoreChecked = new Set<string>();
	private housekeeping: Promise<void> = Promise.resolve();

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
		// Before a transcript can exist: it must never be staged.
		if (!this.ignoreChecked.has(e.repoPath)) {
			ensureStudioIgnore(e.repoPath);
			this.ignoreChecked.add(e.repoPath);
		}
		mkdirSync(this.sessionDir(e), { recursive: true });
		writeJsonAtomic(join(this.sessionDir(e), "session.json"), e.record);
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
		const cutOff = new Date().toISOString();
		const repos = this.repos();
		this.worktrees.load(repos);
		// Branches of worktrees merged before merging deleted them (`git branch -d`: only fully merged ones).
		void this.worktrees.deleteMergedBranches().catch((err) => console.error("could not delete merged branches:", err));
		for (const { target, path } of repos) {
			const dir = join(path, SESSIONS_DIR);
			if (!existsSync(dir)) continue;
			const migrated: string[] = [];
			for (const id of readdirSync(dir)) {
				const file = join(dir, id, "session.json");
				if (!existsSync(file)) continue;
				const known = this.entries.get(id);
				let record: SessionRecord;
				try {
					record = known && known.repoPath === path ? known.record : { ...JSON.parse(readFileSync(file, "utf8")), target };
					if (!record.worktreeId) {
						record = this.migrate(record as unknown as LegacySession, path);
						if (record.status === "done") migrated.push(join(SESSIONS_DIR, id));
					}
				} catch (err) {
					// One unreadable record (a crash mid-write, a bad merge) mustn't stop the studio loading the rest, or starting.
					console.error(`skipping session record ${file}:`, err);
					continue;
				}
				const entry = { record, repoPath: path };
				this.entries.set(id, entry);
				seen.add(id);
				if ((record.status === "in_progress" || record.status === "starting") && !this.live.has(id)) {
					record.status = "interrupted";
					record.interruptedAt = cutOff;
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
		this.housekeeping = this.housekeeping.then(() => this.tidy(repos.map((r) => r.path))).catch((err) => console.error("session housekeeping failed:", err));
	}

	/** Resolves when the housekeeping the latest `load` started (untracking transcripts, archiving old work) is done. */
	tidied(): Promise<void> {
		return this.housekeeping;
	}

	private async tidy(repoPaths: string[]): Promise<void> {
		let archived = 0;
		for (const path of repoPaths) {
			if (!existsSync(join(path, ".studio"))) continue;
			try {
				ensureStudioIgnore(path);
				this.ignoreChecked.add(path);
				// Transcripts committed before they were ignored: out of the index (history keeps what it has).
				const tracked = (await g.git(path, ["ls-files", "--", `${SESSIONS_DIR}/*/*.jsonl`])).split("\n").filter(Boolean);
				if (tracked.length) await g.untrack(path, tracked, [STUDIO_IGNORE_FILE], "studio: session transcripts stay on this machine, out of git");
				archived += await this.archiveOld(path);
			} catch (err) {
				console.error(`session housekeeping in ${path}:`, err);
			}
		}
		if (archived) this.deps.emit({ type: "sessions_changed" });
	}

	/**
	 * Moves work closed more than a week ago into the repo's archive folder (ignored by git) and commits the removal of
	 * its records. Work is archived by worktree: its record and every session in it together, once the worktree is
	 * merged or discarded and all of them are done. Returns how many sessions and worktrees moved.
	 */
	private async archiveOld(repoPath: string): Promise<number> {
		const after = this.deps.archiveAfterMs ?? ARCHIVE_AFTER_MS;
		const groups = new Map<string, Entry[]>();
		for (const w of this.worktrees.all()) if (w.repoPath === repoPath) groups.set(w.record.id, []);
		for (const e of this.entries.values()) if (e.repoPath === repoPath) groups.set(e.record.worktreeId, [...(groups.get(e.record.worktreeId) ?? []), e]);
		const moved: string[] = [];
		const move = (path: string) => {
			const to = join(repoPath, ARCHIVE_DIR, path.slice(".studio/".length));
			rmSync(to, { recursive: true, force: true });
			mkdirSync(join(to, ".."), { recursive: true });
			renameSync(join(repoPath, path), to);
			moved.push(path);
		};
		for (const [id, sessions] of groups) {
			const w = this.worktrees.find(id);
			if (w && (w.repoPath !== repoPath || w.record.status === "active")) continue;
			if (sessions.some((e) => e.record.status !== "done" || this.live.has(e.record.id))) continue;
			const closed = [w?.record.updatedAt, ...sessions.map((e) => e.record.closedAt ?? e.record.updatedAt)].flatMap((t) => (t ? [Date.parse(t)] : []));
			if (!closed.length || Date.now() - Math.max(...closed) < after) continue;
			for (const e of sessions) {
				move(join(SESSIONS_DIR, e.record.id));
				this.entries.delete(e.record.id);
			}
			if (w) {
				move(join(WORKTREES_DIR, `${id}.json`));
				this.worktrees.forget(id);
			}
		}
		if (!moved.length) return 0;
		const tracked = (await g.git(repoPath, ["ls-files", "--", ...moved])).split("\n").filter(Boolean);
		if (tracked.length) await g.commitPaths(repoPath, tracked, `studio: archived ${moved.length} record${moved.length > 1 ? "s" : ""} of work closed over a week ago`);
		return moved.length;
	}

	/** Archived sessions of every repo, newest first: read from the archive folders when asked for, never at startup. */
	listArchived(): SessionSummary[] {
		const out: SessionSummary[] = [];
		const read = <T>(file: string): T | null => {
			try {
				return JSON.parse(readFileSync(file, "utf8")) as T;
			} catch {
				return null;
			}
		};
		for (const { target, path } of this.repos()) {
			const dir = join(path, ARCHIVE_DIR, "sessions");
			if (!existsSync(dir)) continue;
			for (const id of readdirSync(dir)) {
				const record = read<SessionRecord>(join(dir, id, "session.json"));
				if (!record) continue;
				const w = read<WorktreeRecord>(join(path, ARCHIVE_DIR, "worktrees", `${record.worktreeId}.json`));
				out.push({ ...record, target, repoPath: path, worktreePath: "", worktreeLabel: w?.label ?? "", branch: w?.branch ?? "", baseBranch: w?.baseBranch ?? "", worktree: "removed", live: false, archived: true });
			}
		}
		return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	/** Brings an archived session back into the studio, with its worktree's record and the sessions archived with it. */
	async restore(id: string): Promise<void> {
		const found = this.listArchived().find((s) => s.id === id);
		if (!found) throw new Error(`No archived session ${id}`);
		const { repoPath, worktreeId } = found;
		const back = (path: string) => {
			const from = join(repoPath, ARCHIVE_DIR, path.slice(".studio/".length));
			if (!existsSync(from)) return;
			mkdirSync(join(repoPath, path, ".."), { recursive: true });
			renameSync(from, join(repoPath, path));
		};
		const together = this.listArchived().filter((s) => s.repoPath === repoPath && s.worktreeId === worktreeId);
		back(join(WORKTREES_DIR, `${worktreeId}.json`));
		for (const s of together) back(join(SESSIONS_DIR, s.id));
		this.load();
		// Closed as of now, so it isn't archived again the next time the studio tidies (no await before this: load's
		// housekeeping hasn't started yet).
		const now = new Date().toISOString();
		for (const s of together) {
			const e = this.entries.get(s.id);
			if (!e) continue;
			e.record.closedAt = now;
			this.save(e);
		}
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
		writeJsonAtomic(join(dir, "session.json"), record);
		return record;
	}

	private entry(id: string): Entry {
		const e = this.entries.get(id);
		if (!e) throw new Error(`Unknown session ${id}`);
		return e;
	}

	private summary(e: Entry): SessionSummary {
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
	}

	list(): SessionSummary[] {
		return [...this.entries.values()].map((e) => this.summary(e)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	get(id: string): SessionSummary {
		return this.summary(this.entry(id));
	}

	/** The folder of a checked-out worktree, by its id or by the id of a session working in it. */
	checkoutPath(id: string): string {
		const w = this.worktrees.find(id) ?? this.worktrees.find(this.entries.get(id)?.record.worktreeId ?? "");
		if (!w) throw new Error(`Unknown session ${id}`);
		if (w.record.checkout !== "active") throw new Error(`Worktree "${w.record.label}" isn't checked out; reopen it first`);
		return this.worktrees.path(w);
	}

	// ── creating and driving sessions ───────────────────────────────────────────────────────────────

	async create(req: NewSessionRequest): Promise<SessionSummary> {
		const agentType = findAgentType(this.deps.agentTypes(), req.agentType);
		if (!agentType) throw new Error(`Unknown agent type ${req.agentType}`);
		// No model given (an API caller rather than the New Session dialog): like the dialog, the type's own default when
		// it's available, else the first available model.
		let model = req.model;
		if (!model) {
			const available = (await this.deps.host.call("models").catch(() => [])).map((m) => m.ref);
			model = agentType.defaultModel && (available.includes(agentType.defaultModel) || !available.length) ? agentType.defaultModel : available[0];
		}
		if (!model) throw new Error(`No model given, and ${agentType.name} has no default model`);
		if (!agentType.targets.includes(req.target)) throw new Error(`${agentType.name} sessions can't target the ${req.target}`);
		const repoPath = this.repoFor(req.target);
		const id = newSessionId();
		const now = new Date().toISOString();
		const title = req.title ?? (req.prompt.split("\n")[0].slice(0, 60) || agentType.name);
		const parent = req.parentId ? this.entry(req.parentId) : undefined;
		// A sub-agent works in its parent's worktree, always: work in another repo is a session of its own (see delegate).
		if (parent && parent.repoPath !== repoPath) throw new Error(`A sub-agent works in its parent's worktree: a ${req.target} session can't be a sub-agent of a ${parent.record.target} session`);
		if (parent && req.worktreeId && req.worktreeId !== parent.record.worktreeId) throw new Error("A sub-agent works in its parent's worktree");
		// The given worktree, else the parent's, else a new one.
		let worktree = req.worktreeId ? this.worktrees.get(req.worktreeId) : parent ? this.worktreeOf(parent) : undefined;
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
				model,
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
			if (req.prompt.trim() || req.images?.length) {
				await this.open(entry);
				this.prompt(entry, this.attach(entry, req.prompt, req.images), undefined, req.images);
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
			"- When your work is committed and ready, call `request_review` with a summary, what to look at, and pictures of the change when you can make them.",
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
		lines.push("- When you mention an asset or file of the game to the user, write its repo path (`assets/models/barrel/model.json`): Game Studio turns it into a link with a preview, and lists what each turn made or changed under your reply.");
		lines.push("- To move or rename an asset (or a folder of them), use `move_asset`, not mv: it rewrites every reference to it.");
		const project = this.deps.projectPath();
		if (r.target === "engine" && project) {
			lines.push(
				`- The open game project is at ${project}. Test an engine change against it with \`ENGINE_DIR=${this.worktreePath(e)} ${project}/build.sh test\`.`,
			);
		}
		return lines.join("\n");
	}

	/** The game's design direction for a session on the game, read from its worktree each time it opens (so it's current). */
	private designBrief(e: Entry, agentType: AgentTypeInfo): string {
		if (e.record.target !== "project" || agentType.designDocs === "none") return "";
		return designBrief(readDesignDocs(this.worktreePath(e)), agentType.designDocs ?? ["game-brief"]);
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
			appendSystemPrompt: [this.preamble(e, agentType), agentType.prompt, this.designBrief(e, agentType)].filter(Boolean),
			skillPaths: agentType.skills.map((s) => join(this.deps.skillsDir, s)).filter((p) => existsSync(p)),
			delegatesTo: await this.delegateTargets(e, agentType),
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
	private delegatesTo(e: Entry, agentType: AgentTypeInfo): AgentTypeInfo[] {
		const chain = this.chainTypes(e);
		const types = this.deps.agentTypes();
		return (agentType.delegatesTo ?? []).filter((id) => !chain.has(id)).flatMap((id) => types.filter((t) => t.id === id));
	}

	/** The same, as the `delegate` tool describes them: with each type's usual model and the others it may be started on now. */
	private async delegateTargets(e: Entry, agentType: AgentTypeInfo): Promise<DelegateTarget[]> {
		const to = this.delegatesTo(e, agentType);
		if (!to.length) return [];
		const available = await this.availableModels();
		return to.map((t) => {
			const models = delegateOptions(t, available);
			return { id: t.id, name: t.name, description: t.description, ...(models.length ? { defaultModel: delegateModel(t, e.record.model, available), models } : {}) };
		});
	}

	private async availableModels(): Promise<Set<string>> {
		return new Set((await this.deps.host.call("models").catch(() => [])).map((m) => m.ref));
	}

	/**
	 * A parent's `delegate` call: a child session of `agentType` (an edge of the delegation graph, not a type already
	 * above it) working in the parent's worktree, and its last message as the report once it settles. A type that
	 * works in another repo (an Engine Engineer asked by a game session) can't share that worktree, so it isn't a
	 * sub-agent: it starts as a session of its own in a new worktree of its repo, and the call returns at once, without
	 * a report. A person coordinates between the two worktrees (merge one, update the engine in the other).
	 */
	private async delegate(parent: Entry, p: { agentType?: string; task?: string; title?: string; model?: string }, requestId: string, progress: (text: string) => void): Promise<string> {
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
		// The child's own default model when it's available (a Sonnet specialist under an Opus director), else the parent's;
		// or the one the parent asked for, when the type allows it (Settings → Agents).
		const model = delegateModel(type, parent.record.model, await this.availableModels(), p.model?.trim() || undefined);
		if (target !== parent.record.target) {
			const from = this.worktreeOf(parent).record.label;
			const title = p.title?.trim() || p.task.split("\n")[0].slice(0, 60).trim() || type.name;
			const other = await this.create({
				agentType: type.id,
				target,
				model,
				prompt: `[Asked for by the ${parentType?.name ?? parent.record.agentType} session “${parent.record.title}”, which works on the ${parent.record.target} in its worktree “${from}”. It isn't waiting for you and gets no report: the user coordinates between the two worktrees.]\n\n${p.task}`,
				title,
				// Named for what it changes (the session's title, which it follows when the agent retitles it), not after the
				// asking worktree: several can be running at once.
				worktreeLabel: title,
			});
			return [
				`${type.name} works in the ${target} repo, not in your worktree, so it can't be your sub-agent. It was started as a separate session, “${other.title}”, in its own ${target} worktree “${other.worktreeLabel}”.`,
				`It runs on its own: you get no report from it, and nothing it does reaches your worktree until the user merges that worktree${target === "engine" ? " and updates the engine in yours" : ""}.`,
				"Tell the user what you asked it for and what you need back, carry on with whatever doesn't depend on it, and ask the user (ask_user) when you can't go further without it.",
			].join(" ");
		}
		const child = await this.create({ agentType: type.id, target, model, prompt: p.task, title: p.title, parentId: parent.record.id });
		this.delegations.set(requestId, child.id);
		progress(`${type.name} is working on it in session “${child.title}”`);
		try {
			await this.whenSettled(child.id);
		} finally {
			this.delegations.delete(requestId);
		}
		const done = this.get(child.id);
		// Cut off with its parent (the session host died): it stays as it is, to be resumed with the parent.
		if (done.status === "interrupted") throw new Error(`${type.name} (session “${done.title}”) was interrupted`);
		const report = done.error ? "" : lastAssistantText(await this.messages(child.id));
		// Its job ends with its report (the parent retries or delegates again if needed): mark it done, so finished
		// sub-agents don't pile up as idle. A person can still open and resume it.
		await this.markDone(child.id).catch(() => {});
		if (done.error) return `${type.name} (session “${done.title}”) stopped with an error: ${done.error}`;
		return `${type.name} (session “${done.title}”) finished${done.reviewRequested ? " and asked for review" : ""}. Its report:\n\n${report || "(it wrote no report)"}`;
	}

	/** A one-off question to an agent: starts the session, waits for it to finish, returns its last words, marks it done. */
	async ask(req: NewSessionRequest, started?: (session: SessionSummary) => void): Promise<string> {
		const s = await this.create(req);
		started?.(s);
		await this.whenSettled(s.id);
		const done = this.get(s.id);
		if (done.status === "interrupted") throw new Error(`“${done.title}” was interrupted`);
		if (done.error) throw new Error(done.error);
		const reply = lastAssistantText(await this.messages(s.id));
		await this.markDone(s.id).catch(() => {});
		return reply;
	}

	private async ensureOpen(e: Entry): Promise<void> {
		if (this.live.has(e.record.id)) return;
		await this.ensureWorktree(e);
		await this.open(e);
	}

	/**
	 * Saves a message's pasted images in the session's worktree (a folder that ignores itself: never part of the game)
	 * and returns the message as the agent gets it, naming those files.
	 */
	private attach(e: Entry, text: string, images?: PastedImage[]): string {
		if (!images?.length) return text;
		if (images.length > MAX_PASTED_IMAGES) throw new Error(`At most ${MAX_PASTED_IMAGES} images in one message`);
		const root = join(this.worktreePath(e), ATTACHMENTS_DIR);
		const dir = join(root, e.record.id);
		mkdirSync(dir, { recursive: true });
		if (!existsSync(join(root, ".gitignore"))) writeFileSync(join(root, ".gitignore"), "# Images pasted into sessions: kept on this machine, not part of the game.\n*\n");
		const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
		const paths = images.map((image, i) => {
			const ext = PASTED_IMAGE_TYPES[image.mimeType];
			if (!ext) throw new Error(`Can't attach a ${image.mimeType || "file of unknown type"}: paste a PNG, JPEG or WebP image`);
			const bytes = Buffer.from(image.data, "base64");
			if (bytes.length > 12 * 1024 * 1024) throw new Error("A pasted image is too large (over 12 MB)");
			const name = `${stamp}-${i + 1}.${ext}`;
			writeFileSync(join(dir, name), bytes);
			return `${ATTACHMENTS_DIR}/${e.record.id}/${name}`;
		});
		return withAttachments(text, paths);
	}

	private prompt(e: Entry, text: string, mode?: PromptMode, images?: PastedImage[]): void {
		if (e.record.status === "done") e.record.outcome = null;
		e.record.closedAt = undefined;
		e.record.status = "in_progress";
		// A follow-up (feedback after a review, say) puts the work back in progress: the agent asks again when it's done.
		e.record.reviewRequested = false;
		e.record.error = undefined;
		this.save(e);
		this.touch(e.record.id);
		void this.deps.host.call("prompt", e.record.id, text, mode, images).catch((err: Error) => this.fail(e, err.message));
	}

	/**
	 * Sends a review request back to its agent by the studio itself (its work failed the checks), at most once until a
	 * person writes to the session again, so an agent that can't fix it reaches the person instead of looping.
	 * Returns whether it was sent.
	 */
	async bounceReview(id: string, text: string): Promise<boolean> {
		const e = this.entry(id);
		if (!e.record.reviewRequested || e.record.status === "done" || (e.record.reviewBounces ?? 0) >= 1) return false;
		await this.ensureOpen(e);
		e.record.reviewBounces = (e.record.reviewBounces ?? 0) + 1;
		this.prompt(e, text);
		return true;
	}

	async send(id: string, text: string, mode?: PromptMode, images?: PastedImage[]): Promise<void> {
		const e = this.entry(id);
		e.record.reviewBounces = undefined; // a person's message: the studio may send the next failure back again
		await this.ensureOpen(e);
		this.prompt(e, this.attach(e, text, images), mode, images);
	}

	/** Tries again after a request to the model failed: the agent is told to carry on from where it left off. */
	async retry(id: string): Promise<void> {
		const e = this.entry(id);
		this.assertNotRunning(e);
		await this.ensureOpen(e);
		this.prompt(e, RETRY_NOTE);
	}

	/**
	 * Before the studio leaves the open project (another is opened, or it's closed): the game's sessions that are
	 * working are interrupted, exactly as when the studio closes mid-work, so that coming back offers Resume for them
	 * (and their sub-agents). Without this their agents would run on unheard: nothing they asked the studio for would
	 * be answered, and nothing they did recorded. Engine and studio sessions belong to no project and carry on.
	 */
	async leaveProject(): Promise<void> {
		const ours = [...this.entries.values()].filter((e) => e.record.target === "project");
		const running = ours.filter((e) => isRunning(e.record.status));
		const cutOff = new Date().toISOString();
		// From here their agents' events change nothing: stopping an agent reports it as settled, which isn't how it stands.
		for (const e of ours) this.leaving.add(e.record.id);
		try {
			// All marked before any is saved: saving wakes whoever waits for a session, who must find its parent cut off too.
			for (const e of running) {
				e.record.status = "interrupted";
				e.record.interruptedAt = cutOff;
				const wait = this.resuming.get(e.record.id);
				if (wait) wait.cancelled = true;
				this.resuming.delete(e.record.id);
				this.questions.delete(e.record.id);
			}
			for (const e of running) this.save(e);
			for (const e of running) if (this.live.has(e.record.id)) await this.deps.host.call("abort", e.record.id).catch(() => {});
			for (const e of ours) this.close(e.record.id);
		} finally {
			for (const e of ours) this.leaving.delete(e.record.id);
		}
	}

	/** Stops a session's agent, and its running sub-agents first. */
	async abort(id: string): Promise<void> {
		// One being resumed that still waits for its sub-agents has no agent running yet: it just stops waiting.
		const wait = this.resuming.get(id);
		if (wait) wait.cancelled = true;
		this.resuming.delete(id);
		for (const c of this.entries.values()) if (c.record.parentId === id && isRunning(c.record.status)) await this.abort(c.record.id);
		if (wait) {
			const e = this.entry(id);
			if (isRunning(e.record.status)) {
				e.record.status = "idle";
				this.save(e);
			}
			return;
		}
		if (this.live.has(id)) await this.deps.host.call("abort", id);
	}

	/**
	 * Carries on a session that was cut off mid-work, and the sub-agents cut off with it. The sub-agents go first (each
	 * with its own, the same way); once they have all stopped, the session is told it was interrupted and given their
	 * reports, which its cut-off `delegate` calls never returned. Returns once everything is started.
	 */
	private async resumeInterrupted(e: Entry): Promise<void> {
		const children = [...this.entries.values()].filter((c) => c.record.parentId === e.record.id && c.record.status === "interrupted" && c.record.interruptedAt === e.record.interruptedAt);
		await this.ensureOpen(e);
		if (!children.length) return this.prompt(e, RESUME_NOTE);
		const wait = { cancelled: false };
		this.resuming.set(e.record.id, wait);
		e.record.status = "in_progress"; // waiting for its sub-agents, as it was when it was cut off
		e.record.error = undefined;
		this.save(e);
		this.touch(e.record.id);
		for (const c of children) await this.resumeInterrupted(c).catch((err: Error) => this.fail(c, err.message));
		void this.resumeAfter(e, children, wait).catch((err: Error) => this.fail(e, err.message));
	}

	private async resumeAfter(e: Entry, children: Entry[], wait: { cancelled: boolean }): Promise<void> {
		const types = this.deps.agentTypes();
		const reports: string[] = [];
		for (const c of children) {
			await this.whenSettled(c.record.id);
			if (wait.cancelled) return;
			const name = `${findAgentType(types, c.record.agentType)?.name ?? c.record.agentType} (session “${c.record.title}”)`;
			if (c.record.error) reports.push(`${name} stopped with an error: ${c.record.error}`);
			else {
				reports.push(`${name} finished. Its report:\n\n${lastAssistantText(await this.messages(c.record.id)) || "(it wrote no report)"}`);
				await this.markDone(c.record.id).catch(() => {}); // as when a delegate call returns
			}
		}
		if (wait.cancelled || this.resuming.get(e.record.id) !== wait) return;
		this.resuming.delete(e.record.id);
		this.prompt(e, `${RESUME_NOTE}\n\nThe sub-agents you were waiting for were cut off too, so your delegate calls to them returned nothing. They were resumed and have finished; don't delegate that work again.\n\n${reports.join("\n\n---\n\n")}`);
	}

	async setModel(id: string, model: string): Promise<void> {
		const e = this.entry(id);
		if (this.live.has(id)) await this.deps.host.call("setModel", id, model);
		e.record.model = model;
		this.save(e);
	}

	async contextUsage(id: string): Promise<ContextUsage | null> {
		if (!this.live.has(id)) return null;
		return this.deps.host.call("context", id).catch(() => null);
	}

	async compact(id: string): Promise<void> {
		const e = this.entry(id);
		this.assertNotRunning(e);
		if (!e.record.piSessionFile) throw new Error("This session has no conversation to compact yet");
		await this.ensureOpen(e);
		await this.deps.host.call("compact", id);
		this.touch(id);
		this.deps.emit({ type: "sessions_changed" });
	}

	/** A session started to create something adopts the first asset it shows (open_in_studio) as its own. */
	adoptLinkedAsset(id: string, path: string): void {
		const e = this.entries.get(id);
		if (!e || e.record.linkedAsset) return;
		e.record.linkedAsset = path;
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
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as { type: string; message?: { role: string } }];
				} catch {
					return []; // a line cut short when the host died mid-write: the rest of the transcript is still good
				}
			})
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
		const sessionIds = new Map<string, string[]>();
		for (const s of this.list()) sessionIds.set(s.worktreeId, [...(sessionIds.get(s.worktreeId) ?? []), s.id]);
		return this.worktrees
			.all()
			.map((w) => ({ ...w.record, repoPath: w.repoPath, path: this.worktrees.path(w), sessionIds: sessionIds.get(w.record.id) ?? [] }))
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

	/** The commits on a worktree's branch since it was made (newest first), e.g. each agent's work. */
	async worktreeCommits(id: string): Promise<GitCommit[]> {
		const w = this.worktrees.get(id);
		// From where it last matched main, like its changed files: after an update from main, main's commits aren't its own.
		return g.log(w.repoPath, 500, `${await this.worktrees.base(w)}..${w.record.branch}`);
	}

	/** How many commits main has that the worktree doesn't, and the conflicts of an update from main in progress. */
	worktreeStatus(id: string): Promise<{ behind: number; conflicts: string[] | null }> {
		return this.worktrees.updateStatus(this.worktrees.get(id));
	}

	/**
	 * Brings a worktree up to date with main (a merge into its branch, in its checkout). Its agents must be idle and its
	 * unsaved edits saved; conflicts leave the merge in progress for a person or the Conflict Resolver to finish.
	 */
	async updateWorktree(id: string): Promise<{ commits: number; conflicts: string[] }> {
		const w = this.worktrees.get(id);
		this.assertIdleWorktree(id, "updating it from main");
		if ((await this.worktrees.updateStatus(w)).conflicts) throw new Error(`“${w.record.label}” is already being updated: resolve its conflicts or abort`);
		const unsaved = await this.worktreeUnsaved(id);
		if (unsaved.length) throw new Error(`“${w.record.label}” has unsaved changes (${unsaved.length} file${unsaved.length > 1 ? "s" : ""}): save or revert them first`);
		await this.worktrees.ensureCheckout(w, (dir) => this.initSubmodules(dir));
		const r = await this.worktrees.update(w);
		if (!r.conflicts.length) await this.syncSubmodules(this.worktrees.path(w)); // main may have moved the engine
		w.record.updatedAt = new Date().toISOString();
		this.worktrees.save(w);
		this.deps.emit({ type: "sessions_changed" });
		return r;
	}

	/**
	 * Moves a game worktree's engine pin to `commit` (fetched from the local engine repo) and commits that on its
	 * branch. Refuses while agents work in it, an update from main is open, or its engine/ folder has edits of its own.
	 */
	async updateWorktreeEngine(id: string, commit: string): Promise<void> {
		const w = this.worktrees.get(id);
		this.assertIdleWorktree(id, "updating its engine");
		if ((await this.worktrees.updateStatus(w)).conflicts) throw new Error(`“${w.record.label}” is being updated from main: resolve its conflicts or abort first`);
		await this.worktrees.ensureCheckout(w, (dir) => this.initSubmodules(dir));
		const dir = this.worktrees.path(w);
		const engine = join(dir, "engine");
		if (!existsSync(join(engine, ".git"))) throw new Error(`“${w.record.label}” has no engine submodule`);
		await this.syncSubmodules(dir); // not a stale checkout from before an update from main
		const own = await g.git(engine, ["status", "--porcelain", "--untracked-files=no"]);
		if (own.trim()) throw new Error(`“${w.record.label}” has edits inside engine/: commit or revert them first`);
		await g.git(engine, ["-c", "protocol.file.allow=always", "fetch", "-q", this.deps.settings().engineRepo, "main"]);
		await g.git(engine, ["checkout", "-q", commit]);
		await g.commitPaths(dir, ["engine"], `Update engine to ${commit.slice(0, 7)}`);
		await this.initSubmodules(dir); // shares the engine's built libraries again
		w.record.updatedAt = new Date().toISOString();
		this.worktrees.save(w);
		this.deps.emit({ type: "sessions_changed" });
	}

	async abortWorktreeUpdate(id: string): Promise<void> {
		const w = this.worktrees.get(id);
		this.assertIdleWorktree(id, "aborting the update");
		await this.worktrees.abortUpdate(w);
		await this.syncSubmodules(this.worktrees.path(w));
		w.record.updatedAt = new Date().toISOString();
		this.worktrees.save(w);
		this.deps.emit({ type: "sessions_changed" });
	}

	/** The Conflict Resolver's brief: the conflicts, both sides' commits, and every session in the worktree (context). */
	async conflictBrief(id: string): Promise<string> {
		const w = this.worktrees.get(id);
		const { conflicts } = await this.worktrees.updateStatus(w);
		if (!conflicts?.length) throw new Error(`“${w.record.label}” has no update in progress with conflicts`);
		const dir = this.worktrees.path(w);
		const commits = async (range: string) => (await g.git(dir, ["log", "--format=- %h %s", "--no-merges", range]).catch(() => "")).trim() || "(none)";
		const sessions = this.sessionsIn(id).sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt));
		const lines = [
			`Worktree “${w.record.label}” (branch ${w.record.branch}) is being updated from ${w.record.baseBranch}, and these files conflict:`,
			...conflicts.map((f) => `- ${f}`),
			"",
			`What ${w.record.baseBranch} changed since the worktree last matched it:`,
			await commits("HEAD..MERGE_HEAD"),
			"",
			"What the worktree changed (its own commits):",
			await commits("MERGE_HEAD..HEAD"),
			"",
			"The sessions in this worktree, for what was meant (their full transcripts are the .jsonl files beside each session.json):",
		];
		for (const e of sessions) {
			const r = e.record;
			const report = lastAssistantText(await this.messages(r.id).catch(() => [])).trim();
			lines.push(`- ${r.title} (${r.agentType}${r.parentId ? ", a sub-agent" : ""}, ${r.status}): ${join(this.sessionDir(e), "session.json")}`);
			if (report) lines.push(`  Last report: ${report.length > 1200 ? `${report.slice(0, 1200)}…` : report}`);
		}
		lines.push("", "Resolve every conflict keeping both sides' intent (read the merge-conflicts skill), check the game builds and its tests pass, then commit the merge.");
		return lines.join("\n");
	}

	/** Starts the Conflict Resolver in the worktree, briefed with `conflictBrief`. */
	async resolveWorktreeConflicts(id: string, model?: string): Promise<SessionSummary> {
		this.assertIdleWorktree(id, "resolving its conflicts");
		const prompt = await this.conflictBrief(id);
		return this.create({ agentType: "conflict-resolver", target: this.worktrees.get(id).record.target, worktreeId: id, title: "Resolve conflicts with main", prompt, ...(model ? { model } : {}) } as NewSessionRequest);
	}

	/** Uncommitted changes in a worktree's checkout (not the studio's records): what a Save commits, or Revert drops. */
	async worktreeUnsaved(id: string): Promise<string[]> {
		const w = this.worktrees.get(id);
		if (!this.worktrees.hasCheckout(w)) return [];
		const dir = this.worktrees.path(w);
		const unsaved = async () => (await g.status(dir)).files.map((f) => f.path).filter((p) => !p.startsWith(".studio/"));
		const files = await unsaved();
		// A submodule (the engine) checked out at another commit than the branch records isn't an edit: an update
		// from main moved the record. Check out the recorded one (when it has no edits of its own) instead of
		// offering to save the old one back.
		if ((await this.syncSubmodules(dir, files)).length) return unsaved();
		return files;
	}

	/** Checks out, in a worktree's checkout, the commit the branch records for each drifted submodule without edits of its own. */
	private async syncSubmodules(dir: string, changed?: string[]): Promise<string[]> {
		if (!existsSync(join(dir, ".gitmodules"))) return [];
		if (await g.git(dir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false)) return [];
		const paths = (await g.git(dir, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]).catch(() => ""))
			.split("\n")
			.map((l) => l.split(" ")[1])
			.filter(Boolean);
		const drifted: string[] = [];
		for (const p of paths.filter((p) => !changed || changed.includes(p))) {
			const own = await g.git(join(dir, p), ["status", "--porcelain", "--untracked-files=no"]).catch(() => "x");
			if (!own.trim()) drifted.push(p);
		}
		if (drifted.length) await this.initSubmodules(dir);
		return drifted;
	}

	/**
	 * Why an open worktree can't be unloaded (its checkout removed to free space), or null: an agent working in it,
	 * a generation job for it (`busy`), or anything that exists only in its folder (see WorktreeStore.unloadBlocker).
	 */
	async worktreeUnloadBlocker(id: string, busy = false): Promise<string | null> {
		const w = this.worktrees.get(id);
		if (w.record.status !== "active") return "it isn't open";
		if (this.sessionsIn(id).some((e) => e.record.status === "in_progress" || e.record.status === "starting")) return "an agent is working in it";
		if (busy) return "a generation job is running for it";
		if (this.worktrees.hasCheckout(w)) await this.syncSubmodules(this.worktrees.path(w)); // a drifted engine/ isn't an edit
		return this.worktrees.unloadBlocker(w);
	}

	/** Frees an open worktree's disk space: its checkout goes (its branch, sessions and label stay); selecting it reloads it. */
	async unloadWorktree(id: string, busy = false): Promise<void> {
		const blocker = await this.worktreeUnloadBlocker(id, busy);
		if (blocker) throw new Error(`Can't free “${this.worktrees.get(id).record.label}”: ${blocker}`);
		for (const e of this.sessionsIn(id)) this.close(e.record.id);
		await this.worktrees.unload(this.worktrees.get(id));
		this.deps.emit({ type: "sessions_changed" });
	}

	/** Recreates an unloaded worktree's checkout from its branch. */
	async loadWorktree(id: string): Promise<void> {
		await this.worktrees.ensureCheckout(this.worktrees.get(id), (dir) => this.initSubmodules(dir));
		this.deps.emit({ type: "sessions_changed" });
	}

	/** Disk used by an open worktree's checkout, in bytes (null when unloaded). */
	async worktreeBytes(id: string): Promise<number | null> {
		const w = this.worktrees.get(id);
		if (!this.worktrees.hasCheckout(w)) return null;
		// du exits non-zero when files change under it (a build running there) but still prints the total.
		const out = await new Promise<string>((done) => execFile("du", ["-sk", this.worktrees.path(w)], (_err, stdout) => done(String(stdout ?? ""))));
		const kb = Number(out.split(/\s/)[0]);
		return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
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
		if ((await this.worktrees.updateStatus(w)).conflicts) throw new Error(`“${w.record.label}” is being updated from main: resolve its conflicts (or abort the update) first`);
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
		for (const e of sessions) if (isRunning(e.record.status)) await this.abort(e.record.id);
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
		e.record.closedAt = new Date().toISOString();
		e.record.reviewRequested = false;
		this.save(e);
		await this.commitRecord(e);
	}

	private end(e: Entry, outcome: "merged" | "discarded"): void {
		this.close(e.record.id);
		this.questions.delete(e.record.id);
		e.record.status = "done";
		e.record.closedAt = new Date().toISOString();
		e.record.outcome = outcome;
		e.record.reviewRequested = false;
		this.save(e);
	}

	/** Reopens a done session (it becomes idle), or carries on one that was interrupted, with its interrupted sub-agents. */
	async resume(id: string): Promise<void> {
		const e = this.entry(id);
		if (e.record.status === "interrupted") return this.resumeInterrupted(e);
		await this.ensureWorktree(e);
		if (e.record.status === "done") {
			e.record.status = "idle";
			e.record.outcome = null;
			e.record.closedAt = undefined;
		}
		this.save(e);
	}

	private async commitRecord(e: Entry): Promise<void> {
		const r = e.record;
		try {
			ensureStudioIgnore(e.repoPath);
			await g.commitPaths(e.repoPath, [join(SESSIONS_DIR, r.id), STUDIO_IGNORE_FILE], `studio: session ${r.id} ${r.outcome ?? "done"}: ${r.title}`);
		} catch (err) {
			console.error(`could not commit session record ${r.id}:`, err);
		}
	}

	private async commitRecords(w: Worktree, sessions: Entry[], outcome: "merged" | "discarded"): Promise<void> {
		const paths = [join(WORKTREES_DIR, `${w.record.id}.json`), ...sessions.map((e) => join(SESSIONS_DIR, e.record.id)), STUDIO_IGNORE_FILE];
		try {
			ensureStudioIgnore(w.repoPath);
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
		if (!e || this.leaving.has(event.id)) return;
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
					} else if (m?.role === "assistant" && r.error) {
						// A later attempt got through (the session tries a failed request again by itself): no error to show.
						r.error = undefined;
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
				else if (event.tool === "request_review") {
					r.reviewRequested = true;
					r.reviewSummary = event.params.summary;
					const list = (json: string | undefined): string[] => {
						try {
							const v: unknown = JSON.parse(json ?? "[]");
							return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
						} catch {
							return [];
						}
					};
					r.reviewLookAt = list(event.params.lookAt);
					// Only pictures that exist in its checkout, as with a question's.
					const startHere = (event.params.startHere ?? "").replace(/^\.?\//, "");
					r.reviewStartHere = (startHere.endsWith(".jsonl") || (startHere.startsWith(`${SCENARIO_DIR}/`) && startHere.endsWith(".json"))) && !startHere.includes("..") && existsSync(join(this.worktreePath(e), startHere)) ? startHere : undefined;
					queueMicrotask(() => this.deps.reviewRequested?.(this.summary(e)));
					r.reviewImages = list(event.params.images).map((p) => p.replace(/^\.?\//, "")).filter((p) => /\.(png|jpe?g|webp|webm)$/i.test(p) && existsSync(join(this.worktreePath(e), p)));
					r.reviewRequestedAt = new Date().toISOString();
				}
				this.save(e);
				break;
			case "ask_user":
				this.questions.set(event.id, {
					questionId: event.questionId,
					question: event.question,
					options: event.options,
					// Only images that exist in its checkout: a wrong path would show as a broken picture.
					images: event.images?.filter((p) => existsSync(join(this.worktreePath(e), p))),
				});
				this.deps.emit({ type: "sessions_changed" });
				break;
		}
	}

	private onHostRestart(): void {
		this.live.clear();
		this.questions.clear();
		for (const wait of this.resuming.values()) wait.cancelled = true;
		this.resuming.clear();
		const cutOff = new Date().toISOString();
		// All marked before any is saved: saving wakes whoever waits for a session, who must find its parent cut off too.
		const cut = [...this.entries.values()].filter((e) => isRunning(e.record.status));
		for (const e of cut) {
			e.record.status = "interrupted";
			e.record.interruptedAt = cutOff;
		}
		for (const e of cut) this.save(e);
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
	if (!existsSync(join(engineCheckout, "third_party"))) return;
	// The built libraries, and what release builds need: the Debian sysroot, Microsoft's CRT and SDK, and xwin.
	for (const dir of ["lib", "sysroot", "xwin", "tools"]) {
		const source = join(engineRepo, "third_party", dir);
		const target = join(engineCheckout, "third_party", dir);
		if (!existsSync(source) || existsSync(target)) continue;
		symlinkSync(source, target);
		const exclude = (await g.git(engineCheckout, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim();
		mkdirSync(join(exclude, ".."), { recursive: true });
		const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
		if (!text.split("\n").includes(`/third_party/${dir}`)) appendFileSync(exclude, `/third_party/${dir}\n`);
	}
}
