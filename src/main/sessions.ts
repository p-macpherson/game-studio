// The session orchestrator: owns session records, worktrees and the lifecycle, and drives Pi sessions in
// the session host. See the vault note "Sessions & Worktrees".
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HostEvent, PromptMode } from "../shared/host";
import type { StudioEvent } from "../shared/ipc";
import type { AgentTypeInfo, NewSessionRequest, PendingQuestion, SessionRecord, SessionSummary, Settings, Target } from "../shared/types";
import * as g from "./git";
import type { HostLink } from "./host-link";

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
}

interface Entry {
	record: SessionRecord;
	repoPath: string;
}

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

	constructor(private readonly deps: SessionServiceDeps) {
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

	worktreePath(e: Entry): string {
		return join(this.deps.settings().worktreeRoot, basename(e.repoPath), e.record.id);
	}

	private save(e: Entry): void {
		e.record.updatedAt = new Date().toISOString();
		mkdirSync(this.sessionDir(e), { recursive: true });
		writeFileSync(join(this.sessionDir(e), "session.json"), `${JSON.stringify(e.record, null, "\t")}\n`);
		this.deps.emit({ type: "sessions_changed" });
	}

	/** (Re)reads every record from the project, engine and studio repos. Sessions left running become interrupted. */
	load(): void {
		const seen = new Set<string>();
		for (const { target, path } of this.repos()) {
			const dir = join(path, SESSIONS_DIR);
			if (!existsSync(dir)) continue;
			for (const id of readdirSync(dir)) {
				const file = join(dir, id, "session.json");
				if (!existsSync(file)) continue;
				const known = this.entries.get(id);
				const record: SessionRecord = known && known.repoPath === path ? known.record : { ...JSON.parse(readFileSync(file, "utf8")), target };
				const entry = { record, repoPath: path };
				this.entries.set(id, entry);
				seen.add(id);
				if ((record.status === "in_progress" || record.status === "starting") && !this.live.has(id)) {
					record.status = "interrupted";
					this.save(entry);
				}
			}
		}
		for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
		this.deps.emit({ type: "sessions_changed" });
	}

	private entry(id: string): Entry {
		const e = this.entries.get(id);
		if (!e) throw new Error(`Unknown session ${id}`);
		return e;
	}

	list(): SessionSummary[] {
		return [...this.entries.values()]
			.map((e) => ({
				...e.record,
				repoPath: e.repoPath,
				worktreePath: this.worktreePath(e),
				live: this.live.has(e.record.id),
				pendingQuestion: this.questions.get(e.record.id),
			}))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	get(id: string): SessionSummary {
		const summary = this.list().find((s) => s.id === id);
		if (!summary) throw new Error(`Unknown session ${id}`);
		return summary;
	}

	// ── creating and driving sessions ───────────────────────────────────────────────────────────────

	async create(req: NewSessionRequest): Promise<SessionSummary> {
		const agentType = this.deps.agentTypes().find((t) => t.id === req.agentType);
		if (!agentType) throw new Error(`Unknown agent type ${req.agentType}`);
		if (!agentType.targets.includes(req.target)) throw new Error(`${agentType.name} sessions can't target the ${req.target}`);
		const repoPath = this.repoFor(req.target);
		if (!(await g.hasCommits(repoPath))) throw new Error(`${repoPath} has no commits yet`);
		const id = newSessionId();
		const now = new Date().toISOString();
		const entry: Entry = {
			repoPath,
			record: {
				id,
				title: req.prompt.split("\n")[0].slice(0, 60) || agentType.name,
				agentType: agentType.id,
				target: req.target,
				status: "starting",
				branch: `studio/${id}`,
				baseBranch: await g.currentBranch(repoPath),
				baseCommit: await g.revParse(repoPath, "HEAD"),
				model: req.model,
				thinking: req.thinking ?? agentType.thinking,
				linkedAsset: req.linkedAsset,
				createdAt: now,
				updatedAt: now,
				worktree: "removed",
				outcome: null,
				reviewRequested: false,
			},
		};
		this.entries.set(id, entry);
		this.save(entry);
		try {
			await this.ensureWorktree(entry);
			await this.open(entry);
			this.prompt(entry, req.prompt);
		} catch (err) {
			entry.record.status = "idle";
			entry.record.error = err instanceof Error ? err.message : String(err);
			this.save(entry);
		}
		return this.get(id);
	}

	private preamble(e: Entry, agentType: AgentTypeInfo): string {
		const r = e.record;
		const lines = [
			`You are working inside Game Studio, an agent-driven game development IDE, as a "${agentType.name}" session.`,
			`Target repository: the ${r.target} (${basename(e.repoPath)}). Your working directory is a git worktree on branch \`${r.branch}\`, created from \`${r.baseBranch}\`.`,
			"",
			"- Commit your work on this branch as you go, with clear messages. Never switch branches, rebase, push, or touch the base branch: the user reviews and merges your branch from Game Studio.",
			"- Don't edit anything under `.studio/`; it belongs to Game Studio.",
			"- Call `set_session_title` early with a short title for the task.",
			"- When your work is committed and ready, call `request_review` with a summary.",
			"- Use `ask_user` when you need a decision from the user.",
		];
		const project = this.deps.projectPath();
		if (r.target === "engine" && project) {
			lines.push(
				`- The open game project is at ${project}. Test an engine change against it with \`ENGINE_DIR=${this.worktreePath(e)} ${project}/build.sh test\`.`,
			);
		}
		return lines.join("\n");
	}

	private async open(e: Entry): Promise<void> {
		const agentType = this.deps.agentTypes().find((t) => t.id === e.record.agentType);
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
		});
		this.live.add(e.record.id);
		this.touch(e.record.id);
		if (e.record.piSessionFile !== file) {
			e.record.piSessionFile = file;
			this.save(e);
		}
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

	async abort(id: string): Promise<void> {
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

	/** Changes on the session branch since it was created, including uncommitted work in the worktree. */
	async diff(id: string): Promise<string> {
		const e = this.entry(id);
		const wt = this.worktreePath(e);
		if (!this.hasWorktree(e)) return g.git(e.repoPath, ["diff", e.record.baseCommit, e.record.branch]);
		let out = await g.git(wt, ["diff", e.record.baseCommit]);
		const st = await g.status(wt);
		for (const f of st.files.filter((f) => f.index === "?")) {
			out += await g.git(wt, ["diff", "--no-index", "/dev/null", f.path]).catch((err: Error) => {
				// `git diff --no-index` exits 1 when the files differ, which is always here
				const m = /git diff: ([\s\S]*)/.exec(err.message);
				return m ? `${m[1]}\n` : "";
			});
		}
		return out;
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
		return existsSync(join(this.worktreePath(e), ".git"));
	}

	/** Creates the session's worktree if it's missing; a merged branch is first fast-forwarded to the base. */
	async ensureWorktree(e: Entry): Promise<void> {
		if (this.hasWorktree(e)) return;
		const r = e.record;
		const wt = this.worktreePath(e);
		await g.git(e.repoPath, ["worktree", "prune"]);
		rmSync(wt, { recursive: true, force: true });
		mkdirSync(join(wt, ".."), { recursive: true });
		if (await g.branchExists(e.repoPath, r.branch)) {
			if (r.outcome === "merged" && (await g.isAncestor(e.repoPath, r.branch, r.baseBranch))) {
				await g.git(e.repoPath, ["branch", "-f", r.branch, r.baseBranch]);
				r.baseCommit = await g.revParse(e.repoPath, r.baseBranch);
			}
			await g.worktreeAdd(e.repoPath, wt, r.branch);
		} else {
			await g.worktreeAdd(e.repoPath, wt, r.branch, r.baseCommit);
		}
		await this.initSubmodules(wt);
		r.worktree = "active";
		this.save(e);
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

	async merge(id: string): Promise<void> {
		const e = this.entry(id);
		const r = e.record;
		this.assertNotRunning(e);
		if (this.hasWorktree(e)) await g.commitAll(this.worktreePath(e), `Uncommitted changes from session ${r.id}`);
		const current = await g.currentBranch(e.repoPath);
		if (current !== r.baseBranch) throw new Error(`${basename(e.repoPath)} is on ${current}; switch it to ${r.baseBranch} to merge`);
		try {
			await g.git(e.repoPath, ["merge", "--no-ff", "-q", "-m", `Merge session ${r.id}: ${r.title}`, r.branch]);
		} catch (err) {
			await g.git(e.repoPath, ["merge", "--abort"]).catch(() => {});
			throw new Error(`Merge failed, nothing was changed: ${(err as Error).message}`);
		}
		await this.finish(e, "merged");
	}

	async discard(id: string): Promise<void> {
		const e = this.entry(id);
		if (e.record.status === "in_progress") await this.abort(id);
		await this.finish(e, "discarded");
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

	private async finish(e: Entry, outcome: "merged" | "discarded"): Promise<void> {
		this.close(e.record.id);
		this.questions.delete(e.record.id);
		if (this.hasWorktree(e)) await g.worktreeRemove(e.repoPath, this.worktreePath(e));
		e.record.worktree = "removed";
		e.record.status = "done";
		e.record.outcome = outcome;
		e.record.reviewRequested = false;
		this.save(e);
		await this.commitRecord(e);
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
				if (event.tool === "set_session_title") r.title = event.params.title;
				else if (event.tool === "request_review") r.reviewRequested = true;
				else if (event.tool === "open_in_studio") this.deps.emit({ type: "focus_asset", path: event.params.path });
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
