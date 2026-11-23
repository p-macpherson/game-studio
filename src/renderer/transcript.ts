// How a session's transcript in the page is kept: a snapshot of its messages (sessions.messages) plus the events that
// follow. The two travel separately, so an event can arrive before the snapshot that already has its message, or
// after a snapshot taken before it: neither may lose a message or show one twice.

interface Message {
	role: string;
	timestamp?: number;
	toolCallId?: string;
}

export interface TranscriptState<M extends Message = Message> {
	messages: M[];
	streaming?: M;
	runningTools: Record<string, string>;
	compacting?: boolean;
}

export interface SessionEvent {
	type: string;
	[k: string]: unknown;
}

/** The same message: its role and time (and, for a tool's result, which call: results of one turn can share a time). */
const same = (a: Message, b: Message) => a.role === b.role && a.timestamp === b.timestamp && a.toolCallId === b.toolCallId;

/** How far back a finished message is looked for before it's added (events trail a snapshot by a few messages at most). */
const LOOK_BACK = 24;

export function applyEvent<M extends Message, T extends TranscriptState<M>>(t: T, ev: SessionEvent): T {
	const message = ev.message as M | undefined;
	switch (ev.type) {
		case "message_start":
		case "message_update":
			return message?.role === "assistant" ? { ...t, streaming: message } : t;
		case "message_end": {
			if (!message || message.role === "system") return t;
			const known = t.messages.slice(-LOOK_BACK).some((m) => same(m, message));
			return {
				...t,
				messages: known ? t.messages : [...t.messages, message],
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

/**
 * A fresh snapshot of the messages, with the events that arrived while it was being fetched applied on top: the ones
 * it already holds change nothing, the ones it was taken too early for are added.
 */
export function withSnapshot<M extends Message, T extends TranscriptState<M>>(t: T, messages: M[], during: SessionEvent[]): T {
	const start: T = { ...t, messages, streaming: undefined };
	return during.reduce((acc, ev) => applyEvent<M, T>(acc, ev), start);
}
