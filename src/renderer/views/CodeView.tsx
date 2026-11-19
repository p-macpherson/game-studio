// Read-only source view with line numbers and light syntax colouring (Odin, and the JSON lines of control scripts).
import { type ReactNode, useEffect, useMemo, useRef } from "react";

const KEYWORDS = new Set(
	"package import proc struct enum union return if else for in not_in switch case defer when break continue fallthrough distinct using map dynamic bit_set cast transmute auto_cast or_else or_return nil true false context matrix where foreign do".split(
		" ",
	),
);
const TOKEN = /(\/\/.*$)|(\/\*)|("(?:[^"\\]|\\.)*"?|`[^`]*`?|'(?:[^'\\]|\\.)*'?)|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([#@][A-Za-z_(][\w()]*)|([A-Za-z_]\w*)/g;

/** Splits code into coloured spans. Block comments may span lines, so the state carries between lines. */
function highlight(lines: string[]): ReactNode[][] {
	let inBlock = false;
	return lines.map((line) => {
		const out: ReactNode[] = [];
		let i = 0;
		const push = (text: string, cls?: string) => out.push(cls ? <span key={out.length} className={cls}>{text}</span> : text);
		while (i < line.length) {
			if (inBlock) {
				const end = line.indexOf("*/", i);
				push(line.slice(i, end < 0 ? line.length : end + 2), "tk-comment");
				if (end < 0) return out;
				i = end + 2;
				inBlock = false;
				continue;
			}
			TOKEN.lastIndex = i;
			const m = TOKEN.exec(line);
			if (!m) {
				push(line.slice(i));
				break;
			}
			if (m.index > i) push(line.slice(i, m.index));
			i = m.index + m[0].length;
			if (m[1]) push(m[1], "tk-comment");
			else if (m[2]) {
				inBlock = true;
				i = m.index;
			} else if (m[3]) push(m[3], "tk-string");
			else if (m[4]) push(m[4], "tk-number");
			else if (m[5]) push(m[5], "tk-directive");
			else push(m[6], KEYWORDS.has(m[6]) ? "tk-keyword" : /^[A-Z]/.test(m[6]) ? "tk-type" : undefined);
		}
		return out;
	});
}

export function CodeView({ text, line }: { text: string; line?: number }) {
	const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
	const tokens = useMemo(() => highlight(lines), [lines]);
	const target = useRef<HTMLDivElement>(null);
	useEffect(() => {
		target.current?.scrollIntoView({ block: "center" });
	}, [line, text]);
	return (
		<pre className="code-view" data-testid="code-view">
			{tokens.map((t, i) => (
				<div key={i} ref={i + 1 === line ? target : undefined} className={`code-line ${i + 1 === line ? "target" : ""}`}>
					<span className="ln">{i + 1}</span>
					<span>{t.length ? t : " "}</span>
				</div>
			))}
		</pre>
	);
}
