/** Domain types shared by main, session host and renderer. All plain JSON. */

/** Which repo a session changes. */
export type Target = "project" | "engine" | "studio";
export const TARGETS: readonly Target[] = ["project", "engine", "studio"];

export type SessionStatus = "starting" | "in_progress" | "idle" | "interrupted" | "done";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Persisted as `<repo>/.studio/sessions/<id>/session.json` and committed with the repo. */
export interface SessionRecord {
	id: string;
	title: string;
	agentType: string;
	target: Target;
	status: SessionStatus;
	/** `studio/<id>`, branched from `baseBranch` at `baseCommit`. */
	branch: string;
	baseBranch: string;
	baseCommit: string;
	/** `provider/modelId`. */
	model: string;
	thinking?: ThinkingLevel;
	linkedAsset?: string;
	createdAt: string;
	updatedAt: string;
	worktree: "active" | "removed";
	outcome: "merged" | "discarded" | null;
	reviewRequested: boolean;
	/** Pi's JSONL transcript, relative to the session folder. Pi picks the name on first save. */
	piSessionFile?: string;
	/** Last error from the agent run, cleared on the next prompt. */
	error?: string;
}

export interface SessionSummary extends SessionRecord {
	repoPath: string;
	worktreePath: string;
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
	prompt: string;
	thinking?: ThinkingLevel;
	linkedAsset?: string;
}

export interface Settings {
	engineRepo: string;
	studioRepo: string;
	/** Session worktrees go in `<worktreeRoot>/<repo name>/<session id>`. */
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
