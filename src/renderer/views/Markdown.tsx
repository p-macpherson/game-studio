import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

/**
 * Renders markdown written by agents or users, sanitised. Clicks on relative links go to `onLink` (with the
 * href as written) so docs can link to each other; absolute links open in the browser.
 */
export function Markdown({ text, onLink, className = "" }: { text: string; onLink?(href: string): void; className?: string }) {
	const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true })), [text]);
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
