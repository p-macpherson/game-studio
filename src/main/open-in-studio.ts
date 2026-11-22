// open_in_studio: an agent shows the user a file. It never changes what the user is looking at (Pat, 2026-11-22: a
// session must not move them to another part of the studio): the file appears in the session's conversation, as a
// card for an asset or design doc (which opens its section when clicked) or as a picture for an image (a screenshot
// or render, wherever it is). Anything else can't be shown, and the agent is told so (with the file's full path to
// pass on), rather than believing the user saw it. The cards themselves are worked out from the transcript
// (shared/session-assets.ts): this only checks the file and answers truthfully.
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { type ModuleInfo, moduleOwns } from "../shared/modules";
import { safeJoin } from "./assets";
import { type StudioRequestHandlers, handler } from "./studio-requests";

const IMAGES = [".png", ".jpg", ".jpeg", ".webp"];

export function openInStudioRequests(modules: ModuleInfo[], adopt: (sessionId: string, path: string) => void): StudioRequestHandlers {
	return {
		open_in_studio: handler((ctx, p: { path: string }) => {
			const path = p.path.replace(/^\.?\//, "");
			const file = safeJoin(ctx.cwd, path);
			const module = modules.find((m) => moduleOwns(m, path));
			if (module) {
				adopt(ctx.sessionId, path);
				return `Put a card for ${path} in the conversation: the user can open it in the ${module.name} section from there. They haven't necessarily looked yet.`;
			}
			if (!existsSync(file)) throw new Error(`There's no file at ${path}`);
			if (IMAGES.includes(extname(path).toLowerCase())) return `Put ${path} in the conversation as a picture the user can click to enlarge. They haven't necessarily looked yet.`;
			return (
				`Game Studio has no view for ${path}: it shows assets in its sections, design docs and images. The user hasn't seen it; ` +
				`describe what it shows, or give its full path: ${file}`
			);
		}),
	};
}
