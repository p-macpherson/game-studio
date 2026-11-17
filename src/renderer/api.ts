import type { StudioApi, StudioBridge, StudioMethod } from "../shared/ipc";

declare global {
	interface Window {
		studio: StudioBridge;
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
