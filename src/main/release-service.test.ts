import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import { nextRelease, parseReleaseConfig, parseReleases, type ReleaseBuild } from "../shared/release";
import { readReleaseConfig } from "./release";
import { ReleaseService, saveRelease } from "./release-service";
import { tempDir } from "./test-helpers";

function setup(build: Partial<ReleaseBuild>) {
	const root = tempDir();
	const data = tempDir();
	writeFileSync(join(root, "release.json"), JSON.stringify({ name: "Ship Test", version: "1.2.3", itch: { target: "someone/ship-test", channels: { windows: "win" } } }));
	const dir = join(root, "builds/1.2.3/windows/ship-test");
	mkdirSync(dir, { recursive: true });
	const record: ReleaseBuild = { target: "windows", version: "1.2.3", dir: "builds/1.2.3/windows/ship-test", archives: [], checks: [], ok: true, files: 1, bytes: 1, builtAt: "2026-11-21T00:00:00Z", ...build };
	writeFileSync(join(root, "builds/1.2.3/windows/build.json"), JSON.stringify(record));
	// A stand-in for butler that records its arguments.
	const butler = join(data, "fake-butler.sh");
	writeFileSync(butler, `#!/bin/sh\necho "$@" > "${data}/butler-args"\necho "pushed"\n`);
	chmodSync(butler, 0o755);
	const events: StudioEvent[] = [];
	const asked: { checkout: string | null; title: string; prompt: string }[] = [];
	const service = new ReleaseService({
		checkoutRoot: () => root,
		projectName: () => "Ship Test",
		engineRepo: () => "",
		dataDir: data,
		emit: (e) => events.push(e),
		butler,
		investigate: async (checkout, title, prompt) => {
			asked.push({ checkout, title, prompt });
			return `session-${asked.length}`;
		},
	});
	return { root, data, service, events, asked };
}

describe("ReleaseService", () => {
	it("publishes a passing build to its itch.io channel with the version", async () => {
		const { root, data, service } = setup({});
		await expect(service.publish(null, "1.2.3", "windows")).rejects.toThrow(/API key/);
		service.setItchKey("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
		expect(statSync(join(data, "itch/butler_creds")).mode & 0o777).toBe(0o600);
		await service.publish(null, "1.2.3", "windows");
		expect(readFileSync(join(data, "butler-args"), "utf8").trim()).toBe(
			`push ${join(root, "builds/1.2.3/windows/ship-test")} someone/ship-test:win --userversion 1.2.3 -i ${join(data, "itch/butler_creds")}`,
		);
	});

	it("refuses to publish a build with failed checks", async () => {
		const { service } = setup({ ok: false });
		service.setItchKey("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
		await expect(service.publish(null, "1.2.3", "windows")).rejects.toThrow(/failed checks/);
	});

	it("refuses something that isn't an API key", () => {
		const { service } = setup({});
		expect(() => service.setItchKey("my password")).toThrow(/API key/);
		expect(service.hasItchKey()).toBe(false);
	});

	it("keeps releases as a list, newest first, and still reads a release.json from before that", () => {
		const root = tempDir();
		// No file: no releases, and a build falls back to the project's name at 0.1.0.
		expect(readReleaseConfig(root, "X")).toEqual({ config: { name: "X", version: "0.1.0", icon: undefined, include: [], exclude: [], itch: undefined }, problems: [] });
		const first = { ...parseReleaseConfig(undefined, "X").config, version: "1.0.0", include: ["sounds/a/*"], itch: { target: "me/x" } };
		saveRelease(root, "X", first);
		const second = nextRelease([first], "X");
		expect(second).toMatchObject({ version: "1.0.1", include: ["sounds/a/*"], itch: { target: "me/x" } });
		saveRelease(root, "X", second);
		expect(() => saveRelease(root, "X", second)).toThrow(/already a release 1.0.1/);
		saveRelease(root, "X", { ...first, name: "Renamed" }, "1.0.0");
		const read = parseReleases(readFileSync(join(root, "release.json"), "utf8"), "X");
		expect(read.problems).toEqual([]);
		expect(read.releases.map((r) => [r.version, r.name])).toEqual([
			["1.0.1", "X"],
			["1.0.0", "Renamed"],
		]);
		expect(readReleaseConfig(root, "X").config.version).toBe("1.0.1");
		expect(readReleaseConfig(root, "X", "1.0.0").config.name).toBe("Renamed");
		expect(readReleaseConfig(root, "X", "9.9.9").problems).toEqual(["there's no release 9.9.9"]);
		// The old single-object file, with its platforms list: one release, the list ignored.
		expect(parseReleases('{"name": "Old", "version": "0.3.0", "targets": ["web"]}', "X").releases).toEqual([{ name: "Old", version: "0.3.0", icon: undefined, include: [], exclude: [], itch: undefined }]);
	});

	it("records a build that fails outright and puts a session on it, once", async () => {
		const { root, service, events, asked } = setup({});
		// This project has no engine, so the build can't even start compiling.
		await expect(service.build(null, "1.2.3", "linux")).rejects.toThrow(/release\.sh/);
		const failed = service.info(null).builds.find((b) => b.target === "linux")!;
		expect(failed).toMatchObject({ version: "1.2.3", ok: false, investigation: "session-1" });
		expect(failed.error).toMatch(/release\.sh/);
		expect(asked).toHaveLength(1);
		expect(asked[0].title).toBe("Linux build of 1.2.3 failed");
		expect(asked[0].prompt).toMatch(/the build failed: no package was made/);
		expect(asked[0].prompt).toContain('{"target": "linux", "version": "1.2.3"}');
		expect(service.info(null).building).toBeNull();
		expect(events.filter((e) => e.type === "release_changed")).toHaveLength(2);
		// Asking again opens the same session; a failed build can't be run.
		expect(await service.investigate(null, "1.2.3", "linux")).toBe("session-1");
		expect(asked).toHaveLength(1);
		await expect(service.run(null, "1.2.3", "linux")).rejects.toThrow(/no linux build/);
		expect(existsSync(join(root, "builds/1.2.3/windows/build.json"))).toBe(true);
	});

	it("puts a session on a build with failed checks only when asked, and deletes a release's builds", async () => {
		const { root, service, asked } = setup({ ok: false, checks: [{ name: "tests/smoke.jsonl", ok: false, detail: "sound not found: assets/sounds/a/a.ogg" }] });
		expect(asked).toHaveLength(0);
		expect(await service.investigate(null, "1.2.3", "windows")).toBe("session-1");
		expect(asked[0].prompt).toMatch(/one of its checks failed/);
		expect(asked[0].prompt).toContain("sound not found: assets/sounds/a/a.ogg");
		expect(service.info(null).builds[0].investigation).toBe("session-1");
		await expect(service.investigate(null, "1.2.3", "web")).rejects.toThrow(/no web build/);
		service.deleteBuilds(null, "1.2.3");
		expect(existsSync(join(root, "builds/1.2.3"))).toBe(false);
		expect(() => service.deleteBuilds(null, "../x")).toThrow(/isn't a version/);
	});
});
