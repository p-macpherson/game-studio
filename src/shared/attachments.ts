// Images a person pastes into a message to an agent. The agent sees them as part of the message; they are also saved
// in the session's worktree under ATTACHMENTS_DIR (which ignores itself, so they never become part of the game: an
// agent copies one into the project when it's worth keeping), and the message names those files so the agent can
// pass them to tools that take reference images by path.
export const ATTACHMENTS_DIR = ".studio/attachments";
export const MAX_PASTED_IMAGES = 6;
/** The longest side a pasted image is scaled down to before it is sent. */
export const PASTED_IMAGE_SIDE = 1568;
export const PASTED_IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export interface PastedImage {
	/** Base64, without the data-URL prefix. */
	data: string;
	mimeType: string;
}

const OPEN = "<attached-images>";
const CLOSE = "</attached-images>";

/** The message as the agent gets it: the person's words, then where the attached images were saved. */
export function withAttachments(text: string, paths: string[]): string {
	if (!paths.length) return text;
	const note = `${OPEN}\nThe user attached ${paths.length === 1 ? "this image" : "these images"} (shown above). Saved in the worktree for tools that take reference images by path; not part of the game unless you copy one into the project:\n${paths.join("\n")}\n${CLOSE}`;
	return text.trim() ? `${text}\n\n${note}` : note;
}

/** A sent message split back into the person's words and the saved images' paths. */
export function splitAttachments(message: string): { text: string; paths: string[] } {
	const start = message.lastIndexOf(OPEN);
	const end = message.indexOf(CLOSE, start);
	if (start < 0 || end < 0) return { text: message, paths: [] };
	const paths = message
		.slice(start + OPEN.length, end)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith(`${ATTACHMENTS_DIR}/`));
	return { text: (message.slice(0, start) + message.slice(end + CLOSE.length)).trim(), paths };
}
