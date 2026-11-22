// Unsent messages: what a person typed into a session's composer stays there while they visit another session or
// section, and across restarts, until it's sent.
const key = (sessionId: string) => `draft:${sessionId}`;

export function loadDraft(sessionId: string): string {
	return localStorage.getItem(key(sessionId)) ?? "";
}

export function saveDraft(sessionId: string, text: string): void {
	if (text) localStorage.setItem(key(sessionId), text);
	else localStorage.removeItem(key(sessionId));
}
