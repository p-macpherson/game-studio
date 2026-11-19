// Client for the engine's control protocol: newline-delimited JSON over TCP on 127.0.0.1.
// See engine/docs/control-protocol.md.
import { createConnection, createServer, type Socket } from "node:net";

export class EngineClient {
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
	private closed = false;

	private constructor(private readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.receive(chunk));
		socket.on("close", () => this.fail(new Error("The game closed the control connection")));
		socket.on("error", (err) => this.fail(err));
	}

	/** Connects, retrying until the game's control server is up, `alive()` turns false, or the timeout passes. */
	static async connect(port: number, alive: () => boolean, timeoutMs = 20_000): Promise<EngineClient> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				const socket = await new Promise<Socket>((resolve, reject) => {
					const s = createConnection({ host: "127.0.0.1", port }, () => resolve(s));
					s.once("error", reject);
				});
				return new EngineClient(socket);
			} catch (err) {
				if (!alive()) throw new Error("The game exited before its control server started");
				if (Date.now() > deadline) throw err;
				await new Promise((r) => setTimeout(r, 100));
			}
		}
	}

	/** Runs a command and resolves with its result; rejects with the engine's error message. */
	call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("Not connected to the game"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.write(`${JSON.stringify({ ...args, cmd, id })}\n`);
		});
	}

	close(): void {
		this.closed = true;
		this.socket.destroy();
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf("\n");
		while (nl >= 0) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			nl = this.buffer.indexOf("\n");
			let reply: { id?: number; ok?: boolean; result?: unknown; error?: string };
			try {
				reply = JSON.parse(line);
			} catch {
				continue;
			}
			const p = typeof reply.id === "number" ? this.pending.get(reply.id) : undefined;
			if (!p) continue;
			this.pending.delete(reply.id!);
			if (reply.ok) p.resolve(reply.result);
			else p.reject(new Error(reply.error ?? "unknown engine error"));
		}
	}

	private fail(err: Error): void {
		this.closed = true;
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}
}

/** A TCP port that was free a moment ago. */
export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
	});
}
