/** Everything the renderer can call on the main process, exposed by the preload script as `window.studio`. */
export interface StudioApi {
	hostInfo(): Promise<HostInfo>;
}

export interface HostInfo {
	node: string;
	piVersion: string;
	providers: number;
}

/** Messages between the main process and the session host utility process. */
export type HostRequest = { id: number; type: "info" };
export type HostReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
