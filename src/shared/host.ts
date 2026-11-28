/** Protocol between the main process and the session host utility process. */
import type { PastedImage } from "./attachments";
import type { ContextUsage, LoginNotice, LoginPrompt, ModelInfo, ProviderInfo, ThinkingLevel } from "./types";

export interface HostInfo {
	node: string;
	piVersion: string;
	providers: number;
}

export interface SessionOpenSpec {
	id: string;
	cwd: string;
	/** Folder Pi writes its JSONL into. */
	sessionDir: string;
	/** Existing transcript to reopen; absent for a new session. */
	sessionFile?: string;
	model: string;
	thinking?: ThinkingLevel;
	appendSystemPrompt: string[];
	skillPaths: string[];
	/** The studio tools it may use beyond the ones every session has; absent means all (see AgentTypeInfo.studioTools). */
	studioTools?: string[];
	/** Agent types this session may hand tasks to; with any, it gets the `delegate` tool. */
	delegatesTo?: DelegateTarget[];
}

/** A type a session may delegate to. `models`: the other models it may ask for (available ones only). */
export interface DelegateTarget {
	id: string;
	name: string;
	description: string;
	defaultModel?: string;
	models?: string[];
}

export type PromptMode = "steer" | "followUp";

/** Messages sent while the agent works, waiting in Pi's queues: steering after the current tool call, follow-ups after the run. */
export interface QueuedMessages {
	steering: string[];
	followUp: string[];
}

export interface HostApi {
	info(): HostInfo;
	providers(): ProviderInfo[];
	models(): Promise<ModelInfo[]>;
	/** Resolves when the login finishes. Progress arrives as `login_*` events tagged with `loginId`. */
	login(loginId: string, provider: string, type: "oauth" | "api_key"): Promise<void>;
	loginAnswer(loginId: string, value: string | null): void;
	logout(provider: string): Promise<void>;
	openSession(spec: SessionOpenSpec): Promise<{ sessionFile: string }>;
	isOpen(id: string): boolean;
	/** Starts a run (or queues into the running one) and returns immediately; progress arrives as events. */
	/** `images`: shown to the model with the text (left out for a model that can't take images). */
	prompt(id: string, text: string, mode?: PromptMode, images?: PastedImage[]): void;
	queued(id: string): QueuedMessages;
	/** Takes one message out of its queue (the others keep their order) and returns its text, or null if it was delivered meanwhile. */
	unqueue(id: string, mode: PromptMode, index: number): Promise<string | null>;
	abort(id: string): Promise<void>;
	closeSession(id: string): void;
	messages(id: string): unknown[];
	setModel(id: string, model: string): Promise<void>;
	/** How full the session's context window is (null: not known yet). */
	context(id: string): ContextUsage | null;
	/** Replaces the conversation so far with a summary of it, to free up context. Not while the agent runs. */
	compact(id: string): Promise<void>;
	answerQuestion(id: string, questionId: string, answer: string): void;
	/** Progress for a pending `studio_request` (shown as a tool update in the chat). */
	studioProgress(requestId: string, text: string): void;
	/** Completes a pending `studio_request`. */
	studioReply(requestId: string, ok: boolean, value: unknown): void;
}

/** Studio services an agent's tools can call in the main process (`studio_request`). */
export type StudioRequestMethod =
	| "open_in_studio"
	| "add_doc_image"
	| "save_release"
	| "delete_release"
	| "build_release"
	| "move_asset"
	| "write_doc"
	| "set_doc_status"
	| "add_standard_docs"
	| "generate_texture"
	| "make_texture"
	| "generate_ui_art"
	| "make_ui_art"
	| "edit_ui"
	| "preview_ui"
	| "check_shader"
	| "generate_particle_texture"
	| "make_particle_texture"
	| "preview_effect"
	| "write_effect"
	| "write_shader"
	| "preview_shader"
	| "generate_concepts"
	| "generate_image"
	| "add_images"
	| "delete_image"
	| "generate_model"
	| "retexture_model"
	| "rig_model"
	| "rig_prop"
	| "animate_model"
	| "finalize_model"
	| "preview_model"
	| "render_song"
	| "edit_song"
	| "edit_scene"
	| "preview_scene"
	| "capture_clip"
	| "check_scenario"
	| "generate_sound"
	| "render_sound"
	| "generate_voice"
	| "render_voice"
	| "edit_voice"
	| "edit_sound"
	| "delegate";

export type HostEvent =
	/** A raw Pi AgentSessionEvent, JSON-sanitised. */
	| { type: "session_event"; id: string; event: { type: string; [k: string]: unknown } }
	| { type: "session_error"; id: string; error: string }
	| { type: "studio_tool"; id: string; tool: "set_session_title" | "request_review" | "open_in_studio"; params: Record<string, string> }
	| { type: "ask_user"; id: string; questionId: string; question: string; options?: string[]; images?: string[] }
	/** A tool needs a main-process service; answered with `studioReply`. */
	| { type: "studio_request"; id: string; requestId: string; method: StudioRequestMethod; params: Record<string, unknown> }
	| { type: "studio_request_cancel"; id: string; requestId: string }
	| { type: "login_notice"; loginId: string; notice: LoginNotice }
	| { type: "login_prompt"; loginId: string; prompt: LoginPrompt };

export type HostRequest = { id: number; method: keyof HostApi; args: unknown[] };
export type HostMessage =
	| { kind: "reply"; id: number; ok: true; result: unknown }
	| { kind: "reply"; id: number; ok: false; error: string }
	| { kind: "event"; event: HostEvent };
