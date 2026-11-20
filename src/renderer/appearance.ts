// Themes and fonts (Settings → Appearance). A theme fills the CSS variables every view colours itself with
// (styles.css derives tints such as the error bar and the selection from them); fonts are bundled (Fontsource), so
// they work offline and look the same on every machine. The choice is kept in localStorage and applied before the
// first render.
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/figtree";
import "@fontsource-variable/fira-code";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/manrope";
import "@fontsource-variable/nunito";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/source-code-pro";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/victor-mono";
import { THEMES, type Theme } from "../shared/themes";

export { THEMES, type Theme };

export interface Font {
	id: string;
	name: string;
	/** The CSS font-family stack. */
	family: string;
}

const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = "ui-monospace, monospace";
export const FONTS: Font[] = [
	{ id: "system", name: "System", family: SANS },
	{ id: "inter", name: "Inter", family: `"Inter Variable", ${SANS}` },
	{ id: "geist", name: "Geist", family: `"Geist Variable", ${SANS}` },
	{ id: "ibm-plex-sans", name: "IBM Plex Sans", family: `"IBM Plex Sans Variable", ${SANS}` },
	{ id: "dm-sans", name: "DM Sans", family: `"DM Sans Variable", ${SANS}` },
	{ id: "manrope", name: "Manrope", family: `"Manrope Variable", ${SANS}` },
	{ id: "figtree", name: "Figtree", family: `"Figtree Variable", ${SANS}` },
	{ id: "plus-jakarta-sans", name: "Plus Jakarta Sans", family: `"Plus Jakarta Sans Variable", ${SANS}` },
	{ id: "nunito", name: "Nunito", family: `"Nunito Variable", ${SANS}` },
	{ id: "space-grotesk", name: "Space Grotesk", family: `"Space Grotesk Variable", ${SANS}` },
];
export const MONO_FONTS: Font[] = [
	{ id: "system", name: "System monospace", family: MONO },
	{ id: "jetbrains-mono", name: "JetBrains Mono", family: `"JetBrains Mono Variable", ${MONO}` },
	{ id: "fira-code", name: "Fira Code", family: `"Fira Code Variable", ${MONO}` },
	{ id: "geist-mono", name: "Geist Mono", family: `"Geist Mono Variable", ${MONO}` },
	{ id: "source-code-pro", name: "Source Code Pro", family: `"Source Code Pro Variable", ${MONO}` },
	{ id: "victor-mono", name: "Victor Mono", family: `"Victor Mono Variable", ${MONO}` },
];

export interface Appearance {
	theme: string;
	font: string;
	mono: string;
}
const KEY = "appearance";
export const DEFAULT_APPEARANCE: Appearance = { theme: "simple-dark", font: "system", mono: "jetbrains-mono" };

export function loadAppearance(): Appearance {
	try {
		return { ...DEFAULT_APPEARANCE, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
	} catch {
		return DEFAULT_APPEARANCE;
	}
}

/** Sets the theme's colours and the fonts on the page; views drawing outside CSS (the 3D viewer) hear "studio-appearance". */
export function applyAppearance(a: Appearance): void {
	const theme = THEMES.find((t) => t.id === a.theme) ?? THEMES[0];
	const root = document.documentElement;
	for (const [k, v] of Object.entries(theme.colors)) root.style.setProperty(`--${k.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)}`, v);
	root.style.setProperty("--font", (FONTS.find((f) => f.id === a.font) ?? FONTS[0]).family);
	root.style.setProperty("--mono", (MONO_FONTS.find((f) => f.id === a.mono) ?? MONO_FONTS[0]).family);
	root.style.colorScheme = theme.kind;
	root.dataset.theme = theme.id;
	window.dispatchEvent(new Event("studio-appearance"));
}

export function saveAppearance(a: Appearance): void {
	localStorage.setItem(KEY, JSON.stringify(a));
	applyAppearance(a);
}

/** A theme colour as the page has it now (for canvases and the 3D viewer). */
export const themeColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
