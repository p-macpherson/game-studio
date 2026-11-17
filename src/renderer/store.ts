import { create } from "zustand";
import type { StudioEvent } from "../shared/ipc";
import type { AgentTypeInfo, ModelInfo, ProjectInfo, SessionSummary, Settings } from "../shared/types";
import { call } from "./api";

export type View = "sessions" | "source-control" | "accounts" | "settings";

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
	newSession: boolean;

	refresh(): Promise<void>;
	refreshSessions(): Promise<void>;
	refreshModels(): Promise<void>;
	setView(view: View): void;
	selectSession(id: string | null): void;
	loadTranscript(id: string): Promise<void>;
	showError(err: unknown): void;
	openNewSession(open: boolean): void;
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
	newSession: false,

	async refresh() {
		const [project, settings, agentTypes] = await Promise.all([call("project.current"), call("settings.get"), call("agentTypes.list")]);
		set({ project, settings, agentTypes });
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
	openNewSession: (open) => set({ newSession: open }),

	handleEvent(event) {
		switch (event.type) {
			case "sessions_changed":
				void get().refreshSessions();
				break;
			case "project_changed":
				void get().refresh();
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
