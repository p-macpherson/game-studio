import { describe, expect, it } from "vitest";
import { type SessionEvent, type TranscriptState, applyEvent, withSnapshot } from "./transcript";

const m = (role: string, timestamp: number, toolCallId?: string): { role: string; timestamp?: number; toolCallId?: string } => ({ role, timestamp, ...(toolCallId ? { toolCallId } : {}) });
const end = (message: object): SessionEvent => ({ type: "message_end", message });
const empty = (): TranscriptState => ({ messages: [], runningTools: {} });
const roles = (t: TranscriptState) => t.messages.map((x) => x.role).join(",");

describe("transcript", () => {
	const user = m("user", 1);
	const call = m("assistant", 2);
	const result = m("toolResult", 3, "c1");
	const reply = m("assistant", 4);

	it("keeps a message whose event arrived before a snapshot taken too early for it", () => {
		// The agent's tool-calling message ended while the snapshot (the person's message only) was on its way back.
		const t = withSnapshot(empty(), [user], [end(user), end(call)]);
		expect(roles(t)).toBe("user,assistant");
		expect(roles([end(result), end(reply)].reduce(applyEvent, t))).toBe("user,assistant,toolResult,assistant");
	});

	it("doesn't show messages twice when their events trail a snapshot that already has them", () => {
		// The snapshot has both; their events arrive afterwards, the older one first.
		const t = [end(user), end(call), end(result), end(reply)].reduce(applyEvent, withSnapshot(empty(), [user, call], []));
		expect(roles(t)).toBe("user,assistant,toolResult,assistant");
	});

	it("keeps two tool results of one turn that share a timestamp", () => {
		const t = [end(m("toolResult", 3, "c1")), end(m("toolResult", 3, "c2")), end(m("toolResult", 3, "c2"))].reduce(applyEvent, empty());
		expect(t.messages.map((x) => x.toolCallId)).toEqual(["c1", "c2"]);
	});

	it("a later snapshot replaces what events built, without losing what came during its fetch", () => {
		const live = [end(user), end(call)].reduce(applyEvent, empty());
		const t = withSnapshot({ ...live, streaming: m("assistant", 9) }, [user, call, result], [end(result), end(reply)]);
		expect(roles(t)).toBe("user,assistant,toolResult,assistant");
		expect(t.streaming).toBeUndefined();
	});
});
