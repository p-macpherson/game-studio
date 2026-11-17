// The session host: an Electron utility process that owns every live Pi session, so agent tool
// execution never blocks the main process or the UI.
import type { HostApi, HostMessage, HostRequest } from "../shared/host";
import { HostCore } from "./host-core";

const agentDir = process.env.GAME_STUDIO_PI_DIR;
if (!agentDir) throw new Error("GAME_STUDIO_PI_DIR is not set");

const post = (message: HostMessage) => process.parentPort.postMessage(message);
const core = await HostCore.create({ agentDir, faux: process.env.GAME_STUDIO_FAUX === "1", post: (event) => post({ kind: "event", event }) });

process.parentPort.on("message", async ({ data }: { data: HostRequest }) => {
	try {
		const method = core[data.method] as (...args: unknown[]) => unknown;
		const result = await method.apply(core, data.args);
		post({ kind: "reply", id: data.id, ok: true, result });
	} catch (err) {
		post({ kind: "reply", id: data.id, ok: false, error: err instanceof Error ? err.message : String(err) });
	}
});
