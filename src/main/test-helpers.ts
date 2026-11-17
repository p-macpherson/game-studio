// Shared fixtures for main-process tests: temp git repos and an in-process session host.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostEvent } from "../shared/host";
import { HostCore } from "../session-host/host-core";
import type { HostCall, HostLink } from "./host-link";

export function tempDir(prefix = "gs-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function sh(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo on `main` with one commit. */
export function makeRepo(dir: string, files: Record<string, string> = { "README.md": "hello\n" }): string {
	mkdirSync(dir, { recursive: true });
	sh(dir, "init", "-q", "-b", "main");
	sh(dir, "config", "user.email", "test@example.com");
	sh(dir, "config", "user.name", "Test");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	sh(dir, "add", "-A");
	sh(dir, "commit", "-q", "-m", "init");
	return dir;
}

export async function inProcessHost(agentDir: string): Promise<HostLink & { core: HostCore }> {
	const listeners: ((e: HostEvent) => void)[] = [];
	const core = await HostCore.create({ agentDir, faux: true, post: (e) => queueMicrotask(() => listeners.forEach((l) => l(e))) });
	const call = (async (method: keyof HostCore, ...args: unknown[]) => (core[method] as (...a: unknown[]) => unknown).apply(core, args)) as HostCall;
	return { core, call, onEvent: (l) => listeners.push(l), onRestart: () => {} };
}

export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out waiting for condition");
		await new Promise((r) => setTimeout(r, 20));
	}
}
