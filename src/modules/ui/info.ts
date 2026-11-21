import { leafName } from "../../shared/asset-names";
import type { ModuleInfo } from "../../shared/modules";
import { parseUiArt } from "../../shared/ui-art";
import { allElements, parseUiScreen, screenInterface } from "../../shared/ui-screen";

/**
 * The game's UI (M10): screens (`assets/ui/<name>.json`, drawn by the engine over the game) and UI art
 * (`assets/ui/art/<name>/`: frames, buttons and icons screens use). See the vault note "M10 UI".
 */
export const ui: ModuleInfo = {
	id: "ui",
	name: "UI",
	icon: "🪟",
	roots: ["assets/ui"],
	extensions: [".json"],
	exclude: ["/candidates/"],
	folderAssets: ["assets/ui/art"],
	agentType: "art-director",
	noun: "screen",
};

export const UI_ROOT = "assets/ui";
export const ART_ROOT = "assets/ui/art";

export const isArt = (path: string) => path.startsWith(`${ART_ROOT}/`);
/** A screen's name from its path: `assets/ui/menus/title.json` is "menus/title" (what `ui_show` takes). */
export const screenName = (path: string) => path.slice(UI_ROOT.length + 1).replace(/\.json$/, "");
/** A piece of art's name: its folder under assets/ui/art (`assets/ui/art/icons/coin/coin.json` is "icons/coin"). */
export const artName = (path: string) => path.slice(ART_ROOT.length + 1, path.lastIndexOf("/"));
/** The image screens use for a piece of art (assets-relative, as `frame` and `image` take it). */
export const artImage = (name: string) => `ui/art/${name}/${leafName(name)}.png`;

/**
 * The edit a drag in the live view makes, from its distance in frame pixels (`frameHeight`: the engine's frame, 720
 * UI units tall). Moving changes the offset, which points towards the centre from the anchor: dragging right adds
 * to it for left and centre anchors and takes from it for right ones (down: top and centre add, bottom takes).
 * Resizing sets the size from the laid-out one. Null when it didn't move a whole unit.
 */
export function dragEdit(
	el: { id: string; anchor?: string; offset?: [number, number] },
	laidOut: { w: number; h: number },
	d: { kind: "move" | "resize"; dx: number; dy: number },
	frameHeight: number,
): { op: "set"; id: string; fields: Record<string, unknown> } | null {
	const k = frameHeight / 720;
	const dx = Math.round(d.dx / k);
	const dy = Math.round(d.dy / k);
	if (!dx && !dy) return null;
	if (d.kind === "resize") return { op: "set", id: el.id, fields: { size: [Math.max(4, Math.round(laidOut.w + dx)), Math.max(4, Math.round(laidOut.h + dy))] } };
	const a = el.anchor ?? "top_left";
	const [ox, oy] = el.offset ?? [0, 0];
	return { op: "set", id: el.id, fields: { offset: [ox + (a.endsWith("right") ? -dx : dx), oy + (a.startsWith("bottom") ? -dy : dy)] } };
}

export function summarizeUi(text: string, path: string): { title: string; excerpt: string } {
	if (isArt(path)) {
		const name = artName(path);
		const { art, problems } = parseUiArt(text);
		if (!art) return { title: name, excerpt: `${problems.length} problem${problems.length > 1 ? "s" : ""} in ${leafName(name)}.json` };
		return { title: name, excerpt: [art.kind, art.source ? "made" : "candidates only", art.notes ?? art.prompt].filter(Boolean).join(" · ") };
	}
	const name = screenName(path);
	const { screen, problems } = parseUiScreen(text);
	if (!screen) return { title: name, excerpt: `${problems.length} problem${problems.length > 1 ? "s" : ""} in the screen file` };
	const { bindings, actions } = screenInterface(screen);
	const facts = [
		`${allElements(screen).length} elements`,
		screen.pauses ? "pauses" : "",
		bindings.length ? `shows ${bindings.join(", ")}` : "",
		actions.length ? `actions ${actions.join(", ")}` : "",
	];
	return { title: name, excerpt: [screen.notes, facts.filter(Boolean).join(" · ")].filter(Boolean).join(" · ") };
}
