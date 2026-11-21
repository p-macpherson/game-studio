// UI art (M10): the format of assets/ui/art/<name>/<leaf>.json, the asset. Its folder holds candidates/ (generated
// images, cut out, with candidates.json saying how each was made) and, once one is chosen and made, <leaf>.png: a
// frame or button screens stretch as a 9-slice (the engine reads `slice` from this same file, see
// engine/engine/screens.odin), or an icon.

export type UiArtKind = "frame" | "button" | "icon";
export const UI_ART_KINDS: readonly UiArtKind[] = ["frame", "button", "icon"];

export interface UiArtFile {
	/** What it's for, for people and agents. */
	notes?: string;
	kind: UiArtKind;
	/** The generation prompt (the subject; the studio adds the kind's framing and the plain background). */
	prompt?: string;
	/** The chosen candidate, relative to the art's folder (candidates/<file>.png). */
	source?: string;
	/** Frames and buttons: corner insets in pixels of <leaf>.png (left, top, right, bottom): what doesn't stretch. */
	slice?: [number, number, number, number];
	/** Frames and buttons: whether candidates are made exactly symmetric (the top-left quarter mirrored; default true). */
	mirror?: boolean;
}

export interface UiArtProblem {
	at: string;
	message: string;
}

const FIELDS = ["notes", "kind", "prompt", "source", "slice", "mirror"];

/** How each kind is asked for (the subject comes first): what makes a usable piece, on a background that keys out. */
export const UI_ART_FRAMING: Record<UiArtKind, { framing: string; width: number; height: number }> = {
	frame: {
		framing:
			"a rectangular game UI panel frame seen straight on, perfectly symmetrical, centred and filling most of the image, a decorated border with a plain flat empty inside, no text",
		width: 1024,
		height: 1024,
	},
	button: {
		framing: "a wide game UI button seen straight on, pill-shaped or a rounded rectangle (not an oval), perfectly symmetrical, centred, its centre plain and flat, no text",
		width: 1024,
		height: 512,
	},
	icon: { framing: "a single game inventory icon, centred, bold readable shape, no text", width: 1024, height: 1024 },
};

export const UI_ART_BACKGROUND = "isolated on a plain flat white background";

export function uiArtPrompt(kind: UiArtKind, subject: string, style?: string): string {
	return [subject, UI_ART_FRAMING[kind].framing, style, UI_ART_BACKGROUND].filter((s) => s && s.trim()).join(", ");
}

export function validateUiArt(json: unknown): UiArtProblem[] {
	const problems: UiArtProblem[] = [];
	if (typeof json !== "object" || json === null || Array.isArray(json)) return [{ at: "", message: "A JSON object" }];
	const a = json as Record<string, unknown>;
	for (const k of Object.keys(a)) if (!FIELDS.includes(k)) problems.push({ at: k, message: `Unknown field (fields: ${FIELDS.join(", ")})` });
	if (!UI_ART_KINDS.includes(a.kind as UiArtKind)) problems.push({ at: "kind", message: `One of ${UI_ART_KINDS.join(", ")}` });
	for (const k of ["notes", "prompt"]) if (a[k] !== undefined && typeof a[k] !== "string") problems.push({ at: k, message: "A string" });
	if (a.source !== undefined && (typeof a.source !== "string" || !/^candidates\/[^/]+\.png$/.test(a.source))) problems.push({ at: "source", message: "A candidate image: candidates/<file>.png" });
	if (a.slice !== undefined) {
		const s = a.slice;
		if (!Array.isArray(s) || s.length !== 4 || !s.every((v) => Number.isInteger(v) && v >= 0)) problems.push({ at: "slice", message: "[left, top, right, bottom]: whole pixels, 0 or more" });
		else if (a.kind === "icon" && s.some((v) => v > 0)) problems.push({ at: "slice", message: "Icons aren't stretched: no slice" });
	}
	if (a.mirror !== undefined && typeof a.mirror !== "boolean") problems.push({ at: "mirror", message: "true or false" });
	return problems;
}

export function parseUiArt(text: string): { art: UiArtFile | null; problems: UiArtProblem[] } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		return { art: null, problems: [{ at: "", message: `Not valid JSON: ${(err as Error).message}` }] };
	}
	const problems = validateUiArt(json);
	return { art: problems.length ? null : (json as UiArtFile), problems };
}

export function formatUiArt(a: UiArtFile): string {
	const ordered: Record<string, unknown> = {};
	for (const k of FIELDS) if ((a as unknown as Record<string, unknown>)[k] !== undefined) ordered[k] = (a as unknown as Record<string, unknown>)[k];
	return `${JSON.stringify(ordered, null, "\t").replace(/\[\n\t+(\d+),\n\t+(\d+),\n\t+(\d+),\n\t+(\d+)\n\t+\]/, "[$1, $2, $3, $4]")}\n`;
}
