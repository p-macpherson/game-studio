// A session's asset cards and mentions for its chat (shared/session-assets.ts does the working out): this gathers
// what it needs from disk: the transcript, the assets of the checkout the session's work is in, and for each
// asset a file that stands for it (a thumbnail, the rendered sound).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModuleInfo } from "../shared/modules";
import { type AssetCard, type Listed, type SessionAssets, type TranscriptMessage, sessionAssets } from "../shared/session-assets";
import { type AssetService, MODULES } from "./assets";
import type { SessionService } from "./sessions";

/** A picture of the asset, or its sound: `thumbnail.png` or a file named like the asset, in its folder or beside it. */
export function previewOf(root: string, path: string, module: ModuleInfo): AssetCard["preview"] {
	const has = (p: string) => existsSync(join(root, p));
	if (/\.(png|jpe?g|webp)$/i.test(path)) return { kind: "image", path };
	const dir = path.slice(0, path.lastIndexOf("/"));
	const file = path.slice(dir.length + 1);
	const manifest = module.extensions.some((e) => e === `/${file}`);
	// A folder-shaped asset is named by its folder; a file by itself without its extension.
	const leaf = manifest ? dir.slice(dir.lastIndexOf("/") + 1) : file.replace(/\.[^.]+$/, "");
	for (const p of [`${dir}/thumbnail.png`, `${dir}/${leaf}.png`]) if ((manifest || p.endsWith(`/${leaf}.png`)) && has(p)) return { kind: "image", path: p };
	if (has(`${dir}/${leaf}.ogg`)) return { kind: "audio", path: `${dir}/${leaf}.ogg` };
	return undefined;
}

export async function gatherSessionAssets(id: string, sessions: SessionService, assets: AssetService, checkoutRoot: (checkout: string | null) => string): Promise<SessionAssets> {
	const s = sessions.get(id);
	const messages = (await sessions.messages(id)) as TranscriptMessage[];
	// A game session's work is in its worktree while that's open; once merged (or for the engine's and the studio's
	// sessions, whose files aren't the game's assets) the game's main checkout is what there is to link to.
	const open = s.target === "project" && s.worktree === "active";
	const checkout = open ? s.worktreeId : null;
	let listed: Listed[] = [];
	try {
		listed = (await Promise.all(MODULES.map(async (m) => (await assets.list(m.info.id, checkout)).map((asset) => ({ module: m.info, asset }))))).flat();
	} catch {
		// No project open, or the checkout went away mid-read: no cards rather than an error in the chat.
	}
	const root = (() => {
		try {
			return checkoutRoot(checkout);
		} catch {
			return "";
		}
	})();
	// Pictures the agent showed are read from its own checkout, whichever repo it works in.
	const own = s.worktree === "active" ? s.worktreePath : "";
	const result = sessionAssets({
		messages,
		modules: MODULES.map((m) => m.info),
		listed,
		checkout,
		previewOf: (path, module) => (root ? previewOf(root, path, module) : undefined),
		isFile: (path) => {
			try {
				return !!own && statSync(join(own, path)).isFile();
			} catch {
				return false;
			}
		},
	});
	// A shown picture loads from the session's checkout, not main.
	for (const turn of result.turns) for (const c of turn) if (!c.module) c.checkout = id;
	return result;
}
