import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import { MODULES } from "./assets";
import { openInStudioRequests } from "./open-in-studio";
import { tempDir } from "./test-helpers";

function setup() {
	const cwd = tempDir();
	for (const [p, t] of Object.entries({ "docs/design/Art Style.md": "# Art", "build/review/1-map.png": "png", "build/log.txt": "log" })) {
		mkdirSync(join(cwd, p, ".."), { recursive: true });
		writeFileSync(join(cwd, p), t);
	}
	const events: StudioEvent[] = [];
	const adopted: string[] = [];
	const open = openInStudioRequests(MODULES.map((m) => m.info), (e) => events.push(e), (_id, p) => adopted.push(p)).open_in_studio!;
	const run = (path: string) => Promise.resolve().then(() => open.run({ cwd, sessionId: "s1" }, { path })) as Promise<string>;
	return { cwd, events, adopted, run };
}

describe("open_in_studio", () => {
	it("opens an asset in its section, and the session adopts it", async () => {
		const { events, adopted, run } = setup();
		expect(await run("docs/design/Art Style.md")).toBe("Opened docs/design/Art Style.md in the Design Docs section.");
		expect(events).toEqual([{ type: "focus_asset", path: "docs/design/Art Style.md", sessionId: "s1" }]);
		expect(adopted).toEqual(["docs/design/Art Style.md"]);
	});

	it("shows an image anywhere in the checkout in the image viewer", async () => {
		const { events, adopted, run } = setup();
		expect(await run("build/review/1-map.png")).toBe("Showed build/review/1-map.png to the user in the image viewer.");
		expect(events).toEqual([{ type: "show_images", sessionId: "s1", paths: ["build/review/1-map.png"] }]);
		expect(adopted).toEqual([]);
	});

	it("tells the agent when a file can't be shown, with its full path, and when there's none", async () => {
		const { cwd, events, run } = setup();
		expect(await run("build/log.txt")).toBe(
			`Game Studio has no view for build/log.txt: it shows assets in its sections, design docs and images. The user hasn't seen it; describe what it shows, or give its full path: ${join(cwd, "build/log.txt")}`,
		);
		await expect(run("build/nope.png")).rejects.toThrow("There's no file at build/nope.png");
		expect(events).toEqual([]);
	});
});
