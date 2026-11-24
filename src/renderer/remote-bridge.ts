// The remote page's `window.studio`: the desktop bridge's two halves over HTTP. Calls are POSTs to /api/call; events
// arrive on one Server-Sent Events stream, which the browser reconnects by itself. Imported before anything that
// calls the studio, so the store and the views work unchanged.
import type { StudioBridge, StudioEvent } from "../shared/ipc";

const listeners = new Set<(event: StudioEvent) => void>();
/** Told when the stream comes back after a drop: events were missed, so what's shown must be read again. */
const reconnected = new Set<() => void>();

let stream: EventSource | undefined;
let dropped = false;
function connect(): void {
	stream = new EventSource("/api/events");
	stream.onmessage = (m) => {
		const event = JSON.parse(m.data as string) as StudioEvent;
		for (const l of listeners) l(event);
	};
	stream.onerror = () => {
		dropped = true;
	};
	stream.onopen = () => {
		if (!dropped) return;
		dropped = false;
		for (const r of reconnected) r();
	};
}

export function onReconnect(listener: () => void): () => void {
	reconnected.add(listener);
	return () => reconnected.delete(listener);
}

const bridge: StudioBridge = {
	call: (async (method: string, ...args: unknown[]) => {
		const res = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, args }) });
		if (!res.ok) throw new Error((await res.text()) || `${res.status} ${res.statusText}`);
		const body = (await res.json()) as { result?: unknown; error?: string };
		if (body.error !== undefined) throw new Error(body.error);
		return body.result; // absent for a call that returns nothing; null stays null (it means something to some calls)
	}) as StudioBridge["call"],
	onEvent(listener) {
		if (!stream) connect();
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
};

window.studio = bridge;
window.studioRemote = true;
