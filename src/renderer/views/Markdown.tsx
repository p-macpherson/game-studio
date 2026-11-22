import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

/** A path in the text that names an asset: shown as a link with the asset's icon and name. */
export interface Chip {
	label: string;
	icon: string;
	title: string;
	/** An image to show while the pointer is on it. */
	preview?: string;
}

/** Turns the asset paths in sanitised markdown (in `code` or in running text) into chips; their href is the path as written. */
function addChips(doc: Document, chips: Record<string, Chip>): void {
	const keys = Object.keys(chips).sort((a, b) => b.length - a.length);
	const make = (key: string) => {
		const chip = chips[key];
		const a = doc.createElement("a");
		a.className = "asset-chip";
		a.setAttribute("href", encodeURI(key));
		a.setAttribute("data-asset", key);
		a.title = chip.title;
		if (chip.preview) a.setAttribute("data-preview", chip.preview);
		a.textContent = `${chip.icon} ${chip.label}`;
		return a;
	};
	for (const code of doc.querySelectorAll("code")) {
		if (code.closest("pre, a")) continue;
		const key = (code.textContent ?? "").trim().replace(/\/+$/, "");
		if (key in chips) code.replaceWith(make(key));
	}
	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
	const texts: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement as Element | null)?.closest("a, code, pre")) texts.push(n as Text);
	for (const node of texts) {
		const s = node.data;
		const parts: (string | HTMLElement)[] = [];
		let at = 0;
		for (let i = 0; i < s.length; ) {
			const key = keys.find((k) => s.startsWith(k, i) && !/[\w-]/.test(s[i - 1] ?? "") && !/[\w-]/.test(s[i + k.length] ?? ""));
			if (!key) {
				i++;
				continue;
			}
			if (i > at) parts.push(s.slice(at, i));
			parts.push(make(key));
			i += key.length;
			at = i;
		}
		if (!parts.length) continue;
		if (at < s.length) parts.push(s.slice(at));
		node.replaceWith(...parts);
	}
}

/**
 * Renders markdown written by agents or users, sanitised. Clicks on relative links go to `onLink` (with the
 * href as written) so docs can link to each other; absolute links open in the browser. `imageSrc` turns an image's
 * relative path (as written) into a URL the page can load (a project file: studioFile). `chips`: asset paths to show
 * as links (a click goes to `onLink` with the path as written).
 */
export function Markdown({ text, onLink, imageSrc, chips, className = "" }: { text: string; onLink?(href: string): void; imageSrc?(src: string): string; chips?: Record<string, Chip>; className?: string }) {
	const html = useMemo(() => {
		const clean = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }));
		const hasChips = !!chips && Object.keys(chips).some((k) => text.includes(k));
		const hasImages = !!imageSrc && clean.includes("<img");
		if (!hasImages && !hasChips) return clean;
		const doc = new DOMParser().parseFromString(clean, "text/html");
		if (hasChips) addChips(doc, chips!);
		for (const img of hasImages ? doc.querySelectorAll("img") : []) {
			const src = img.getAttribute("src");
			if (src && !/^[a-z]+:/i.test(src)) img.setAttribute("src", imageSrc!(decodeURIComponent(src)));
			if (img.alt && !img.title) img.title = img.alt;
			// The caption (what the image is a reference for) under it.
			if (img.alt) {
				const caption = doc.createElement("span");
				caption.className = "md-caption";
				caption.textContent = img.alt;
				img.after(caption);
			}
		}
		return doc.body.innerHTML;
	}, [text, imageSrc, chips]);
	return (
		<div
			className={`markdown ${className}`}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised above
			dangerouslySetInnerHTML={{ __html: html }}
			onClick={(e) => {
				const a = (e.target as HTMLElement).closest("a");
				const href = a?.getAttribute("href");
				if (!href) return;
				e.preventDefault();
				if (/^[a-z]+:/i.test(href)) window.open(href);
				else onLink?.(decodeURIComponent(href));
			}}
		/>
	);
}
