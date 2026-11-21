// UI screens (M10): the format of assets/ui/<name>.json, which the engine loads and draws (engine/engine/screens.odin;
// the fields here mirror its Ui_Element). Parse, validate, format, and structured edits by element id, shared by the
// UI section, its studio requests and the agents' tools, so everyone gets the same problems.
import { stripJson5 } from "./scene";

export const ELEMENT_TYPES = ["panel", "text", "image", "button", "slider", "checkbox", "bar", "stack"] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];
export const ANCHORS = ["top_left", "top", "top_right", "left", "center", "right", "bottom_left", "bottom", "bottom_right"] as const;
export type Anchor = (typeof ANCHORS)[number];

export interface UiElement {
	id: string;
	type: ElementType;
	anchor?: Anchor;
	offset?: [number, number];
	size?: [number, number];
	text?: string;
	font?: string;
	font_size?: number;
	align?: "left" | "center" | "right";
	color?: string;
	frame?: string;
	slice?: [number, number, number, number];
	border?: number;
	tint?: string;
	image?: string;
	action?: string;
	bind?: string;
	min?: number;
	max?: number;
	visible?: string;
	direction?: "vertical" | "horizontal";
	gap?: number;
	padding?: number;
	children?: UiElement[];
}

export interface UiScreen {
	notes?: string;
	pauses?: boolean;
	modal?: boolean;
	elements: UiElement[];
}

export const ELEMENT_FIELDS = [
	"id", "type", "anchor", "offset", "size", "text", "font", "font_size", "align", "color", "frame", "slice", "border", "tint", "image",
	"action", "bind", "min", "max", "visible", "direction", "gap", "padding", "children",
] as const;
const SCREEN_FIELDS = ["notes", "pauses", "modal", "elements"];
const COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface UiProblem {
	/** Where: "elements.menu.children.play.frame", "pauses", … (by element id). */
	at: string;
	message: string;
}

export interface ValidateUiContext {
	/** Whether an asset path (relative to assets/) exists: frames, images and fonts are checked when given. */
	exists?(assetPath: string): boolean;
}

/** Every problem in a screen; an empty list means the engine draws it as written. */
export function validateUiScreen(json: unknown, ctx: ValidateUiContext = {}): UiProblem[] {
	const problems: UiProblem[] = [];
	const fail = (at: string, message: string) => problems.push({ at, message });
	if (typeof json !== "object" || json === null || Array.isArray(json)) return [{ at: "", message: "A screen is a JSON object with \"elements\"" }];
	const s = json as Record<string, unknown>;
	for (const k of Object.keys(s)) if (!SCREEN_FIELDS.includes(k)) fail(k, `Unknown field (a screen has ${SCREEN_FIELDS.join(", ")})`);
	for (const k of ["pauses", "modal"]) if (s[k] !== undefined && typeof s[k] !== "boolean") fail(k, "true or false");
	if (s.notes !== undefined && typeof s.notes !== "string") fail("notes", "A string");
	if (!Array.isArray(s.elements)) return [...problems, { at: "elements", message: "A list of elements" }];
	const ids = new Map<string, number>();
	const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
	const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(num);
	const walk = (list: unknown[], path: string) => {
		list.forEach((raw, i) => {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(`${path}[${i}]`, "An element is an object");
			const e = raw as Record<string, unknown>;
			const at = typeof e.id === "string" && e.id ? `${path}.${e.id}` : `${path}[${i}]`;
			for (const k of Object.keys(e)) if (!(ELEMENT_FIELDS as readonly string[]).includes(k)) fail(`${at}.${k}`, "Unknown field");
			if (typeof e.id !== "string" || !/^[a-z0-9_-]+$/i.test(e.id)) fail(at, "Give it an id (letters, digits, - and _): the studio, tests and actions name it by its id");
			else ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
			if (!ELEMENT_TYPES.includes(e.type as ElementType)) fail(`${at}.type`, `One of ${ELEMENT_TYPES.join(", ")}`);
			if (e.anchor !== undefined && !ANCHORS.includes(e.anchor as Anchor)) fail(`${at}.anchor`, `One of ${ANCHORS.join(", ")}`);
			if (e.align !== undefined && !["left", "center", "right"].includes(e.align as string)) fail(`${at}.align`, "left, center or right");
			if (e.direction !== undefined && !["vertical", "horizontal"].includes(e.direction as string)) fail(`${at}.direction`, "vertical or horizontal");
			for (const k of ["offset", "size"]) if (e[k] !== undefined && !pair(e[k])) fail(`${at}.${k}`, "[x, y] in UI units");
			if (Array.isArray(e.size) && pair(e.size) && (e.size as number[]).some((v) => v < 0)) fail(`${at}.size`, "0 or more (0 fills the parent)");
			for (const k of ["font_size", "border", "gap", "padding", "min", "max"]) if (e[k] !== undefined && !num(e[k])) fail(`${at}.${k}`, "A number");
			for (const k of ["font_size", "border", "gap", "padding"]) if (num(e[k]) && (e[k] as number) < 0) fail(`${at}.${k}`, "0 or more");
			for (const k of ["text", "font", "frame", "image", "action", "bind", "visible"]) if (e[k] !== undefined && typeof e[k] !== "string") fail(`${at}.${k}`, "A string");
			for (const k of ["color", "tint"]) if (e[k] !== undefined && (typeof e[k] !== "string" || !COLOR.test(e[k] as string))) fail(`${at}.${k}`, '"#rrggbb" or "#rrggbbaa"');
			if (e.slice !== undefined && !(Array.isArray(e.slice) && e.slice.length === 4 && e.slice.every((v) => num(v) && v >= 0))) fail(`${at}.slice`, "[left, top, right, bottom] in pixels");
			if (num(e.min) && num(e.max) && (e.max as number) <= (e.min as number)) fail(`${at}.max`, "More than min");
			if ((e.type === "slider" || e.type === "checkbox" || e.type === "bar") && !e.bind) fail(`${at}.bind`, `A ${e.type} shows and changes a binding: give it one`);
			if (e.type === "image" && !e.image) fail(`${at}.image`, "An image element needs an image (an asset path)");
			if (e.type === "button" && !e.action) fail(`${at}.action`, "A button reports an action when clicked: name it (the game handles it)");
			if (ctx.exists) {
				for (const k of ["frame", "image", "font"]) {
					const p = e[k];
					if (typeof p === "string" && p && !ctx.exists(p)) fail(`${at}.${k}`, `No assets/${p}`);
				}
			}
			if (e.children !== undefined) {
				if (!Array.isArray(e.children)) fail(`${at}.children`, "A list of elements");
				else walk(e.children, `${at}.children`);
			}
		});
	};
	walk(s.elements, "elements");
	for (const [id, n] of ids) if (n > 1) fail(`elements.${id}`, `The id "${id}" is used ${n} times: ids must be unique in a screen`);
	return problems;
}

export function parseUiScreen(text: string, ctx: ValidateUiContext = {}): { screen: UiScreen | null; problems: UiProblem[] } {
	let json: unknown;
	try {
		json = JSON.parse(stripJson5(text));
	} catch (err) {
		return { screen: null, problems: [{ at: "", message: `Not valid JSON: ${(err as Error).message}` }] };
	}
	const problems = validateUiScreen(json, ctx);
	const structural = problems.some((p) => p.at === "" || p.at === "elements");
	return { screen: structural ? null : (json as UiScreen), problems };
}

/** Plain JSON, tab-indented, short number arrays on one line (offsets, sizes, slices), so diffs stay readable. */
export function formatUiScreen(screen: UiScreen): string {
	const text = JSON.stringify(screen, null, "\t");
	return `${text.replace(/\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+){1,3})\s*\]/g, (_m, inner: string) => `[${inner.split(/,\s*/).join(", ")}]`)}\n`;
}

/** Every element, depth first, with its parent's id (null at the top). */
export function allElements(screen: UiScreen): { element: UiElement; parent: string | null; depth: number }[] {
	const out: { element: UiElement; parent: string | null; depth: number }[] = [];
	const walk = (list: UiElement[], parent: string | null, depth: number) => {
		for (const e of list) {
			out.push({ element: e, parent, depth });
			if (e.children) walk(e.children, e.id, depth + 1);
		}
	};
	walk(screen.elements, null, 0);
	return out;
}

/** The bindings a screen reads ({name} in text, visible, bind) and the actions it reports. */
export function screenInterface(screen: UiScreen): { bindings: string[]; actions: string[] } {
	const bindings = new Set<string>();
	const actions = new Set<string>();
	for (const { element: e } of allElements(screen)) {
		for (const m of (e.text ?? "").matchAll(/\{([^}]+)\}/g)) bindings.add(m[1]);
		if (e.visible) bindings.add(e.visible.replace(/^!/, ""));
		if (e.bind) bindings.add(e.bind);
		if (e.action) actions.add(e.action);
	}
	return { bindings: [...bindings].sort(), actions: [...actions].sort() };
}

export type UiEdit =
	| { op: "set"; id: string; fields: Partial<Record<(typeof ELEMENT_FIELDS)[number], unknown>> }
	| { op: "add"; element: UiElement; parent?: string; index?: number }
	| { op: "delete"; id: string }
	| { op: "move"; id: string; parent?: string | null; index?: number }
	| { op: "screen"; fields: { notes?: string; pauses?: boolean; modal?: boolean } };

/** Applies edits in order to a copy; throws on an edit that can't apply (an unknown id, a cycle). */
export function applyUiEdits(screen: UiScreen, edits: UiEdit[]): UiScreen {
	const next: UiScreen = structuredClone(screen);
	const listOf = (parent: string | null | undefined): UiElement[] => {
		if (!parent) return next.elements;
		const p = find(next, parent);
		if (!p) throw new Error(`No element "${parent}"`);
		return (p.children ??= []);
	};
	const locate = (id: string): { list: UiElement[]; index: number } => {
		const hit = allElements(next).find((x) => x.element.id === id);
		if (!hit) throw new Error(`No element "${id}"`);
		const list = listOf(hit.parent);
		return { list, index: list.indexOf(hit.element) };
	};
	for (const e of edits) {
		if (e.op === "screen") {
			for (const [k, v] of Object.entries(e.fields)) {
				if (v === null || v === undefined) delete (next as unknown as Record<string, unknown>)[k];
				else (next as unknown as Record<string, unknown>)[k] = v;
			}
		} else if (e.op === "set") {
			const el = find(next, e.id);
			if (!el) throw new Error(`No element "${e.id}"`);
			for (const [k, v] of Object.entries(e.fields)) {
				if (k === "children") throw new Error("Change children with add, move and delete");
				// null removes a field: zero means default in the engine, so the file stays short.
				if (v === null || v === undefined) delete (el as unknown as Record<string, unknown>)[k];
				else (el as unknown as Record<string, unknown>)[k] = v;
			}
		} else if (e.op === "add") {
			if (allElements(next).some((x) => x.element.id === e.element.id)) throw new Error(`The id "${e.element.id}" is taken`);
			const list = listOf(e.parent);
			list.splice(e.index ?? list.length, 0, structuredClone(e.element));
		} else if (e.op === "delete") {
			const { list, index } = locate(e.id);
			list.splice(index, 1);
		} else if (e.op === "move") {
			const { list, index } = locate(e.id);
			const [el] = list.splice(index, 1);
			if (e.parent && (e.parent === el.id || allElements({ elements: [el] }).some((x) => x.element.id === e.parent))) {
				list.splice(index, 0, el);
				throw new Error(`"${el.id}" can't move inside itself`);
			}
			const to = e.parent === undefined ? list : listOf(e.parent);
			to.splice(e.index ?? to.length, 0, el);
		}
	}
	return next;
}

export function find(screen: UiScreen, id: string): UiElement | undefined {
	return allElements(screen).find((x) => x.element.id === id)?.element;
}

/** A short description of an edit, for the undo history ("set play.frame", "added quit"). */
export function describeUiEdit(e: UiEdit): string {
	switch (e.op) {
		case "set":
			return `set ${e.id}.${Object.keys(e.fields).join(", ")}`;
		case "add":
			return `added ${e.element.id}`;
		case "delete":
			return `deleted ${e.id}`;
		case "move":
			return `moved ${e.id}`;
		case "screen":
			return Object.keys(e.fields).join(", ");
	}
}
