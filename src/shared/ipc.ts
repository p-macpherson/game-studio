/** Contract between the renderer and the main process, exposed by the preload script as `window.studio`. */
import type { HostInfo, PromptMode, StudioRequestMethod } from "./host";
import type { AssetLinks } from "./asset-links";
import type { ReleaseBuild, ReleaseInfo, ReleaseTarget } from "./release";
import type { HistoryStep } from "./history";
import type { CandidateRecord } from "./texture";
import type { AssetSearchHit, AssetSummary, ModuleInfo, MoveResult } from "./modules";
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
	WorktreeSummary,
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
	/** Adds a remote to a project with none and pushes its branch there (see publishProject). */
	"git.publish"(url: string): Promise<void>;
	/** Engine submodule: commit currently pinned vs the engine repo's main. */
	"git.engineInfo"(checkout?: string | null): Promise<{ pinned: string; latest: string; behind: number } | null>;
	"git.updateEngine"(checkout?: string | null): Promise<void>;

	"accounts.providers"(): Promise<ProviderInfo[]>;
	"accounts.login"(loginId: string, provider: string, type: "oauth" | "api_key"): Promise<void>;
	"accounts.answer"(loginId: string, value: string | null): Promise<void>;
	"accounts.logout"(provider: string): Promise<void>;
	"models.available"(): Promise<ModelInfo[]>;

	"agentTypes.list"(): Promise<AgentTypeInfo[]>;

	"modules.list"(): Promise<ModuleInfo[]>;
	/** A module's assets in a checkout: the main one (null) or a worktree (its id). */
	"assets.list"(moduleId: string, checkout?: string | null): Promise<AssetSummary[]>;
	/** From the main checkout, or from a session's worktree when `sessionId` is given. */
	"assets.read"(path: string, checkout?: string | null): Promise<string>;
	"assets.search"(moduleId: string, query: string, checkout?: string | null): Promise<AssetSearchHit[]>;
	/** Which assets use which in a checkout: for each asset, what refers to it directly. */
	"assets.links"(checkout?: string | null): Promise<AssetLinks>;
	/** Moves or renames an asset (or a folder of them) in a worktree, rewriting references to it. */
	"assets.move"(moduleId: string, checkout: string, from: string, to: string): Promise<MoveResult>;

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

	/** Runs a studio step (generation, renders, scene edits: the same steps agents call as tools) in a worktree. */
	"worktrees.run"(worktreeId: string, method: StudioRequestMethod, params: Record<string, unknown>): Promise<unknown>;
	/** Concept images of a model, from the main checkout (null) or a session's worktree. */
	"models3d.concepts"(checkout: string | null, name: string): Promise<ConceptImage[]>;
	/** The model rendered by the game's own engine: front, three-quarter and back views, plus engine errors. */
	"models3d.preview"(checkout: string | null, name: string): Promise<{ images: string[]; errors: string[] }>;
	/** Where the game refers to a sound (`sounds/<name>/` in game code, scenes and prefabs) in a checkout. */
	/** A texture's generated candidates (newest first) and how each was made. */
	"textures.candidates"(checkout: string | null, name: string): Promise<({ source: string } & CandidateRecord)[]>;
	/** A piece of UI art's candidates (candidates/<file>.png) and the slice insets found for each. */
	"ui.artCandidates"(checkout: string | null, name: string): Promise<{ source: string; slice: number[] }[]>;
	/** A particle texture's generated candidates (assets/effects/textures/<name>/candidates/). */
	"effects.textureCandidates"(checkout: string | null, name: string): Promise<{ source: string; seed?: number }[]>;
	/** A made texture on a plane and a sphere in the game's engine. */
	"textures.preview"(checkout: string | null, name: string): Promise<{ images: { view: string; image: string }[]; warnings: string[] }>;
	/** A voice's takes (how each was made, how well its voice matches the character's other lines) and what each line's file was rendered from. */
	"voices.takes"(checkout: string | null, name: string): Promise<import("../main/voices").VoiceTakes>;
	"sounds.usages"(checkout: string | null, name: string): Promise<{ path: string; line: number; text: string }[]>;

	"sessions.list"(): Promise<SessionSummary[]>;
	"sessions.create"(req: NewSessionRequest): Promise<SessionSummary>;
	"sessions.messages"(id: string): Promise<unknown[]>;
	"sessions.send"(id: string, text: string, mode?: PromptMode): Promise<void>;
	"sessions.abort"(id: string): Promise<void>;
	"sessions.setModel"(id: string, model: string): Promise<void>;
	"sessions.answer"(id: string, questionId: string, answer: string): Promise<void>;
	"sessions.diff"(id: string): Promise<string>;
	/** Worktrees of every repo (merged and discarded ones too), newest first. */
	"worktrees.list"(): Promise<WorktreeSummary[]>;
	/** A new, empty worktree of the game project. */
	"worktrees.create"(label: string): Promise<WorktreeSummary>;
	"worktrees.rename"(id: string, label: string): Promise<void>;
	/** Merges a worktree into its base; every session in it ends as merged. */
	/** A worktree's manual-edit history (oldest first) and its unsaved files (what Save commits). */
	"history.get"(worktreeId: string): Promise<{ steps: HistoryStep[]; unsaved: string[] }>;
	/** Undoes or redoes the latest manual edit in a worktree; returns its name. */
	"history.undo"(worktreeId: string): Promise<string>;
	"history.redo"(worktreeId: string): Promise<string>;
	/** Commits a worktree's unsaved changes (clearing its history). */
	"worktrees.save"(id: string, message: string): Promise<void>;
	/** Puts a worktree's unsaved changes back to its last commit (clearing its history). */
	"worktrees.revert"(id: string): Promise<void>;
	/** The commits on a worktree's branch since it was made, newest first. */
	"worktrees.commits"(id: string): Promise<GitCommit[]>;
	/** Commits main has that the worktree doesn't, and the conflicts of an update from main in progress. */
	"worktrees.status"(id: string): Promise<{ behind: number; conflicts: string[] | null }>;
	/** Merges latest main into the worktree; conflicts leave the update in progress. */
	"worktrees.update"(id: string): Promise<{ commits: number; conflicts: string[] }>;
	"worktrees.abortUpdate"(id: string): Promise<void>;
	/** Starts the Conflict Resolver on an update's conflicts, briefed with the worktree's sessions. */
	"worktrees.resolveConflicts"(id: string, model?: string): Promise<SessionSummary>;
	/** Each open project worktree's disk use (null: unloaded) and why it can't be unloaded (null: it can). */
	"worktrees.space"(): Promise<{ id: string; bytes: number | null; blocker: string | null }[]>;
	/** Removes an open worktree's checkout to free space; selecting it (or resuming a session in it) reloads it. */
	"worktrees.unload"(id: string): Promise<void>;
	"worktrees.load"(id: string): Promise<void>;
	"worktrees.merge"(id: string): Promise<void>;
	/** A short phrase played on one instrument (General MIDI name, or "drums"), as OGG bytes: for choosing by ear. */
	"music.previewInstrument"(instrument: string): Promise<Uint8Array>;
	/** Each track of a piece on its own (OGG, same loop as the render), for muting tracks while listening. */
	"music.stems"(checkout: string | null, name: string): Promise<{ track: string; ogg: Uint8Array }[]>;
	"worktrees.discard"(id: string): Promise<void>;
	"worktrees.changedFiles"(id: string): Promise<{ path: string; change: "added" | "modified" | "deleted" }[]>;
	/** The files a session changed against its base (for warnings like "merging also brings …"). */
	"sessions.changedFiles"(id: string): Promise<{ path: string; change: "added" | "modified" | "deleted" }[]>;
	"sessions.raw"(id: string): Promise<string>;
	"sessions.merge"(id: string): Promise<void>;
	"sessions.discard"(id: string): Promise<void>;
	"sessions.markDone"(id: string): Promise<void>;
	"sessions.resume"(id: string): Promise<void>;
	/** Sessions closed over a week ago, kept in each repo's gitignored `.studio/archive/` (read when asked for). */
	"sessions.archived"(): Promise<SessionSummary[]>;
	/** Brings an archived session back, with its worktree's record and the other sessions archived with it. */
	"sessions.restore"(id: string): Promise<void>;
	"sessions.openTerminal"(id: string): Promise<void>;

	/** Release: release.json (or its defaults), what ships, past builds and the tools there are, for a checkout. */
	"release.info"(checkout: string | null): Promise<ReleaseInfo>;
	/** Builds, packages and checks a release (progress as release_progress events). */
	"release.build"(checkout: string | null, target: ReleaseTarget): Promise<ReleaseBuild>;
	/** Starts a built package in its own window (Windows under Wine). */
	"release.run"(checkout: string | null, version: string, target: ReleaseTarget): Promise<void>;
	/** Opens a build's package folder in the file manager. */
	"release.reveal"(checkout: string | null, version: string, target: ReleaseTarget): Promise<void>;
	/** Uploads a passing build to its itch.io channel with butler. */
	"release.publish"(checkout: string | null, version: string, target: ReleaseTarget): Promise<string>;
	/** butler status of the release's itch.io page. */
	"release.itchStatus"(checkout: string | null): Promise<string>;
	"itch.hasKey"(): Promise<boolean>;
	/** Saves the itch.io API key for butler (null removes it). */
	"itch.setKey"(key: string | null): Promise<void>;
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
	| { type: "login_prompt"; loginId: string; prompt: LoginPrompt }
	/** Edit → Undo/Redo (the app menu's shortcuts): text undo in a text field, else the worktree's manual-edit history. */
	| { type: "edit_command"; command: "undo" | "redo" }
	| { type: "release_progress"; checkout: string; target: ReleaseTarget; text: string };

/** What the preload exposes. */
export interface StudioBridge {
	call<M extends StudioMethod>(method: M, ...args: Parameters<StudioApi[M]>): ReturnType<StudioApi[M]>;
	onEvent(listener: (event: StudioEvent) => void): () => void;
}
