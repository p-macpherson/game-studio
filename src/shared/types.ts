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
	outcome: "merged" | "discarded" | null;
	reviewRequested: boolean;
	/** Pi's JSONL transcript, relative to the session folder. Pi picks the name on first save. */
	piSessionFile?: string;
	/** Last error from the agent run, cleared on the next prompt. */
	error?: string;
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
}

export interface PendingQuestion {
	questionId: string;
	question: string;
	options?: string[];
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
	/** Work in this (active) worktree; by default the parent's, else a new one labelled `worktreeLabel` or the title. */
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
	thinking?: ThinkingLevel;
	skills: string[];
	/** System prompt text appended to Pi's base prompt. */
	prompt: string;
	source: "builtin" | "project";
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
