import type { PastedImage } from "./attachments";
/** Domain types shared by main, session host and renderer. All plain JSON. */

/** Which repo a session changes. */
export type Target = "project" | "engine" | "studio";
export const TARGETS: readonly Target[] = ["project", "engine", "studio"];

export type SessionStatus = "starting" | "in_progress" | "idle" | "interrupted" | "done";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A labelled piece of work: a git worktree on its own branch that sessions and section edits happen in, merged
 * as a whole. Persisted as `<repo>/.studio/worktrees/<id>.json` and committed with the repo.
 */
export interface WorktreeRecord {
	id: string;
	/** What the work is, for people: "Dungeon level 5 re-texturing". */
	label: string;
	target: Target;
	/** `studio/<id>`, branched from `baseBranch` at `baseCommit`. */
	branch: string;
	baseBranch: string;
	baseCommit: string;
	status: "active" | "merged" | "discarded";
	/** Whether the checkout exists on disk. */
	checkout: "active" | "removed";
	createdAt: string;
	updatedAt: string;
}

export interface WorktreeSummary extends WorktreeRecord {
	repoPath: string;
	path: string;
	/** Its sessions, newest first. */
	sessionIds: string[];
}

/** Persisted as `<repo>/.studio/sessions/<id>/session.json` and committed with the repo. */
/** What a session is told when a person resumes it after it was cut off mid-work (the chat shows it as a short note). */
export const RESUME_NOTE = "[Game Studio] You were interrupted while working (the studio closed or restarted), and the user has resumed you. Whatever was running then was cut off: check what is already done, then carry on from where you left off.";

export interface SessionRecord {
	id: string;
	title: string;
	agentType: string;
	target: Target;
	status: SessionStatus;
	/** The worktree it works in (shared with its sub-agents and maybe other sessions). */
	worktreeId: string;
	/** The session that delegated this one; none for a session a person started. */
	parentId?: string;
	/** `provider/modelId`. */
	model: string;
	thinking?: ThinkingLevel;
	linkedAsset?: string;
	createdAt: string;
	updatedAt: string;
	/** When it became done (merged, discarded or marked done); cleared when it is resumed. Archival counts from here. */
	closedAt?: string;
	outcome: "merged" | "discarded" | null;
	reviewRequested: boolean;
	/** Pi's JSONL transcript, relative to the session folder. Pi picks the name on first save. */
	piSessionFile?: string;
	/** Last error from the agent run, cleared on the next prompt. */
	error?: string;
	/** When it was cut off mid-work (the studio closed, or the session host died). Sessions cut off together share it. */
	interruptedAt?: string;
}

export interface SessionSummary extends SessionRecord {
	repoPath: string;
	/** From its worktree. */
	worktreePath: string;
	worktreeLabel: string;
	branch: string;
	baseBranch: string;
	/** Whether its worktree's checkout exists. */
	worktree: "active" | "removed";
	/** A Pi session is loaded in the session host. */
	live: boolean;
	/** A question the agent asked through `ask_user`, still waiting for an answer. */
	pendingQuestion?: PendingQuestion;
	/** Closed long ago and moved out of git into the project's archive folder; `sessions.restore` brings it back. */
	archived?: boolean;
}

export interface PendingQuestion {
	questionId: string;
	question: string;
	options?: string[];
	/** Images shown with the question (paths in the session's checkout): screenshots, renders. */
	images?: string[];
}

/** How full a session's context window is; tokens and percent are unknown right after a compaction. */
export interface ContextUsage {
	tokens: number | null;
	window: number;
	percent: number | null;
}

export interface NewSessionRequest {
	agentType: string;
	target: Target;
	model: string;
	/** The first message. Empty creates the session (record and worktree) without running the agent, as a
	 * workspace for UI actions; it can still be chatted with later. */
	prompt: string;
	title?: string;
	thinking?: ThinkingLevel;
	linkedAsset?: string;
	/** Images pasted with the first message (shared/attachments.ts). */
	images?: PastedImage[];
	/** Work in this (active) worktree; by default the parent's, else a new one labelled `worktreeLabel` or the title. A sub-agent (`parentId`) always works in its parent's. */
	worktreeId?: string;
	worktreeLabel?: string;
	parentId?: string;
}

export interface Settings {
	engineRepo: string;
	studioRepo: string;
	/** Worktrees go in `<worktreeRoot>/<repo name>/<worktree id>`. */
	worktreeRoot: string;
	recentProjects: string[];
	lastProject?: string;
	/** Settings → Agents: per agent type (by id), the models chosen here in place of what its AGENT.md says. */
	agentModels?: Record<string, AgentModelSettings>;
}

export interface AgentModelSettings {
	/** The model its sessions start on. */
	defaultModel?: string;
	/** The other models a parent agent may start it on (`delegate`'s `model`). */
	models?: string[];
}

/** The stable install's version and the pushed commits it doesn't have yet (Settings → Updates). */
export interface UpdateStatus {
	/** Running from the stable install (~/.local/share/game-studio/app), not a development checkout. */
	installed: boolean;
	current: { commit: string; subject: string; date: string } | null;
	/** Newer commits on GitHub's main, newest first. */
	available: { commit: string; subject: string; date: string }[];
	checkedAt?: string;
	/** idle → preparing (building and testing the next version) → ready (Restart switches to it), or failed. */
	phase: "idle" | "preparing" | "ready" | "failed";
	/** The prepared version's commit. */
	prepared?: string;
	/** The updater's output while preparing. */
	log: string[];
	error?: string;
}

export interface ProjectInfo {
	path: string;
	name: string;
}

export interface GitFileStatus {
	path: string;
	/** Porcelain XY codes: index (staged) and worktree (unstaged); `?` for untracked. */
	index: string;
	worktree: string;
}

export interface GitStatus {
	branch: string;
	upstream?: string;
	/** Whether the repo has any remote (a project can live only on this machine until it's published). Only from git.status. */
	hasRemote?: boolean;
	ahead: number;
	behind: number;
	files: GitFileStatus[];
}

export interface GitCommit {
	hash: string;
	subject: string;
	author: string;
	date: string;
}

export interface AgentTypeInfo {
	id: string;
	name: string;
	description: string;
	targets: Target[];
	defaultModel?: string;
	/** Other models a parent agent may start it on when it delegates (AGENT.md `models`, or Settings → Agents). */
	models?: string[];
	/** Its models were set in Settings → Agents; these are what its AGENT.md says (shown by Reset). */
	fileModels?: AgentModelSettings;
	thinking?: ThinkingLevel;
	skills: string[];
	/** System prompt text appended to Pi's base prompt. */
	prompt: string;
	source: "builtin" | "project";
	/**
	 * The studio tools it gets beyond the ones every session has (set_session_title, request_review, open_in_studio,
	 * ask_user, delegate); absent means all. Directors leave generation to the specialists they delegate to.
	 */
	studioTools?: string[];
	/**
	 * The standard design docs its work follows (ids from shared/design-docs.ts): given in full when a session opens,
	 * the others listed. Absent: the game brief. "none": no design brief at all.
	 */
	designDocs?: string[] | "none";
	/** Old ids it answers to (sessions of a type that was renamed or replaced keep working). */
	aliases?: string[];
	/** Agent types it may hand tasks to (`delegate`): edges of the delegation graph, which has no cycles. */
	delegatesTo?: string[];
	/** Edges dropped when the types loaded (unknown types, or an edge that closed a cycle). */
	problems?: string[];
}

export interface ProviderInfo {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
	oauth?: { name: string; loginLabel?: string; isSubscription?: boolean };
	apiKey?: { name: string; interactive: boolean };
}

export interface ModelInfo {
	/** `provider/id`. */
	ref: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

/** A login step that needs input from the user (mirrors Pi's AuthPrompt without the signal). */
export type LoginPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };

/** Progress shown during a login (mirrors Pi's AuthEvent). */
export type LoginNotice =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };
