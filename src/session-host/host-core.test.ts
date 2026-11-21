import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { throttleUpdates } from "./host-core";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("forwards the latest streaming update at a bounded rate, and every other event in order", () => {
	const sent: string[] = [];
	const events = throttleUpdates((e: { type: string; n?: number }) => sent.push(e.n === undefined ? e.type : `${e.type}:${e.n}`), 50);
	events.push({ type: "message_start" });
	for (let n = 1; n <= 100; n++) events.push({ type: "message_update", n }); // a burst of tokens
	expect(sent).toEqual(["message_start"]);
	vi.advanceTimersByTime(50);
	expect(sent).toEqual(["message_start", "message_update:100"]);

	// An event that isn't an update sends the waiting update first: the message's last state is never lost or late.
	events.push({ type: "message_update", n: 101 });
	events.push({ type: "message_end" });
	expect(sent.slice(2)).toEqual(["message_update:101", "message_end"]);
	vi.advanceTimersByTime(200);
	expect(sent.length).toBe(4);

	// A closing session drops what's waiting.
	events.push({ type: "message_update", n: 102 });
	events.cancel();
	vi.advanceTimersByTime(200);
	expect(sent.length).toBe(4);
});
