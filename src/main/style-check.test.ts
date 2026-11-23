import { describe, expect, it } from "vitest";
import type { ReviewItem } from "../shared/review";
import { StyleCheckService } from "./style-check";
import { waitFor } from "./test-helpers";

const item = (path: string, picture: boolean): ReviewItem => ({ path, name: path, module: { id: "3d-models", name: "3D Models", icon: "x" }, change: "added", files: [], ...(picture ? { preview: { kind: "image" as const, path: `${path}.png` } } : {}) });

describe("StyleCheckService", () => {
	it("asks about the art that has pictures and keeps the verdicts; a reply without any is a failure, not a pass", async () => {
		let reply = "a | drifts | too glossy";
		const briefs: string[] = [];
		const svc = new StyleCheckService({
			head: async () => "abc",
			items: async () => [item("a", true), item("b", false)],
			ask: async (_w, brief, started) => (briefs.push(brief), started("s1"), reply),
			changed: () => {},
		});
		await svc.start("w");
		await waitFor(() => svc.get("w")?.state !== "running");
		expect(briefs[0]).toContain("picture: a.png");
		expect(briefs[0]).not.toContain("- b ");
		expect(svc.get("w")).toMatchObject({ state: "done", commit: "abc", sessionId: "s1", notes: { a: { verdict: "drifts", reason: "too glossy" } } });
		reply = "Looks nice.";
		await svc.start("w");
		await waitFor(() => svc.get("w")?.state !== "running");
		expect(svc.get("w")).toMatchObject({ state: "failed", notes: {} });
		const none = new StyleCheckService({ head: async () => "abc", items: async () => [item("b", false)], ask: async () => "", changed: () => {} });
		await expect(none.start("w")).rejects.toThrow("no art with a picture");
	});
});
