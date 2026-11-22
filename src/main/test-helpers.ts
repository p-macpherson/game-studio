// Shared fixtures for main-process tests: temp git repos and an in-process session host.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { HostEvent } from "../shared/host";
import { HostCore } from "../session-host/host-core";
import type { HostCall, HostLink } from "./host-link";

/** Temp folders this test file made: removed when it finishes (/tmp is RAM here; thousands of them once filled it). */
const made: string[] = [];
afterAll(async () => {
	const dirs = made.splice(0);
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	// Pi's model runtime saves auth.json and models-store.json asynchronously, and a save landing after the removal
	// brings a session host's folder back: remove once more after it has had time to land.
	await new Promise((r) => setTimeout(r, 500));
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = "gs-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
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

export async function inProcessHost(agentDir: string): Promise<HostLink & { core: HostCore; emit(e: HostEvent): void }> {
	const listeners: ((e: HostEvent) => void)[] = [];
	const core = await HostCore.create({ agentDir, faux: true, post: (e) => queueMicrotask(() => listeners.forEach((l) => l(e))) });
	const call = (async (method: keyof HostCore, ...args: unknown[]) => (core[method] as (...a: unknown[]) => unknown).apply(core, args)) as HostCall;
	// `emit` injects a host event, as if the session host had posted it.
	return { core, call, onEvent: (l) => listeners.push(l), onRestart: () => {}, emit: (e: HostEvent) => listeners.forEach((l) => l(e)) };
}

export async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("timed out waiting for condition");
		await new Promise((r) => setTimeout(r, 20));
	}
}
