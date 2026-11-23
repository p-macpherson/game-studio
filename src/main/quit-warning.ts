// What the studio says before it closes while agents are still working: closing interrupts them (they can be
// resumed afterwards, but whatever a tool was doing at that moment is cut off).

import type { SessionSummary } from "../shared/types";

const LISTED = 6;

/** The warning to show before closing, or null when no session is in progress. */
export function quitWarning(sessions: Pick<SessionSummary, "title" | "status" | "parentId" | "pendingQuestion">[]): { message: string; detail: string } | null {
	const running = sessions.filter((s) => s.status === "in_progress" || s.status === "starting");
	if (!running.length) return null;
	// Sub-agents stop with the sessions that started them: the person knows those by name.
	const own = running.filter((s) => !s.parentId);
	const named = own.length ? own : running;
	const subAgents = running.length - named.length;
	const lines = named.slice(0, LISTED).map((s) => `• ${s.title}${s.pendingQuestion ? " (waiting for your answer)" : ""}`);
	if (named.length > LISTED) lines.push(`• and ${named.length - LISTED} more`);
	const n = named.length;
	return {
		message: `${n} session${n > 1 ? "s are" : " is"} still in progress`,
		detail: [
			lines.join("\n"),
			subAgents ? `\n${subAgents} sub-agent${subAgents > 1 ? "s are" : " is"} working for ${n > 1 ? "them" : "it"} too.` : "",
			`\nQuitting interrupts ${running.length > 1 ? "them" : "it"}: whatever ${running.length > 1 ? "they are" : "it is"} doing right now is cut off. You can resume ${running.length > 1 ? "them" : "it"} when you open Game Studio again.`,
		]
			.filter(Boolean)
			.join("\n"),
	};
}
