import { create } from "zustand";
import type { StudioEvent } from "../shared/ipc";
import { type ModuleInfo, moduleOwns } from "../shared/modules";
import { type CheckoutId, MAX_RUN_PLAYERS, type RunInfo, type RunMode, type TestReport } from "../shared/run";
import type { AgentTypeInfo, ModelInfo, ProjectInfo, SessionSummary, Settings, Target, UpdateStatus, WorktreeSummary } from "../shared/types";
import type { HistoryStep } from "../shared/history";
import type { SessionAssets } from "../shared/session-assets";
import { call } from "./api";
import { type SessionEvent, applyEvent, withSnapshot } from "./transcript";
import { NavHistory, type Place, placeKey, placeOf } from "./nav-history";

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
	/** A request to the model failed and the session is waiting to try it again by itself (transcript.ts). */
	retrying?: { attempt: number; maxAttempts: number; delayMs: number; startedAt: number; error: string };
	/** Messages sent while the agent worked, waiting to be delivered (transcript.ts). */
	queued?: { steering: string[]; followUp: string[] };
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
	/** Each session's asset cards and mentions for its chat (sessions.assets), as last read. */
	sessionAssets: Record<string, SessionAssets>;
	loadSessionAssets(id: string): Promise<void>;
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
	/** `file`: the file to show first. */
	openChanges(worktreeId: string | null, file?: string): void;
	changesFile: string | null;
	/** The worktree whose Review page the Worktrees page shows (under its changes, when those are open too). */
	reviewOf: string | null;
	openReview(worktreeId: string | null): void;
	/** The worktree whose Merge dialog is open. */
	merging: string | null;
	openMerge(worktreeId: string | null): void;
	/** A short message shown for a moment (e.g. "Undid: Scene main: set Transform"). */
	notice: string | null;
	/** The stable install's updates (Settings → General; the sidebar shows when one is available). */
	update: UpdateStatus | null;
	/** Images shown full size over the studio (an agent's screenshots: open_in_studio, a question's images). */
	viewer: { images: { src: string; label: string }[]; index: number } | null;
	showImages(images: { src: string; label: string }[], index?: number): void;
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
	/** The scenario Play & Test starts the game as (its path), or null: the game from its start. */
	playScenario: string | null;
	setPlayScenario(path: string | null): void;
	testReports: Record<string, TestReport>;
	testsRunning: string[];

	refresh(): Promise<void>;
	refreshSessions(): Promise<void>;
	refreshModels(): Promise<void>;
	refreshWorktrees(): Promise<void>;
	selectWorktree(id: string | null): void;
	setView(view: View): void;
	/** Whether there is a place to go back or forward to (see nav-history.ts), and going there. */
	canGoBack: boolean;
	canGoForward: boolean;
	goBack(): void;
	goForward(): void;
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
/** Per session: the events that have arrived during each fetch of its messages still in flight. */
const loading = new Map<string, Set<SessionEvent[]>>();

/** A worktree of the game project that's still being worked on: one the selector offers. */
/** Open: not merged or discarded (its folder may be unloaded to free space; selecting it loads it). */
export const isOpenProjectWorktree = (w: WorktreeSummary) => w.target === "project" && w.status === "active";
/** Open in any repo: the game's, the engine's or the studio's. */
export const isOpenWorktree = (w: WorktreeSummary) => w.status === "active";

/** The worktree a session's work is in while it's open; null (main) once it's merged or discarded. */
export function sessionWorktree(s: Pick<SessionSummary, "worktreeId" | "worktree">, worktrees: WorktreeSummary[]): string | null {
	return s.worktree === "active" && worktrees.some((w) => w.id === s.worktreeId && isOpenWorktree(w)) ? s.worktreeId : null;
}

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

/** The parameter values last used for a scenario in this project (kept on this machine). */
export const scenarioValuesKey = (project: string | undefined, path: string) => `scenario-values:${project ?? ""}:${path}`;
export function savedScenarioValues(project: string | undefined, path: string): Record<string, unknown> {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(scenarioValuesKey(project, path)) ?? "{}");
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
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
	sessionAssets: {},
	async loadSessionAssets(id) {
		const found = await call("sessions.assets", id).catch(() => null);
		if (found) set((s) => ({ sessionAssets: { ...s.sessionAssets, [id]: found } }));
	},
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
	changesFile: null,
	openChanges: (worktreeId, file) => set(worktreeId ? { changesOf: worktreeId, changesFile: file ?? null, view: "worktrees" } : { changesOf: null, changesFile: null }),
	reviewOf: null,
	openReview: (worktreeId) => set(worktreeId ? { reviewOf: worktreeId, changesOf: null, view: "worktrees" } : { reviewOf: null }),
	openMerge: (worktreeId) => set({ merging: worktreeId }),
	notice: null,
	update: null,
	viewer: null,
	showImages: (images, index = 0) => set({ viewer: images.length ? { images, index } : null }),
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
	playScenario: null,
	setPlayScenario: (path) => set({ playScenario: path }),
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
		// Nothing of the last worktree stays open: the section's asset (its view starts afresh, keyed by the worktree in
		// main.tsx) and a session of another worktree. A session being opened is the reason for the switch, so it stays.
		const open = get().sessions.find((x) => x.id === get().selectedSession);
		const reset = { focus: null, ...(open && sessionWorktree(open, get().worktrees) === id ? {} : { selectedSession: null }) };
		// The sections show a game worktree; an engine or studio worktree leaves them on the game's main.
		const w = id ? get().worktrees.find((x) => x.id === id) : undefined;
		const game = w && w.target !== "project" ? null : id;
		if (game === get().worktree) return set({ selected: id, ...reset });
		// Play & Test follows the game selection.
		set((s) => ({ selected: id, worktree: game, playCheckout: game, worktreeChanges: [], assetsVersion: s.assetsVersion + 1, ...reset }));
	},
	async refreshSessions() {
		const sessions = await call("sessions.list");
		// A session cut off mid-work never reports its tools ending: nothing of it is running or being written any more.
		set((s) => {
			const stale = sessions.filter((x) => x.status === "interrupted" && s.transcripts[x.id] && (Object.keys(s.transcripts[x.id].runningTools).length > 0 || s.transcripts[x.id].streaming || s.transcripts[x.id].compacting));
			if (!stale.length) return { sessions };
			const transcripts = { ...s.transcripts };
			for (const x of stale) transcripts[x.id] = { ...transcripts[x.id], runningTools: {}, streaming: undefined, compacting: false };
			return { sessions, transcripts };
		});
	},
	async refreshModels() {
		set({ models: await call("models.available") });
	},
	setView: (view) => set({ view }),
	canGoBack: false,
	canGoForward: false,
	goBack: () => navigate(-1),
	goForward: () => navigate(1),
	selectSession(id) {
		set({ selectedSession: id, view: "sessions" });
		if (!id) return;
		// Opening a session selects the worktree its work is in (main once that's merged), from wherever it was opened.
		const follow = () => {
			const session = get().sessions.find((x) => x.id === id);
			if (session && get().selectedSession === id) get().selectWorktree(sessionWorktree(session, get().worktrees));
			return !!session;
		};
		// A session just started (perhaps in a new worktree) may not be in the lists yet.
		if (!follow()) void Promise.all([get().refreshSessions(), get().refreshWorktrees()]).then(follow, () => {});
		void get().loadTranscript(id);
	},
	async loadTranscript(id) {
		// Events that arrive while the snapshot is fetched are kept and applied on top of it: the snapshot and the
		// events travel separately, so either can be the newer one (see transcript.ts).
		const during: SessionEvent[] = [];
		const waiting = loading.get(id) ?? new Set<SessionEvent[]>();
		loading.set(id, waiting.add(during));
		try {
			const queued = await call("sessions.queued", id);
			const messages = (await call("sessions.messages", id)) as ChatMessage[];
			set((s) => ({ transcripts: { ...s.transcripts, [id]: withSnapshot<ChatMessage, Transcript>({ ...emptyTranscript(), ...s.transcripts[id], queued }, messages, during) } }));
		} catch (err) {
			get().showError(err);
		} finally {
			waiting.delete(during);
			if (!waiting.size) loading.delete(id);
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
			else {
				const scenario = get().playScenario;
				await call("run.start", checkout, mode, {
					...(get().playPlayers > 1 ? { players: get().playPlayers } : {}),
					...(scenario ? { scenario: { path: scenario, values: savedScenarioValues(get().project?.path, scenario) } } : {}),
				});
			}
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
			case "session_event":
				for (const during of loading.get(event.id) ?? []) during.push(event.event);
				set((s) => {
					const t = s.transcripts[event.id];
					if (!t) return {};
					return { transcripts: { ...s.transcripts, [event.id]: applyEvent<ChatMessage, Transcript>(t, event.event) } };
				});
				// A compaction replaced the conversation with a summary of it: read it again.
				if (event.event.type === "compaction_end" && get().transcripts[event.id]) void get().loadTranscript(event.id);
				break;
		}
	},
}));

// ── Back and forward ──────────────────────────────────────────────────────────────────────────────────────────────

const visited = new NavHistory();
/** Set while a place from the history is being restored, so restoring it isn't recorded as a new visit. */
let restoring = false;
let settle: ReturnType<typeof setTimeout> | undefined;
let lastKey = "";
let lastProject: string | undefined;

const place = (s: State): Place => placeOf(s, (view, path) => !!s.modules.find((m) => view === `module:${m.id}` && moduleOwns(m, path)));

/** A place still exists while its session, and the worktrees it needs, do. */
function exists(p: Place): boolean {
	const s = useStudio.getState();
	const open = (id: string | null) => !id || s.worktrees.some((w) => w.id === id && isOpenWorktree(w));
	if (p.session && !s.sessions.some((x) => x.id === p.session)) return false;
	return open(p.worktree) && open(p.review) && open(p.changes);
}

const publish = () => useStudio.setState({ canGoBack: visited.peek(-1, exists) !== null, canGoForward: visited.peek(1, exists) !== null });

function navigate(step: -1 | 1): void {
	// A move still being noted belongs in the history before stepping through it.
	if (settle) {
		clearTimeout(settle);
		settle = undefined;
		visited.visit(place(useStudio.getState()));
	}
	const to = visited.go(step, exists);
	if (!to) return;
	restoring = true;
	const s = useStudio.getState();
	if (to.worktree !== s.selected) s.selectWorktree(to.worktree);
	useStudio.setState({
		view: to.view as View,
		...(to.view === "sessions" ? { selectedSession: to.session } : {}),
		...(to.asset ? { focus: { path: to.asset } } : {}),
		...(to.view === "worktrees" ? { reviewOf: to.review, changesOf: to.changes, changesFile: to.changesFile } : {}),
		...(to.settingsTab ? { settingsTab: to.settingsTab as SettingsTab } : {}),
	});
	if (to.session) void useStudio.getState().loadTranscript(to.session);
	lastKey = placeKey(place(useStudio.getState()));
	restoring = false;
	publish();
}

// Every change of place is a visit. One click can change the place in several steps (the worktree, then the page,
// then the section opening an asset), so the place is read once things have settled.
useStudio.subscribe((s) => {
	if (s.project?.path !== lastProject) {
		lastProject = s.project?.path;
		visited.reset();
		lastKey = "";
	}
	if (restoring) return;
	const key = placeKey(place(s));
	if (key === lastKey) return;
	lastKey = key;
	clearTimeout(settle);
	settle = setTimeout(() => {
		settle = undefined;
		visited.visit(place(useStudio.getState()));
		publish();
	}, 150);
});

