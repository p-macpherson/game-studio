// open_in_studio: an agent shows the user a file. An asset or design doc opens in its section; an image (a screenshot
// or render, wherever it is) opens in the studio's image viewer; anything else can't be shown, and the agent is told so
// (with the file's full path to pass on), rather than believing the user saw it.
import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { StudioEvent } from "../shared/ipc";
import { type ModuleInfo, moduleOwns } from "../shared/modules";
import { safeJoin } from "./assets";
import { type StudioRequestHandlers, handler } from "./studio-requests";

const IMAGES = [".png", ".jpg", ".jpeg", ".webp"];

export function openInStudioRequests(modules: ModuleInfo[], emit: (e: StudioEvent) => void, adopt: (sessionId: string, path: string) => void): StudioRequestHandlers {
	return {
		open_in_studio: handler((ctx, p: { path: string }) => {
			const path = p.path.replace(/^\.?\//, "");
			const file = safeJoin(ctx.cwd, path);
			const module = modules.find((m) => moduleOwns(m, path));
			if (module) {
				adopt(ctx.sessionId, path);
				emit({ type: "focus_asset", path, sessionId: ctx.sessionId });
				return `Opened ${path} in the ${module.name} section.`;
			}
			if (!existsSync(file)) throw new Error(`There's no file at ${path}`);
			if (IMAGES.includes(extname(path).toLowerCase())) {
				emit({ type: "show_images", sessionId: ctx.sessionId, paths: [path] });
				return `Showed ${path} to the user in the image viewer.`;
			}
			return (
				`Game Studio has no view for ${path}: it shows assets in its sections, design docs and images. The user hasn't seen it; ` +
				`describe what it shows, or give its full path: ${file}`
			);
		}),
	};
}
