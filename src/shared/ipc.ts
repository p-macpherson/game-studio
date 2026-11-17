/** Contract between the renderer and the main process, exposed by the preload script as `window.studio`. */
import type { HostInfo, PromptMode } from "./host";
import type {
	AgentTypeInfo,
	GitCommit,
	GitStatus,
	LoginNotice,
	LoginPrompt,
	ModelInfo,
	NewSessionRequest,
	ProjectInfo,
	ProviderInfo,
	SessionSummary,
	Settings,
	Target,
} from "./types";

export interface StudioApi {
	"host.info"(): Promise<HostInfo>;

	"settings.get"(): Promise<Settings>;
	"settings.update"(patch: Partial<Settings>): Promise<Settings>;

	"project.current"(): Promise<ProjectInfo | null>;
	/** Opens a project; without a path, shows a folder picker. Null if cancelled. */
	"project.open"(path?: string): Promise<ProjectInfo | null>;
	/** Creates a project from the template in an empty folder or empty repo. */
	"project.create"(path: string, name: string): Promise<ProjectInfo>;
	"project.close"(): Promise<void>;
	"dialog.pickFolder"(title: string): Promise<string | null>;

	"git.status"(target: Target): Promise<GitStatus>;
	"git.diff"(target: Target, path: string, staged: boolean): Promise<string>;
	"git.stage"(target: Target, paths: string[]): Promise<void>;
	"git.unstage"(target: Target, paths: string[]): Promise<void>;
	"git.discardFile"(target: Target, path: string): Promise<void>;
	"git.commit"(target: Target, message: string): Promise<void>;
	"git.log"(target: Target, limit: number): Promise<GitCommit[]>;
	"git.push"(target: Target): Promise<string>;
	"git.pull"(target: Target): Promise<string>;
	/** Engine submodule: commit currently pinned vs the engine repo's main. */
	"git.engineInfo"(): Promise<{ pinned: string; latest: string; behind: number } | null>;
	"git.updateEngine"(): Promise<void>;

	"accounts.providers"(): Promise<ProviderInfo[]>;
	"accounts.login"(loginId: string, provider: string, type: "oauth" | "api_key"): Promise<void>;
	"accounts.answer"(loginId: string, value: string | null): Promise<void>;
	"accounts.logout"(provider: string): Promise<void>;
	"models.available"(): Promise<ModelInfo[]>;

	"agentTypes.list"(): Promise<AgentTypeInfo[]>;

	"sessions.list"(): Promise<SessionSummary[]>;
	"sessions.create"(req: NewSessionRequest): Promise<SessionSummary>;
	"sessions.messages"(id: string): Promise<unknown[]>;
	"sessions.send"(id: string, text: string, mode?: PromptMode): Promise<void>;
	"sessions.abort"(id: string): Promise<void>;
	"sessions.setModel"(id: string, model: string): Promise<void>;
	"sessions.answer"(id: string, questionId: string, answer: string): Promise<void>;
	"sessions.diff"(id: string): Promise<string>;
	"sessions.raw"(id: string): Promise<string>;
	"sessions.merge"(id: string): Promise<void>;
	"sessions.discard"(id: string): Promise<void>;
	"sessions.markDone"(id: string): Promise<void>;
	"sessions.resume"(id: string): Promise<void>;
	"sessions.openTerminal"(id: string): Promise<void>;
}

export type StudioMethod = keyof StudioApi;

/** Pushed from main to the renderer. */
export type StudioEvent =
	| { type: "sessions_changed" }
	| { type: "session_event"; id: string; event: { type: string; [k: string]: unknown } }
	| { type: "project_changed" }
	| { type: "focus_asset"; path: string }
	| { type: "login_notice"; loginId: string; notice: LoginNotice }
	| { type: "login_prompt"; loginId: string; prompt: LoginPrompt };

/** What the preload exposes. */
export interface StudioBridge {
	call<M extends StudioMethod>(method: M, ...args: Parameters<StudioApi[M]>): ReturnType<StudioApi[M]>;
	onEvent(listener: (event: StudioEvent) => void): () => void;
}
