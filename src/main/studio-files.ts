// studio-file://<checkout>/<repo-relative path>: serves models and images from the project's main checkout
// ("main") or a session's worktree (its id) to the renderer, so three.js and <img> can load them directly.
// Only media types the viewers need are served, and only from inside the checkout.
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { safeJoin } from "./assets";

export const STUDIO_FILE_SCHEME = "studio-file";
const SERVED = new Set([".png", ".jpg", ".jpeg", ".webp", ".glb", ".gltf", ".bin", ".json", ".ogg", ".wav", ".webm"]);

/** Must run before the app is ready. */
export function registerStudioFileScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{ scheme: STUDIO_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
	]);
}

/** `rootOf(checkout)` returns the checkout's directory, or throws if there isn't one. */
export function serveStudioFiles(rootOf: (checkout: string) => string): void {
	protocol.handle(STUDIO_FILE_SCHEME, async (request) => {
		try {
			const url = new URL(request.url);
			const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!SERVED.has(extname(path).toLowerCase())) return new Response("Not a studio media file", { status: 403 });
			const full = safeJoin(rootOf(url.hostname), path);
			if (!existsSync(full)) return new Response("Not found", { status: 404 });
			return net.fetch(pathToFileURL(full).toString());
		} catch (err) {
			return new Response((err as Error).message, { status: 400 });
		}
	});
}
