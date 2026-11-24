import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import { PlayBuildService } from "./play-builds";
import { type RemoteServer, startRemoteServer } from "./remote-server";
import { makeRepo, tempDir, waitFor } from "./test-helpers";

let server: RemoteServer | undefined;
afterEach(() => server?.close());

it("builds a checkout to play, one at a time, and the remote page serves it under /play/<checkout>/", async () => {
	const root = tempDir();
	const repo = makeRepo(join(root, "game"));
	const events: StudioEvent[] = [];
	let finish: (() => void) | undefined;
	const plays = new PlayBuildService({
		dataDir: join(root, "play"),
		checkoutRoot: (c) => (c === "main" ? repo : join(root, c)),
		projectName: () => "Game",
		engineRepo: () => "",
		emit: (e) => events.push(e),
		// A stand-in for the web build: writes the page's files, and waits until told to finish.
		build: async ({ out, onProgress }) => {
			onProgress?.("Compiling for the web");
			mkdirSync(out, { recursive: true });
			writeFileSync(join(out, "index.html"), "<p>game</p>");
			writeFileSync(join(out, "index.wasm"), "wasm");
			await new Promise<void>((r) => (finish = r));
		},
	});
	expect(plays.status("main").state).toBe("none");

	plays.build("main");
	await waitFor(() => !!finish);
	expect(plays.status("main")).toMatchObject({ state: "building", step: "Compiling for the web" });
	expect(() => plays.build("main")).toThrow("being built already");
	finish!();
	await waitFor(() => plays.status("main").state === "ready");
	const built = plays.status("main");
	expect(built.commit).toBe(built.head); // built from the checkout's commit as it is
	expect(events.filter((e) => e.type === "play_build").map((e) => (e as { build: { state: string } }).build.state)).toEqual(["building", "building", "ready"]);

	server = await startRemoteServer({ port: 0, dispatch: async () => null, pageDir: join(root, "page"), fileOf: () => "", playDir: (c) => plays.dirOf(c), logins: () => [], allowLocal: true });
	// The game's page loads its files relative to /play/main/, so the bare path redirects there.
	const bare = await fetch(`${server.url}play/main`, { redirect: "manual" });
	expect(bare.status).toBe(302);
	expect(bare.headers.get("location")).toBe("/play/main/");
	const page = await fetch(`${server.url}play/main/`);
	expect(await page.text()).toBe("<p>game</p>");
	// The browser compiles a module only when it's served as wasm.
	expect((await fetch(`${server.url}play/main/index.wasm`)).headers.get("content-type")).toBe("application/wasm");
	expect((await fetch(`${server.url}play/main/..%2F..%2Fgame%2F.git%2Fconfig`)).status).toBe(404);
});
