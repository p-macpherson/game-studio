import { create } from "zustand";
import type { StudioEvent } from "../shared/ipc";
import { type ModuleInfo, moduleOwns } from "../shared/modules";
import { type CheckoutId, MAX_RUN_PLAYERS, type RunInfo, type RunMode, type TestReport } from "../shared/run";
import type { AgentTypeInfo, ModelInfo, ProjectInfo, SessionSummary, Settings, Target, UpdateStatus, WorktreeSummary } from "../shared/types";
import type { HistoryStep } from "../shared/history";
import { call } from "./api";

export type View = "sessions" | "worktrees" | "source-control" | "settings" | "play" | "release" | `module:${string}`;

export type PlayTab = "run" | "tests";
export type SettingsTab = "general" | "appearance" | "accounts" | "agents";

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

/** An asset a module view should show. `checkout` also selects that worktree (null: main); a session id selects its worktree. */
export interface AssetFocus {
	path: string;
	checkout?: string | null;
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
	/** The conversation is being summarised to free up context. */
	compacting?: boolean;
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
	/**
	 * The worktree picked in the sidebar's selector, in any repo (game, engine or studio; null: main), remembered per
	 * project; and `worktree`: the game worktree the sections show and edit (the selection when it's a game
	 * worktree, else null: the game's main). And every worktree.
	 */
	selected: string | null;
	worktree: string | null;
	worktrees: WorktreeSummary[];
	/** The selected worktree's changed files (refreshed by the selector), for the sidebar's per-section counts. */
	worktreeChanges: { path: string; change: "added" | "modified" | "deleted" }[];
	/** The selected worktree's manual-edit history and unsaved files (refreshed with the selector). */
	history: { worktree: string; steps: HistoryStep[]; unsaved: string[] } | null;
	/** The worktree whose changes the Worktrees page shows (null: its list). */
	changesOf: string | null;
	openChanges(worktreeId: string | null): void;
	/** The worktree whose Merge dialog is open. */
	merging: string | null;
	openMerge(worktreeId: string | null): void;
	/** A short message shown for a moment (e.g. "Undid: Scene main: set Transform"). */
	notice: string | null;
	/** The stable install's updates (Settings → General; the sidebar shows when one is available). */
	update: UpdateStatus | null;
	refreshHistory(): Promise<void>;
	/** Undo/redo the latest manual edit in the selected worktree. */
	undo(): Promise<void>;
	redo(): Promise<void>;
	notify(text: string): void;

	/** Play & Test: which checkout to build/run/test, the current run, its console and latest frame. */
	playCheckout: CheckoutId;
	playTab: PlayTab;
	settingsTab: SettingsTab;
	run: RunInfo | null;
	runOutput: string;
	frame: { runId: string; src: string; width: number; height: number } | null;
	/** A multiplayer run's other copies of the game: each one's latest frame by player index (1 and up). */
	peerFrames: Record<number, { runId: string; src: string; width: number; height: number }>;
	/** How many copies of the game Play & Test starts (1: an ordinary run). */
	playPlayers: number;
	setPlayPlayers(n: number): void;
	testReports: Record<string, TestReport>;
	testsRunning: string[];

	refresh(): Promise<void>;
	refreshSessions(): Promise<void>;
	refreshModels(): Promise<void>;
	refreshWorktrees(): Promise<void>;
	selectWorktree(id: string | null): void;
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

const emptyTranscript = (): Transcript => ({ messages: [], runningTools: {} });

/** A worktree of the game project that's still being worked on: one the selector offers. */
/** Open: not merged or discarded (its folder may be unloaded to free space; selecting it loads it). */
export const isOpenProjectWorktree = (w: WorktreeSummary) => w.target === "project" && w.status === "active";
/** Open in any repo: the game's, the engine's or the studio's. */
export const isOpenWorktree = (w: WorktreeSummary) => w.status === "active";

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Undoes or redoes a manual edit in the selected worktree, then refreshes what shows it. */
async function historyStep(command: "undo" | "redo"): Promise<void> {
	const s = useStudio.getState();
	if (!s.worktree) return s.notify(`Nothing to ${command}: select a worktree`);
	try {
		const label = await call(command === "undo" ? "history.undo" : "history.redo", s.worktree);
		s.notify(`${command === "undo" ? "Undid" : "Redid"}: ${label}`);
		useStudio.setState((x) => ({ assetsVersion: x.assetsVersion + 1 }));
	} catch (err) {
		s.showError(err);
	}
	await useStudio.getState().refreshHistory();
}

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
	selected: null,
	worktree: null,
	worktrees: [],
	worktreeChanges: [],
	history: null,
	merging: null,
	changesOf: null,
	openChanges: (worktreeId) => set(worktreeId ? { changesOf: worktreeId, view: "worktrees" } : { changesOf: null }),
	openMerge: (worktreeId) => set({ merging: worktreeId }),
	notice: null,
	update: null,
	async refreshHistory() {
		const worktree = get().worktree;
		if (!worktree) return set({ history: null });
		const h = await call("history.get", worktree).catch(() => null);
		if (get().worktree === worktree) set({ history: h && { worktree, ...h } });
	},
	undo: () => historyStep("undo"),
	redo: () => historyStep("redo"),
	notify(text) {
		set({ notice: text });
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => set({ notice: null }), 3500);
	},
	playCheckout: null,
	playTab: "run",
	settingsTab: "general",
	run: null,
	runOutput: "",
	frame: null,
	peerFrames: {},
	playPlayers: Math.max(1, Math.min(MAX_RUN_PLAYERS, Number(localStorage.getItem("play-players")) || 1)),
	setPlayPlayers(n) {
		localStorage.setItem("play-players", String(n));
		set({ playPlayers: n });
	},
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
		void call("updates.status").then((update) => set({ update }), () => {});
		await Promise.all([get().refreshSessions(), get().refreshModels(), get().refreshWorktrees()]);
		// The worktree last selected in this project, if it's still open.
		const saved = project ? localStorage.getItem(`worktree:${project.path}`) : null;
		get().selectWorktree(saved && get().worktrees.some((w) => w.id === saved && isOpenWorktree(w)) ? saved : null);
	},
	async refreshWorktrees() {
		const worktrees = await call("worktrees.list");
		set({ worktrees });
		// A selected worktree that was merged or discarded leaves the selection at main.
		const selected = get().selected;
		if (selected && !worktrees.some((w) => w.id === selected && isOpenWorktree(w))) get().selectWorktree(null);
	},
	selectWorktree(id) {
		// An unloaded worktree (its folder removed to free space) is rebuilt from its branch first.
		const unloaded = id ? get().worktrees.find((w) => w.id === id && w.status === "active" && w.checkout === "removed") : undefined;
		if (unloaded) {
			get().notify(`Loading “${unloaded.label}”…`);
			void call("worktrees.load", unloaded.id)
				.then(() => get().refreshWorktrees())
				.then(() => get().selectWorktree(unloaded.id), (err) => get().showError(err));
			return;
		}
		const project = get().project;
		if (project) {
			if (id) localStorage.setItem(`worktree:${project.path}`, id);
			else localStorage.removeItem(`worktree:${project.path}`);
		}
		if (id === get().selected) return;
		// The sections show a game worktree; an engine or studio worktree leaves them on the game's main.
		const w = id ? get().worktrees.find((x) => x.id === id) : undefined;
		const game = w && w.target !== "project" ? null : id;
		if (game === get().worktree) return set({ selected: id });
		// Play & Test follows the game selection.
		set((s) => ({ selected: id, worktree: game, playCheckout: game, worktreeChanges: [], assetsVersion: s.assetsVersion + 1 }));
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
		if (focus.checkout !== undefined) {
			// A session id stands for its worktree (a project session's; others don't change the sections).
			const session = focus.checkout ? get().sessions.find((s) => s.id === focus.checkout) : undefined;
			const id = session ? (session.target === "project" ? session.worktreeId : get().worktree) : focus.checkout;
			get().selectWorktree(id);
		}
		const module = get().modules.find((m) => moduleOwns(m, focus.path));
		if (module) set({ view: `module:${module.id}`, focus: { path: focus.path, line: focus.line } });
	},
	openPlay(opts = {}) {
		set((s) => ({ view: "play", playCheckout: opts.checkout !== undefined ? opts.checkout : s.playCheckout, playTab: opts.tab ?? s.playTab }));
	},
	async startRun(mode) {
		const checkout = get().playCheckout;
		try {
			if (mode === "build") await call("run.build", checkout);
			else await call("run.start", checkout, mode, get().playPlayers > 1 ? { players: get().playPlayers } : undefined);
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
			case "update_status":
				set({ update: event.status });
				break;
			case "run_changed":
				set((s) => (s.run?.id === event.run.id ? { run: event.run } : { run: event.run, runOutput: "", frame: null, peerFrames: {} }));
				break;
			case "run_output":
				set((s) => (s.run?.id === event.runId ? { runOutput: (s.runOutput + event.text).slice(-OUTPUT_LIMIT) } : {}));
				break;
			case "run_frame":
				{
					const frame = { runId: event.runId, src: `data:${event.mime};base64,${event.image}`, width: event.width, height: event.height };
					if (event.player) set((s) => ({ peerFrames: { ...s.peerFrames, [event.player]: frame } }));
					else set({ frame });
				}
				break;
			case "test_report":
				set((s) => ({ testReports: { ...s.testReports, [testKey(event.report.sessionId, event.report.script)]: event.report } }));
				break;
			case "sessions_changed":
				void get().refreshSessions();
				void get().refreshWorktrees();
				break;
			case "project_changed":
				void get().refresh();
				break;
			case "assets_changed":
				set((s) => ({ assetsVersion: s.assetsVersion + 1 }));
				break;
			case "edit_command": {
				// In a text field, the text's own undo; elsewhere, the worktree's manual edits.
				const el = document.activeElement as HTMLElement | null;
				if (el && (el.matches("input, textarea, select") || el.isContentEditable)) document.execCommand(event.command);
				else void get()[event.command]();
				break;
			}
			case "focus_asset":
				get().showAsset({ path: event.path, checkout: event.sessionId ?? null, line: event.line });
				break;
			case "session_event":
				set((s) => {
					const t = s.transcripts[event.id];
					if (!t) return {};
					return { transcripts: { ...s.transcripts, [event.id]: applyEvent(t, event.event) } };
				});
				// A compaction replaced the conversation with a summary of it: read it again.
				if (event.event.type === "compaction_end" && get().transcripts[event.id]) void get().loadTranscript(event.id);
				break;
		}
	},
}));

function applyEvent(t: Transcript, ev: { type: string; [k: string]: unknown }): Transcript {
	const message = ev.message as ChatMessage | undefined;
	switch (ev.type) {
		case "message_start":
		case "message_update":
			return message?.role === "assistant" ? { ...t, streaming: message } : t;
		case "message_end": {
			if (!message || message.role === "system") return t;
			const last = t.messages.at(-1);
			const duplicate = last && last.role === message.role && last.timestamp === message.timestamp;
			return {
				...t,
				messages: duplicate ? t.messages : [...t.messages, message],
				streaming: message.role === "assistant" ? undefined : t.streaming,
			};
		}
		case "tool_execution_start":
			return { ...t, runningTools: { ...t.runningTools, [String(ev.toolCallId)]: String(ev.toolName) } };
		case "tool_execution_end": {
			const { [String(ev.toolCallId)]: _, ...rest } = t.runningTools;
			return { ...t, runningTools: rest };
		}
		case "agent_settled":
			return { ...t, runningTools: {}, streaming: undefined };
		case "compaction_start":
			return { ...t, compacting: true };
		case "compaction_end":
			return { ...t, compacting: false };
		default:
			return t;
	}
}
