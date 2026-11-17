import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type UtilityProcess, utilityProcess } from "electron";
import type { HostReply, HostRequest } from "../shared/ipc";

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

/** Spawns the session host utility process and sends it requests. */
export class SessionHostClient {
	private proc: UtilityProcess;
	private nextId = 1;
	private pending = new Map<number, Pending>();

	constructor(piDir: string) {
		mkdirSync(piDir, { recursive: true });
		this.proc = utilityProcess.fork(join(import.meta.dirname, "session-host.js"), [], {
			serviceName: "Game Studio session host",
			env: { ...process.env, GAME_STUDIO_PI_DIR: piDir },
			stdio: "inherit",
		});
		this.proc.on("message", (reply: HostReply) => {
			const p = this.pending.get(reply.id);
			if (!p) return;
			this.pending.delete(reply.id);
			if (reply.ok) p.resolve(reply.result);
			else p.reject(new Error(reply.error));
		});
		this.proc.on("exit", (code) => {
			for (const p of this.pending.values()) p.reject(new Error(`session host exited (${code})`));
			this.pending.clear();
		});
	}

	request<T>(req: Omit<HostRequest, "id">): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.proc.postMessage({ ...req, id });
		});
	}

	kill(): void {
		this.proc.kill();
	}
}
