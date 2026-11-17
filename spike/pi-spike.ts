// M0 spike: verifies the Pi SDK assumptions Game Studio is designed around.
// Run: node spike/pi-spike.ts <scratch-dir>
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const root = process.argv[2];
if (!root) throw new Error("usage: pi-spike.ts <scratch-dir>");
const agentDir = join(root, "agent");
const cwd = join(root, "worktree");
const sessionDir = join(root, "sessions", "s1");
for (const d of [agentDir, cwd, sessionDir]) mkdirSync(d, { recursive: true });

const runtime = await ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
	allowModelNetwork: false,
});
console.log("providers:", runtime.getProviders().map((p) => p.id).join(", "));
console.log(
	"auth status:",
	JSON.stringify(Object.fromEntries(["anthropic", "openai", "google"].map((id) => [id, runtime.getProviderAuthStatus(id)]))),
);
console.log("available before faux:", (await runtime.getAvailable()).length);

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
runtime.registerNativeProvider(faux.provider);
console.log("available after faux:", (await runtime.getAvailable()).map((m) => `${m.provider}/${m.id}`));

let titled = "";
const setTitle = defineTool({
	name: "set_session_title",
	label: "Set title",
	description: "Sets the session title shown in Game Studio.",
	parameters: Type.Object({ title: Type.String() }),
	async execute(_id, params) {
		titled = params.title;
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
});

async function open(manager: SessionManager) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		appendSystemPrompt: ["You are the spike agent."],
		noExtensions: true,
	});
	await loader.reload();
	return createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model: faux.getModel(),
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: SettingsManager.inMemory(),
		customTools: [setTitle],
	});
}

faux.setResponses([
	fauxAssistantMessage([fauxToolCall("set_session_title", { title: "Spike session" })], { stopReason: "toolUse" }),
	fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi > out.txt" })], { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText("Done.")),
	fauxAssistantMessage(fauxText("Resumed fine.")),
]);

const seen = new Map<string, number>();
const { session } = await open(SessionManager.create(cwd, sessionDir));
session.subscribe((e) => seen.set(e.type, (seen.get(e.type) ?? 0) + 1));
await session.prompt("Do the spike.");
const file = session.sessionFile!;
console.log("events:", JSON.stringify(Object.fromEntries(seen)));
console.log("title tool:", titled, "| out.txt:", readdirSync(cwd).join(","));
console.log("session file:", file.replace(root, "<root>"), "| last:", session.getLastAssistantText());
session.dispose();

// Reopen from the JSONL path with a different cwd (as if the worktree had been recreated elsewhere).
const cwd2 = join(root, "worktree2");
mkdirSync(cwd2, { recursive: true });
const { session: resumed } = await open(SessionManager.open(file, sessionDir, cwd2));
console.log("resumed messages:", resumed.messages.length, "| cwd:", resumed.sessionManager.getCwd().replace(root, "<root>"));
await resumed.prompt("Still there?");
console.log("after resume:", resumed.getLastAssistantText(), "| messages:", resumed.messages.length);
resumed.dispose();
