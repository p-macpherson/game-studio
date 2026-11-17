// A scripted "faux/echo" model for tests: for each user message it appends the text to faux-notes.md,
// commits it with bash, then replies "Noted: <text>". No credentials or network needed.
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
	const command = `printf '%s\\n' ${quote(text)} >> faux-notes.md && git add faux-notes.md && git commit -qm ${quote(`faux: ${text.slice(0, 40)}`)}`;
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
