// The session host: an Electron utility process that owns every live Pi session, so agent tool
// execution never blocks the main process or the UI.
import { join } from "node:path";
import { ModelRuntime, VERSION } from "@earendil-works/pi-coding-agent";
import type { HostInfo, HostReply, HostRequest } from "../shared/ipc";

const agentDir = process.env.GAME_STUDIO_PI_DIR;
if (!agentDir) throw new Error("GAME_STUDIO_PI_DIR is not set");

const runtime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
});

async function handle(req: HostRequest): Promise<unknown> {
	switch (req.type) {
		case "info":
			return { node: process.versions.node, piVersion: VERSION, providers: runtime.getProviders().length } satisfies HostInfo;
	}
}

process.parentPort.on("message", async ({ data }: { data: HostRequest }) => {
	let reply: HostReply;
	try {
		reply = { id: data.id, ok: true, result: await handle(data) };
	} catch (err) {
		reply = { id: data.id, ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	process.parentPort.postMessage(reply);
});
