import { create } from "zustand";
import type { StudioEvent } from "../shared/ipc";
import { type ModuleInfo, moduleOwns } from "../shared/modules";
import type { CheckoutId, RunInfo, RunMode, TestReport } from "../shared/run";
import type { AgentTypeInfo, ModelInfo, ProjectInfo, SessionSummary, Settings, Target } from "../shared/types";
import { call } from "./api";

export type View = "sessions" | "source-control" | "settings" | "play" | `module:${string}`;

export type PlayTab = "run" | "tests";
export type SettingsTab = "general" | "accounts";

/** Key for a test report: which checkout, which script. */
export const testKey = (sessionId: CheckoutId, script: string) => `${sessionId ?? ""}:${script}`;

const OUTPUT_LIMIT = 200_000;

/** Pre-fills the New Session dialog, e.g. when started from an asset. */
export interface NewSessionPreset {
	agentType?: string;
	target?: Target;
	linkedAsset?: string;
	/** Shown above the prompt, e.g. "About docs/design/Combat.md". */
	context?: string;
	placeholder?: string;
	/** Pre-filled prompt text, e.g. compiler errors to fix. */
	prompt?: string;
}

/** An asset a module view should show, optionally as a session's draft. */
export interface AssetFocus {
	path: string;
	sessionId?: string;
	line?: number;
}

/** A Pi message as the renderer sees it (only the fields it draws). */
export interface ChatMessage {
	role: "user" | "assistant" | "toolResult" | string;
	content: string | ContentBlock[];
	timestamp?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "image"; [k: string]: unknown };

export interface Transcript {
	messages: ChatMessage[];
	streaming?: ChatMessage;
	runningTools: Record<string, string>;
	raw: string[];
}

interface State {
	project: ProjectInfo | null;
	settings: Settings | null;
	sessions: SessionSummary[];
	agentTypes: AgentTypeInfo[];
	models: ModelInfo[];
	view: View;
	selectedSession: string | null;
	transcripts: Record<string, Transcript>;
	error: string | null;
	newSession: NewSessionPreset | null;
	modules: ModuleInfo[];
	focus: AssetFocus | null;
	/** Bumped whenever assets may have changed, so module views refetch. */
	assetsVersion: number;

	/** Play & Test: which checkout to build/run/test, the current run, its console and latest frame. */
	playCheckout: CheckoutId;
	playTab: PlayTab;
	settingsTab: SettingsTab;
	run: RunInfo | null;
	runOutput: string;
	frame: { runId: string; src: string; width: number; height: number } | null;
	testReports: Record<string, TestReport>;
	testsRunning: string[];

	refresh(): Promise<void>;
	refreshSessions(): Promise<void>;
	refreshModels(): Promise<void>;
	setView(view: View): void;
	selectSession(id: string | null): void;
	loadTranscript(id: string): Promise<void>;
	showError(err: unknown): void;
	openNewSession(preset: NewSessionPreset | null): void;
	showAsset(focus: AssetFocus): void;
	openPlay(opts?: { checkout?: CheckoutId; tab?: PlayTab }): void;
	openSettings(tab: SettingsTab): void;
	startRun(mode: RunMode | "build"): Promise<void>;
	runTests(scripts: string[]): Promise<void>;
	handleEvent(event: StudioEvent): void;
}

const emptyTranscript = (): Transcript => ({ messages: [], runningTools: {}, raw: [] });
const RAW_LIMIT = 500;

export const useStudio = create<State>((set, get) => ({
	project: null,
	settings: null,
	sessions: [],
	agentTypes: [],
	models: [],
	view: "sessions",
	selectedSession: null,
	transcripts: {},
	error: null,
	newSession: null,
	modules: [],
	focus: null,
	assetsVersion: 0,
	playCheckout: null,
	playTab: "run",
	settingsTab: "general",
	run: null,
	runOutput: "",
	frame: null,
	testReports: {},
	testsRunning: [],

	async refresh() {
		const [project, settings, agentTypes, modules, run] = await Promise.all([
			call("project.current"),
			call("settings.get"),
			call("agentTypes.list"),
			call("modules.list"),
			call("run.current"),
		]);
		set((s) => ({ project, settings, agentTypes, modules, run, assetsVersion: s.assetsVersion + 1 }));
		await Promise.all([get().refreshSessions(), get().refreshModels()]);
	},
	async refreshSessions() {
		set({ sessions: await call("sessions.list") });
	},
	async refreshModels() {
		set({ models: await call("models.available") });
	},
	setView: (view) => set({ view }),
	selectSession(id) {
		set({ selectedSession: id, view: "sessions" });
		if (id) void get().loadTranscript(id);
	},
	async loadTranscript(id) {
		try {
			const messages = (await call("sessions.messages", id)) as ChatMessage[];
			set((s) => ({ transcripts: { ...s.transcripts, [id]: { ...emptyTranscript(), ...s.transcripts[id], messages, streaming: undefined } } }));
		} catch (err) {
			get().showError(err);
		}
	},
	showError: (err) => set({ error: err instanceof Error ? err.message : String(err) }),
	openNewSession: (preset) => set({ newSession: preset }),
	openSettings: (tab) => set({ view: "settings", settingsTab: tab }),
	showAsset(focus) {
		const module = get().modules.find((m) => moduleOwns(m, focus.path));
		if (module) set({ view: `module:${module.id}`, focus });
	},
	openPlay(opts = {}) {
		set((s) => ({ view: "play", playCheckout: opts.checkout !== undefined ? opts.checkout : s.playCheckout, playTab: opts.tab ?? s.playTab }));
	},
	async startRun(mode) {
		const checkout = get().playCheckout;
		try {
			if (mode === "build") await call("run.build", checkout);
			else await call("run.start", checkout, mode);
		} catch (err) {
			get().showError(err);
		}
	},
	async runTests(scripts) {
		const checkout = get().playCheckout;
		const keys = scripts.map((s) => testKey(checkout, s));
		set((s) => ({ testsRunning: [...s.testsRunning, ...keys] }));
		for (const script of scripts) {
			try {
				await call("run.test", checkout, script);
			} catch (err) {
				get().showError(err);
			} finally {
				set((s) => ({ testsRunning: s.testsRunning.filter((k) => k !== testKey(checkout, script)) }));
			}
		}
	},

	handleEvent(event) {
		switch (event.type) {
			case "run_changed":
				set((s) => (s.run?.id === event.run.id ? { run: event.run } : { run: event.run, runOutput: "", frame: null }));
				break;
			case "run_output":
				set((s) => (s.run?.id === event.runId ? { runOutput: (s.runOutput + event.text).slice(-OUTPUT_LIMIT) } : {}));
				break;
			case "run_frame":
				set({ frame: { runId: event.runId, src: `data:${event.mime};base64,${event.image}`, width: event.width, height: event.height } });
				break;
			case "test_report":
				set((s) => ({ testReports: { ...s.testReports, [testKey(event.report.sessionId, event.report.script)]: event.report } }));
				break;
			case "sessions_changed":
				void get().refreshSessions();
				break;
			case "project_changed":
				void get().refresh();
				break;
			case "assets_changed":
				set((s) => ({ assetsVersion: s.assetsVersion + 1 }));
				break;
			case "focus_asset":
				get().showAsset({ path: event.path, sessionId: event.sessionId, line: event.line });
				break;
			case "session_event":
				set((s) => {
					const t = s.transcripts[event.id];
					if (!t) return {};
					return { transcripts: { ...s.transcripts, [event.id]: applyEvent(t, event.event) } };
				});
				break;
		}
	},
}));

function applyEvent(t: Transcript, ev: { type: string; [k: string]: unknown }): Transcript {
	const raw = [...t.raw.slice(-RAW_LIMIT + 1), JSON.stringify(ev)];
	const message = ev.message as ChatMessage | undefined;
	switch (ev.type) {
		case "message_start":
		case "message_update":
			if (message?.role === "assistant") return { ...t, raw, streaming: message };
			return { ...t, raw };
		case "message_end": {
			if (!message || message.role === "system") return { ...t, raw };
			const last = t.messages.at(-1);
			const duplicate = last && last.role === message.role && last.timestamp === message.timestamp;
			return {
				...t,
				raw,
				messages: duplicate ? t.messages : [...t.messages, message],
				streaming: message.role === "assistant" ? undefined : t.streaming,
			};
		}
		case "tool_execution_start":
			return { ...t, raw, runningTools: { ...t.runningTools, [String(ev.toolCallId)]: String(ev.toolName) } };
		case "tool_execution_end": {
			const { [String(ev.toolCallId)]: _, ...rest } = t.runningTools;
			return { ...t, raw, runningTools: rest };
		}
		case "agent_settled":
			return { ...t, raw, runningTools: {}, streaming: undefined };
		default:
			return { ...t, raw };
	}
}
