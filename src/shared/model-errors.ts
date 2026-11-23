// Errors from a model's provider, as a person should read them. Providers hand back raw JSON
// ({"type":"error","error":{"type":"overloaded_error",...}}); the studio says what happened and whether trying
// again is likely to help. The raw text stays available (a tooltip) for reporting.

/** What a session is told when the person presses Retry after a failed request (the chat shows it as a short note). */
export const RETRY_NOTE = "[Game Studio] Your last request to the model failed with a temporary error, and the user has asked you to try again. Carry on from where you left off.";

/** How long a session keeps trying by itself when the model's servers are busy or unreachable (see host-core.ts). */
export const MODEL_RETRY = { enabled: true, maxRetries: 12, baseDelayMs: 2000 };

export interface ModelError {
	/** In a few words. */
	title: string;
	/** What it means and what to do. */
	detail: string;
	/** Trying again may well work. */
	temporary: boolean;
}

const TEMPORARY = /overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504|520|524|529)\b|unavailable|server.?error|internal.?error|timed? ?out|timeout|network|connection|fetch failed|socket|terminated|ended without|stream/i;

export function describeModelError(raw: string): ModelError {
	let type = "";
	let message = raw.trim();
	try {
		const parsed = JSON.parse(raw) as { error?: { type?: string; message?: string } | string; message?: string };
		const error = typeof parsed.error === "object" && parsed.error ? parsed.error : undefined;
		type = error?.type ?? "";
		message = error?.message ?? (typeof parsed.error === "string" ? parsed.error : parsed.message) ?? message;
	} catch {
		// Not JSON: the text is the message.
	}
	const about = `${type} ${message}`;
	if (/overloaded|at capacity|high demand|server_busy|\b529\b/i.test(about)) return { title: "The model's servers are overloaded", detail: "This is on the provider's side and usually passes within minutes. Nothing in the session is lost: try again.", temporary: true };
	if (/rate.?limit|too many requests|\b429\b/i.test(about)) return { title: "The model's rate limit was reached", detail: "Too many requests in a short time for this account. Wait a little, then try again.", temporary: true };
	if (/authentication|unauthori[sz]ed|invalid.*api.?key|\b401\b|permission|\b403\b/i.test(about)) return { title: "The model's provider refused the account", detail: `Check the account under Settings → Accounts. The provider said: ${message}`, temporary: false };
	if (/quota|billing|credit|insufficient|usage limit|out of budget/i.test(about)) return { title: "The account's usage limit was reached", detail: `The provider said: ${message}`, temporary: false };
	if (TEMPORARY.test(about)) return { title: "The request to the model failed", detail: `A problem reaching the provider or on its side (${message}). Nothing in the session is lost: try again.`, temporary: true };
	return { title: "The session stopped with an error", detail: message, temporary: false };
}

/** While a session waits to try a failed request again: "Trying again in 8 s (attempt 2 of 12)". */
export function retryLine(r: { attempt: number; maxAttempts: number; delayMs: number; startedAt: number }, now: number): string {
	const left = Math.max(0, Math.ceil((r.startedAt + r.delayMs - now) / 1000));
	return `${left > 0 ? `Trying again in ${left} s` : "Trying again…"} (attempt ${r.attempt} of ${r.maxAttempts})`;
}
