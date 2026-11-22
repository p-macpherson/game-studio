import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "./assets";
import { openInStudioRequests } from "./open-in-studio";
import { tempDir } from "./test-helpers";

function setup() {
	const cwd = tempDir();
	for (const [p, t] of Object.entries({ "docs/design/Art Style.md": "# Art", "build/review/1-map.png": "png", "build/log.txt": "log" })) {
		mkdirSync(join(cwd, p, ".."), { recursive: true });
		writeFileSync(join(cwd, p), t);
	}
	const adopted: string[] = [];
	const open = openInStudioRequests(MODULES.map((m) => m.info), (_id, p) => adopted.push(p)).open_in_studio!;
	const run = (path: string) => Promise.resolve().then(() => open.run({ cwd, sessionId: "s1" }, { path })) as Promise<string>;
	return { cwd, adopted, run };
}

describe("open_in_studio", () => {
	it("answers for an asset without moving the user, and the session adopts it", async () => {
		const { adopted, run } = setup();
		expect(await run("docs/design/Art Style.md")).toBe("Put a card for docs/design/Art Style.md in the conversation: the user can open it in the Design Docs section from there. They haven't necessarily looked yet.");
		expect(adopted).toEqual(["docs/design/Art Style.md"]);
	});

	it("answers for an image anywhere in the checkout", async () => {
		const { adopted, run } = setup();
		expect(await run("build/review/1-map.png")).toBe("Put build/review/1-map.png in the conversation as a picture the user can click to enlarge. They haven't necessarily looked yet.");
		expect(adopted).toEqual([]);
	});

	it("tells the agent when a file can't be shown, with its full path, and when there's none", async () => {
		const { cwd, run } = setup();
		expect(await run("build/log.txt")).toBe(
			`Game Studio has no view for build/log.txt: it shows assets in its sections, design docs and images. The user hasn't seen it; describe what it shows, or give its full path: ${join(cwd, "build/log.txt")}`,
		);
		await expect(run("build/nope.png")).rejects.toThrow("There's no file at build/nope.png");
	});
});
