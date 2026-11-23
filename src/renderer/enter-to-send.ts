// "Enter to send" for a session's message boxes: on, Enter sends and Shift+Enter starts a new line; off, Enter starts
// a new line. Ctrl+Enter and Ctrl+Shift+Enter (Cmd on a Mac) send either way. The choice is kept per session on this
// machine; a session with no choice of its own follows the default in Settings → General.

export interface KeyPress {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	/** An input method is still composing (Enter picks a candidate there, it isn't the person's Enter). */
	isComposing?: boolean;
}

/** Whether this key press sends the message. */
export function sendsMessage(e: KeyPress, enterToSend: boolean): boolean {
	if (e.key !== "Enter" || e.isComposing) return false;
	if (e.ctrlKey || e.metaKey) return true;
	return enterToSend && !e.shiftKey && !e.altKey;
}

const key = (sessionId: string) => `enter-to-send:${sessionId}`;

/** The session's own choice, or null when it has none (it follows the default). */
export function sessionEnterToSend(sessionId: string): boolean | null {
	const v = localStorage.getItem(key(sessionId));
	return v === "1" ? true : v === "0" ? false : null;
}

export function setSessionEnterToSend(sessionId: string, on: boolean): void {
	localStorage.setItem(key(sessionId), on ? "1" : "0");
}

/** The hint under a message box. */
export const sendHint = (enterToSend: boolean) => (enterToSend ? "Shift+Enter for a new line" : "Enter for a new line · Ctrl+Enter to send");
