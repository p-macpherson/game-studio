import { describe, expect, it } from "vitest";
import { quitWarning } from "./quit-warning";

const s = (title: string, status: "in_progress" | "starting" | "idle" | "done" | "interrupted", over: { parentId?: string; pendingQuestion?: { questionId: string; question: string } } = {}) => ({ title, status, ...over });

describe("quitWarning", () => {
	it("says nothing when no session is in progress", () => {
		expect(quitWarning([s("a", "idle"), s("b", "done"), s("c", "interrupted")])).toBeNull();
	});

	it("names the sessions in progress, counts their sub-agents, and says they can be resumed", () => {
		const w = quitWarning([s("Cave lighting", "in_progress"), s("Rope physics", "starting"), s("Textures for the cave", "in_progress", { parentId: "p" }), s("Old one", "idle")])!;
		expect(w.message).toBe("2 sessions are still in progress");
		expect(w.detail).toContain("• Cave lighting\n• Rope physics");
		expect(w.detail).toContain("1 sub-agent is working for them too.");
		expect(w.detail).toContain("Quitting interrupts them");
		expect(w.detail).toContain("You can resume them");
		expect(w.detail).not.toContain("Old one");
	});

	it("counts a session waiting for an answer, and says so; one session reads in the singular", () => {
		const w = quitWarning([s("Which colour?", "in_progress", { pendingQuestion: { questionId: "q", question: "?" } })])!;
		expect(w.message).toBe("1 session is still in progress");
		expect(w.detail).toContain("• Which colour? (waiting for your answer)");
		expect(w.detail).toContain("Quitting interrupts it: whatever it is doing right now is cut off. You can resume it");
	});

	it("lists at most six by name", () => {
		const w = quitWarning(Array.from({ length: 9 }, (_, i) => s(`Session ${i + 1}`, "in_progress")))!;
		expect(w.detail).toContain("• Session 6\n• and 3 more");
		expect(w.detail).not.toContain("Session 7");
	});
});
