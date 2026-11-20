import { describe, expect, it } from "vitest";
import { THEMES } from "./themes";

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
	const lum = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}

describe("themes", () => {
	it("have unique ids and every colour as #rrggbb", () => {
		expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
		for (const t of THEMES) for (const [k, v] of Object.entries(t.colors)) expect(v, `${t.id}.${k}`).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("keep text readable: body text, secondary text, links and primary buttons", () => {
		const low: string[] = [];
		for (const t of THEMES) {
			const c = t.colors;
			const need = (what: string, fg: string, bg: string, min: number) => contrast(fg, bg) < min && low.push(`${t.id} ${what} ${contrast(fg, bg).toFixed(2)} < ${min}`);
			for (const bg of ["bg", "panel", "panel2"] as const) need(`text on ${bg}`, c.text, c[bg], 4.5);
			need("muted on bg", c.muted, c.bg, 3);
			need("muted on panel2", c.muted, c.panel2, 2.5);
			need("accent on bg", c.accent, c.bg, 3);
			need("button text", c.onAccent, c.accent2, 3);
		}
		expect(low).toEqual([]);
	});
});
