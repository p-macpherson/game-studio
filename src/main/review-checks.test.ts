import { describe, expect, it } from "vitest";
import { checksLine } from "../shared/review";
import type { TestReport } from "../shared/run";
import { ReviewCheckService } from "./review-checks";

const report = (script: string, over: Partial<TestReport> = {}): TestReport => ({ script, sessionId: "w", ok: true, buildOk: true, exitCode: 0, steps: [], notRun: 0, diagnostics: [], screenshots: [], output: "", durationMs: 5, finishedAt: "", ...over });

describe("ReviewCheckService", () => {
	it("builds, runs every test, and checks a commit once", async () => {
		let head = "aaa";
		const ran: string[] = [];
		const svc = new ReviewCheckService({
			head: async () => head,
			compile: async () => (ran.push("build"), { ok: true, diagnostics: [], output: "" }),
			tests: () => ["tests/a.jsonl", "tests/b.jsonl"],
			test: async (_w, script) => (ran.push(script), script.endsWith("b.jsonl") ? report(script, { ok: false, steps: [{ line: 3, command: "expect", ok: false, error: "gold was 0" }] }) : report(script)),
			changed: () => {},
		});
		await svc.request("w");
		expect(ran).toEqual(["build", "tests/a.jsonl", "tests/b.jsonl"]);
		const r = svc.get("w")!;
		expect(r).toMatchObject({ state: "done", commit: "aaa", build: { ok: true } });
		expect(r.tests[1]).toMatchObject({ ok: false, problem: "Line 3 (expect): gold was 0" });
		expect(checksLine(r)).toEqual({ ok: false, text: "Builds · 1 of 2 tests fails" });
		await svc.request("w"); // same commit: nothing runs
		expect(ran).toHaveLength(3);
		head = "bbb";
		await svc.request("w");
		expect(ran).toHaveLength(6);
		await svc.request("w", true);
		expect(ran).toHaveLength(9);
	});

	it("stops at a build that fails, with the compiler's errors", async () => {
		const svc = new ReviewCheckService({
			head: async () => "aaa",
			compile: async () => ({ ok: false, diagnostics: [{ file: "game/main.odin", line: 4, column: 1, severity: "error", message: "Undeclared name: nope" }], output: "" }),
			tests: () => ["tests/a.jsonl"],
			test: async () => {
				throw new Error("no test should run");
			},
			changed: () => {},
		});
		await svc.request("w");
		expect(svc.get("w")).toMatchObject({ state: "done", build: { ok: false, errors: ["game/main.odin:4: Undeclared name: nope"] }, tests: [] });
		expect(checksLine(svc.get("w")!).text).toBe("Doesn't build");
	});
});
