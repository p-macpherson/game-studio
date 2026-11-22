import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

/**
 * Renders markdown written by agents or users, sanitised. Clicks on relative links go to `onLink` (with the
 * href as written) so docs can link to each other; absolute links open in the browser. `imageSrc` turns an image's
 * relative path (as written) into a URL the page can load (a project file: studioFile).
 */
export function Markdown({ text, onLink, imageSrc, className = "" }: { text: string; onLink?(href: string): void; imageSrc?(src: string): string; className?: string }) {
	const html = useMemo(() => {
		const clean = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }));
		if (!imageSrc || !clean.includes("<img")) return clean;
		const doc = new DOMParser().parseFromString(clean, "text/html");
		for (const img of doc.querySelectorAll("img")) {
			const src = img.getAttribute("src");
			if (src && !/^[a-z]+:/i.test(src)) img.setAttribute("src", imageSrc(decodeURIComponent(src)));
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
	}, [text, imageSrc]);
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
