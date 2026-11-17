// A scripted "faux/echo" model for tests: for each user message it appends the text to faux-notes.md (or,
// for "write <path>: <content>", writes that file), commits it with bash, then replies "Noted: <text>".
// No credentials or network needed.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function lastUserText(messages: readonly { role: string; content: unknown }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) return m.content.map((c: { text?: string }) => c.text ?? "").join("");
	}
	return "";
}

const respond: FauxResponseFactory = (context) => {
	const messages = context.messages as unknown as { role: string; content: unknown }[];
	const text = lastUserText(messages);
	if (messages.at(-1)?.role === "toolResult") return fauxAssistantMessage(fauxText(`Noted: ${text}`));
	// "write <path>: <content>" replaces that file; anything else is appended to faux-notes.md.
	const write = /^write (\S+): ([\s\S]*)$/.exec(text);
	const [file, content, op] = write ? [write[1], write[2], ">"] : ["faux-notes.md", text, ">>"];
	const command = `mkdir -p "$(dirname ${quote(file)})" && printf '%s\\n' ${quote(content)} ${op} ${quote(file)} && git add ${quote(file)} && git commit -qm ${quote(`faux: ${text.slice(0, 40)}`)}`;
	return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
};

export function createFaux() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "echo", name: "Faux echo (testing)" }], tokensPerSecond: 2000 });
	return {
		provider: faux.provider,
		models: faux.models,
		/** Keeps the scripted queue topped up; call before every prompt. */
		refill() {
			if (faux.getPendingResponseCount() < 8) faux.appendResponses(Array.from({ length: 16 }, () => respond));
		},
	};
}
