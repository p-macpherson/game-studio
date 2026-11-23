import { describe, expect, it } from "vitest";
import { KeepAwake, isWorking } from "./keep-awake";

describe("KeepAwake", () => {
	it("holds sleep off once while agents work, and lets go when none do", () => {
		const log: string[] = [];
		let next = 1;
		const awake = new KeepAwake({ start: () => (log.push("start"), next++), stop: (id) => void log.push(`stop ${id}`) });
		awake.update(false);
		awake.update(true);
		awake.update(true); // another session starts: still one hold
		expect(awake.active).toBe(true);
		awake.update(false);
		awake.update(false);
		awake.update(true);
		expect(log).toEqual(["start", "stop 1", "start"]);
	});

	it("counts a session as working unless it's idle, done, interrupted, or waiting for an answer", () => {
		const q = { questionId: "q", question: "?" };
		expect(isWorking({ status: "in_progress" })).toBe(true);
		expect(isWorking({ status: "starting" })).toBe(true);
		expect(isWorking({ status: "in_progress", pendingQuestion: q })).toBe(false);
		for (const status of ["idle", "done", "interrupted"] as const) expect(isWorking({ status })).toBe(false);
	});
});
