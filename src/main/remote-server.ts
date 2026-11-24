// Remote access (vault: Initiatives/Remote Access.md): the studio served to a browser elsewhere on Pat's tailnet. It
// listens on 127.0.0.1 only; `tailscale serve` publishes it to the tailnet over HTTPS and adds the caller's identity.
// The page speaks the desktop UI's own contract (`call` and the event stream), limited to REMOTE_METHODS.
import { createReadStream, existsSync, statSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import type { StudioEvent, StudioMethod } from "../shared/ipc";

/** What a remote page may ask the studio for. Everything else is refused here, not just hidden in the page. */
export const REMOTE_METHODS: ReadonlySet<StudioMethod> = new Set<StudioMethod>([
	// What the page reads to show the project, its sessions and worktrees.
	"project.current",
	"settings.get",
	"agentTypes.list",
	"modules.list",
	"models.available",
	"run.current",
	"updates.status",
	"history.get",
	"worktrees.list",
	"worktrees.load",
	"sessions.list",
	"sessions.messages",
	"sessions.queued",
	"sessions.context",
	"sessions.assets",
	// Working with sessions.
	"sessions.create",
	"sessions.send",
	"sessions.unqueue",
	"sessions.answer",
	"sessions.abort",
	"sessions.markDone",
	"sessions.resume",
	"sessions.retry",
	"sessions.compact",
	"sessions.setModel",
	"sessions.raw",
	// Worktrees: what they changed, merge (the Merge dialog's checks and its save first) and update from main.
	"worktrees.changedFiles",
	"worktrees.commits",
	"worktrees.status",
	"worktrees.save",
	"worktrees.merge",
	"worktrees.update",
]);

/** Pictures, sounds and clips the chat shows; the same set the desktop's studio-file:// serves. */
const MEDIA = new Set([".png", ".jpg", ".jpeg", ".webp", ".glb", ".gltf", ".bin", ".json", ".ogg", ".wav", ".webm"]);
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".webm": "video/webm",
	".glb": "model/gltf-binary",
	".gltf": "model/gltf+json",
	".bin": "application/octet-stream",
	".wasm": "application/wasm",
	".data": "application/octet-stream",
};
/** Pasted images travel in a call's arguments: six of them, base64. */
const MAX_BODY = 64 * 1024 * 1024;

export interface RemoteServerOptions {
	port: number;
	/** Runs one of the studio's methods, as the desktop UI's `studio:call` does. */
	dispatch: (method: StudioMethod, args: unknown[]) => Promise<unknown>;
	/** The built renderer (`out/renderer`): the page is its `remote.html`. */
	pageDir: string;
	/** A file inside a checkout ("main" or a worktree/session id), or an error if it's outside it. */
	fileOf: (checkout: string, path: string) => string;
	/**
	 * Who may use it: the Tailscale logins allowed (empty: anyone `tailscale serve` vouches for). A request without
	 * Tailscale's identity header didn't come through `tailscale serve` and is refused, unless `allowLocal`.
	 */
	logins: () => string[];
	allowLocal?: boolean;
	/** Told about refused requests, so Settings can show who tried. */
	refused?: (why: string) => void;
}

export interface RemoteServer {
	url: string;
	broadcast(event: StudioEvent): void;
	close(): Promise<void>;
}

export function startRemoteServer(opts: RemoteServerOptions): Promise<RemoteServer> {
	const listeners = new Set<ServerResponse>();

	const identity = (req: IncomingMessage): string | null => {
		const login = req.headers["tailscale-user-login"];
		const who = Array.isArray(login) ? login[0] : login;
		if (!who) return opts.allowLocal ? "local" : null;
		const allowed = opts.logins();
		return allowed.length === 0 || allowed.includes(who) ? who : null;
	};

	const fail = (res: ServerResponse, status: number, message: string) => {
		res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
		res.end(message);
	};

	const sendFile = (res: ServerResponse, file: string, cache: string) => {
		res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": statSync(file).size, "cache-control": cache });
		createReadStream(file).pipe(res);
	};

	const readBody = (req: IncomingMessage) =>
		new Promise<string>((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on("data", (c: Buffer) => {
				size += c.length;
				if (size > MAX_BODY) {
					reject(new Error("Too large"));
					req.destroy();
				} else chunks.push(c);
			});
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});

	const call = async (req: IncomingMessage, res: ServerResponse) => {
		// A JSON body can't be sent cross-site without a preflight this server never answers, and a page elsewhere can't
		// set Origin to this host: together, no other site the phone visits can drive the studio.
		if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return fail(res, 415, "JSON only");
		const origin = req.headers.origin;
		if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, "Wrong origin");
		let method: StudioMethod;
		let args: unknown[];
		try {
			const body = JSON.parse(await readBody(req)) as { method: StudioMethod; args?: unknown[] };
			method = body.method;
			args = Array.isArray(body.args) ? body.args : [];
		} catch {
			return fail(res, 400, "Bad request");
		}
		if (!REMOTE_METHODS.has(method)) return fail(res, 403, `${method} isn't available remotely`);
		try {
			const result = await opts.dispatch(method, args);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ result }));
		} catch (err) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
		}
	};

	const events = (req: IncomingMessage, res: ServerResponse) => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
		res.write(": hello\n\n");
		listeners.add(res);
		// Keeps proxies and phones from closing a quiet stream.
		const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
		req.on("close", () => {
			clearInterval(ping);
			listeners.delete(res);
		});
	};

	const server: Server = createServer((req, res) => {
		const who = identity(req);
		if (!who) {
			opts.refused?.(String(req.headers["tailscale-user-login"] ?? "no Tailscale identity"));
			return fail(res, 403, "Not allowed");
		}
		const url = new URL(req.url ?? "/", "http://studio");
		const path = decodeURIComponent(url.pathname);
		try {
			if (path === "/api/call" && req.method === "POST") return void call(req, res);
			if (path === "/api/events" && req.method === "GET") return events(req, res);
			if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Method not allowed");
			// /file/<checkout>/<path>: a checkout's media, as studio-file://<checkout>/<path> on the desktop.
			const file = /^\/file\/([^/]+)\/(.+)$/.exec(path);
			if (file) {
				if (!MEDIA.has(extname(file[2]).toLowerCase())) return fail(res, 403, "Not a studio media file");
				const full = opts.fileOf(file[1], file[2]);
				if (!existsSync(full) || !statSync(full).isFile()) return fail(res, 404, "Not found");
				return sendFile(res, full, "no-cache");
			}
			// The page itself and its scripts, styles and fonts.
			const rel = path === "/" ? "remote.html" : normalize(path).replace(/^[/\\]+/, "");
			const full = join(opts.pageDir, rel);
			if (!full.startsWith(opts.pageDir + sep) || !existsSync(full) || !statSync(full).isFile()) return fail(res, 404, "Not found");
			return sendFile(res, full, rel === "remote.html" ? "no-cache" : "max-age=3600");
		} catch (err) {
			return fail(res, 400, err instanceof Error ? err.message : String(err));
		}
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve({
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
				broadcast(event) {
					const data = `data: ${JSON.stringify(event)}\n\n`;
					for (const res of listeners) res.write(data);
				},
				close: () =>
					new Promise<void>((done) => {
						for (const res of listeners) res.end();
						listeners.clear();
						server.close(() => done());
						server.closeAllConnections();
					}),
			});
		});
	});
}
