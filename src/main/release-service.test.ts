import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StudioEvent } from "../shared/ipc";
import { parseReleaseConfig, type ReleaseBuild } from "../shared/release";
import { ReleaseService, writeReleaseConfig } from "./release-service";
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
	const service = new ReleaseService({ checkoutRoot: () => root, projectName: () => "Ship Test", engineRepo: () => "", dataDir: data, emit: (e) => events.push(e), butler });
	return { root, data, service, events };
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

	it("writes release.json that reads back the same", () => {
		const root = tempDir();
		const config = { ...parseReleaseConfig(undefined, "X").config, version: "2.0.0", include: ["sounds/a/*"], itch: { target: "me/x" } };
		writeReleaseConfig(root, config);
		expect(parseReleaseConfig(readFileSync(join(root, "release.json"), "utf8"), "X")).toEqual({ config, problems: [] });
	});
});
