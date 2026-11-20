/** Contract between the renderer and the main process, exposed by the preload script as `window.studio`. */
import type { HostInfo, PromptMode, StudioRequestMethod } from "./host";
import type { AssetSearchHit, AssetSummary, ModuleInfo } from "./modules";
import type { CheckoutId, CheckoutInfo, RunInfo, RunMode, RunOptions, TestReport } from "./run";
import type { ConceptImage, GenJob, GenStatus } from "./gen";
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

	"modules.list"(): Promise<ModuleInfo[]>;
	"assets.list"(moduleId: string): Promise<AssetSummary[]>;
	/** From the main checkout, or from a session's worktree when `sessionId` is given. */
	"assets.read"(path: string, sessionId?: string): Promise<string>;
	"assets.search"(moduleId: string, query: string): Promise<AssetSearchHit[]>;

	/** Main checkout plus session worktrees the game can be built and run from. */
	"run.checkouts"(): Promise<CheckoutInfo[]>;
	"run.current"(): Promise<RunInfo | null>;
	"run.build"(sessionId: CheckoutId): Promise<RunInfo>;
	"run.start"(sessionId: CheckoutId, mode: RunMode, options?: RunOptions): Promise<RunInfo>;
	"run.stop"(): Promise<void>;
	/** A control-protocol command for the running game (see engine/docs/control-protocol.md). */
	"run.call"(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
	"run.stream"(on: boolean): Promise<void>;
	"run.tests"(sessionId: CheckoutId): Promise<string[]>;
	"run.test"(sessionId: CheckoutId, script: string): Promise<TestReport>;
	"run.image"(sessionId: CheckoutId, path: string): Promise<string>;

	"gen.status"(): Promise<GenStatus>;
	"gen.jobs"(): Promise<GenJob[]>;
	"gen.cancel"(jobId: string): Promise<void>;
	/** Runs gen/setup.sh: environments, model weights and patches (tens of GB). */
	"gen.install"(): Promise<void>;
	/** A PNG from the generation outputs or a project checkout, as a data URL (thumbnails, concepts). */
	"gen.image"(path: string): Promise<string>;

	/**
	 * A session used as a workspace for a section's buttons (3D Models, Music): created without running the
	 * agent (no account needed), linked to the asset, and chattable later.
	 */
	"workspace.create"(agentType: string, title: string, linkedAsset?: string): Promise<SessionSummary>;
	/** Runs a studio step in a session's worktree (the same steps agents call as tools: generation, render_song). */
	"workspace.run"(sessionId: string, method: StudioRequestMethod, params: Record<string, unknown>): Promise<unknown>;
	/** Concept images of a model, from the main checkout (null) or a session's worktree. */
	"models3d.concepts"(checkout: string | null, name: string): Promise<ConceptImage[]>;
	/** The model rendered by the game's own engine: front, three-quarter and back views, plus engine errors. */
	"models3d.preview"(checkout: string | null, name: string): Promise<{ images: string[]; errors: string[] }>;

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
	| { type: "focus_asset"; path: string; sessionId?: string; line?: number }
	| { type: "assets_changed" }
	| { type: "run_changed"; run: RunInfo }
	| { type: "run_output"; runId: string; text: string }
	/** A streamed frame: base64 image data of type `mime`. */
	| { type: "run_frame"; runId: string; image: string; mime: string; width: number; height: number }
	| { type: "test_report"; report: TestReport }
	| { type: "gen_job"; job: GenJob }
	| { type: "gen_changed" }
	| { type: "gen_setup"; text: string; done?: boolean; ok?: boolean }
	| { type: "login_notice"; loginId: string; notice: LoginNotice }
	| { type: "login_prompt"; loginId: string; prompt: LoginPrompt };

/** What the preload exposes. */
export interface StudioBridge {
	call<M extends StudioMethod>(method: M, ...args: Parameters<StudioApi[M]>): ReturnType<StudioApi[M]>;
	onEvent(listener: (event: StudioEvent) => void): () => void;
}
