import type { StudioApi, StudioBridge, StudioMethod } from "../shared/ipc";

declare global {
	interface Window {
		studio: StudioBridge;
		studioRemote?: boolean;
	}
}

/** Calls the main process. Errors come back without Electron's "Error invoking remote method" prefix. */
export function call<M extends StudioMethod>(method: M, ...args: Parameters<StudioApi[M]>): ReturnType<StudioApi[M]> {
	return (window.studio.call(method, ...args) as Promise<unknown>).catch((err: Error) => {
		throw new Error(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
	}) as ReturnType<StudioApi[M]>;
}

export const onEvent = (listener: Parameters<StudioBridge["onEvent"]>[0]) => window.studio.onEvent(listener);

export function relativeTime(iso: string): string {
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/**
 * A URL for a model or image in the main checkout (no checkout) or a session's worktree, served by the
 * studio-file:// protocol. `version` busts the cache when a file is regenerated in place.
 */
/** Hex SHA-1 of a text (to compare a file with what a render was made from). */
export async function sha1(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The page is the remote one (`remote.tsx`), in a browser on another device, not the desktop window. */
export const isRemote = () => window.studioRemote === true;

export function studioFile(checkout: string | null | undefined, path: string, version?: string): string {
	const rest = `${checkout || "main"}/${path.split("/").map(encodeURIComponent).join("/")}`;
	const url = isRemote() ? `/file/${rest}` : `studio-file://${rest}`;
	return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}
