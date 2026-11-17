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

type Pending = { resolve(value: unknown): void; reject(err: Error): void };

/** Spawns the session host utility process, restarting it if it dies. */
export async function utilityHostLink(piDir: string, env: Record<string, string> = {}): Promise<HostLink & { kill(): void }> {
	const { utilityProcess } = await import("electron");
	mkdirSync(piDir, { recursive: true });
	const eventListeners: ((e: HostEvent) => void)[] = [];
	const restartListeners: (() => void)[] = [];
	const pending = new Map<number, Pending>();
	let nextId = 1;
	let quitting = false;

	const spawn = () => {
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
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new Error(msg.error));
		});
		proc.on("exit", (code) => {
			for (const p of pending.values()) p.reject(new Error(`session host exited (${code})`));
			pending.clear();
			if (quitting) return;
			console.error(`session host exited with ${code}; restarting`);
			current = spawn();
			for (const l of restartListeners) l();
		});
		return proc;
	};
	let current = spawn();

	return {
		call: ((method, ...args) =>
			new Promise((resolve, reject) => {
				const id = nextId++;
				pending.set(id, { resolve, reject } as Pending);
				current.postMessage({ id, method, args });
			})) as HostCall,
		onEvent: (l) => eventListeners.push(l),
		onRestart: (l) => restartListeners.push(l),
		kill() {
			quitting = true;
			current.kill();
		},
	};
}
