// Tools every session gets, through which the agent talks back to Game Studio.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HostEvent } from "../shared/host";

export interface StudioToolContext {
	sessionId: string;
	post(event: HostEvent): void;
	/** Waits for the user's answer to an `ask_user` question. */
	ask(questionId: string, signal: AbortSignal | undefined): Promise<string>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function studioTools(ctx: StudioToolContext) {
	const tool = (tool: "set_session_title" | "request_review" | "open_in_studio", params: Record<string, string>) =>
		ctx.post({ type: "studio_tool", id: ctx.sessionId, tool, params });
	let questions = 0;

	return [
		defineTool({
			name: "set_session_title",
			label: "Set session title",
			description: "Set a short title (under 60 characters) describing this session's task, shown in Game Studio's session list. Call it once you understand the task.",
			parameters: Type.Object({ title: Type.String() }),
			async execute(_id, { title }) {
				tool("set_session_title", { title: title.slice(0, 80) });
				return ok("Title set.");
			},
		}),
		defineTool({
			name: "request_review",
			label: "Request review",
			description: "Tell the user your work is committed on this session's branch and ready for them to review and merge. Include a short summary of what changed.",
			parameters: Type.Object({ summary: Type.String() }),
			async execute(_id, { summary }) {
				tool("request_review", { summary });
				return ok("The user has been asked to review the branch.");
			},
		}),
		defineTool({
			name: "open_in_studio",
			label: "Open in studio",
			description: "Show a file (an asset or design doc, as a path relative to the repo root) to the user in Game Studio.",
			parameters: Type.Object({ path: Type.String() }),
			async execute(_id, { path }) {
				tool("open_in_studio", { path });
				return ok(`Opened ${path}.`);
			},
		}),
		defineTool({
			name: "ask_user",
			label: "Ask user",
			description: "Ask the user a question and wait for the answer. Offer options when the answer is a choice; the user can still answer freely.",
			parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
			async execute(_id, { question, options }, signal) {
				const questionId = `${ctx.sessionId}-q${++questions}`;
				ctx.post({ type: "ask_user", id: ctx.sessionId, questionId, question, options });
				return ok(`User answered: ${await ctx.ask(questionId, signal)}`);
			},
		}),
	];
}
