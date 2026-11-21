import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostApi, HostEvent, HostMessage } from "../shared/host";

export type HostCall = <M extends keyof HostApi>(method: M, ...args: Parameters<HostApi[M]>) => Promise<Awaited<ReturnType<HostApi[M]>>>;

/** How the main process reaches the session host: a utility process in the app, in-process in tests. */
export interface HostLink {
	call: HostCall;
	onEvent(listener: (event: HostEvent) => void): void;
	/** Called when the host died and was restarted: every live Pi session is gone. */
	onRestart(listener: () => void): void;
}

type Pending = { resolve(value: unknown): void; reject(err: Error): void; timer?: NodeJS.Timeout };

/** Calls that wait on a person or on a running agent have no time limit; the rest answer at once or something is wrong. */
const UNTIMED = new Set<keyof HostApi>(["login", "logout", "abort"]);
const SLOW: Partial<Record<keyof HostApi, number>> = { openSession: 120_000 };
const CALL_TIMEOUT_MS = 30_000;
/** A host that dies again within this long of starting is failing, not unlucky: wait longer before each restart. */
const UNSTABLE_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;

/** How long to wait before restart number `failures` in a row (the first is immediate). */
export function restartDelay(failures: number): number {
	return failures <= 1 ? 0 : Math.min(MAX_RESTART_DELAY_MS, 500 * 2 ** (failures - 2));
}

/** Spawns the session host utility process, restarting it if it dies (backing off when it keeps dying). */
export async function utilityHostLink(piDir: string, env: Record<string, string> = {}): Promise<HostLink & { kill(): void }> {
	const { utilityProcess } = await import("electron");
	mkdirSync(piDir, { recursive: true });
	const eventListeners: ((e: HostEvent) => void)[] = [];
	const restartListeners: (() => void)[] = [];
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let quitting = false;
	let failures = 0;
	let restartTimer: NodeJS.Timeout | undefined;
	let up: Promise<void> = Promise.resolve();

	const spawn = () => {
		const startedAt = Date.now();
		const proc = utilityProcess.fork(join(import.meta.dirname, "session-host.js"), [], {
			serviceName: "Game Studio session host",
			env: { ...process.env, ...env, GAME_STUDIO_PI_DIR: piDir },
			stdio: "inherit",
		});
		proc.on("message", (msg: HostMessage) => {
			if (msg.kind === "event") {
				for (const l of eventListeners) l(msg.event);
				return;
			}
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new Error(msg.error));
		});
		proc.on("exit", (code) => {
			for (const p of pending.values()) {
				clearTimeout(p.timer);
				p.reject(new Error(`session host exited (${code})`));
			}
			pending.clear();
			if (quitting) return;
			failures = Date.now() - startedAt > UNSTABLE_MS ? 1 : failures + 1;
			const delay = restartDelay(failures);
			console.error(`session host exited with ${code}; restarting${delay ? ` in ${delay} ms (it has died ${failures} times in a row)` : ""}`);
			// Its live sessions are gone now, whenever the new host is up.
			for (const l of restartListeners) l();
			up = new Promise((resolve) => {
				restartTimer = setTimeout(() => {
					current = spawn();
					resolve();
				}, delay);
			});
		});
		return proc;
	};
	let current = spawn();

	return {
		call: (async (method, ...args) => {
			await up; // a call made while the host restarts waits for the new one
			return new Promise((resolve, reject) => {
				const id = nextId++;
				const entry: Pending = { resolve, reject };
				if (!UNTIMED.has(method)) {
					const ms = SLOW[method] ?? CALL_TIMEOUT_MS;
					entry.timer = setTimeout(() => {
						if (pending.delete(id)) reject(new Error(`The session host didn't answer "${method}" within ${ms / 1000} s`));
					}, ms);
				}
				pending.set(id, entry);
				current.postMessage({ id, method, args });
			});
		}) as HostCall,
		onEvent: (l) => eventListeners.push(l),
		onRestart: (l) => restartListeners.push(l),
		kill() {
			quitting = true;
			clearTimeout(restartTimer);
			current.kill();
		},
	};
}
