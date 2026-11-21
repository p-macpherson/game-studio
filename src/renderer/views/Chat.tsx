import { memo, useEffect, useMemo, useRef } from "react";
import { type ChatMessage, type ContentBlock, type Transcript, useStudio } from "../store";
import { Markdown } from "./Markdown";

function text(content: ChatMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function toolSummary(name: string, args: Record<string, unknown>): string {
	const main = args.command ?? args.path ?? args.title ?? args.question ?? args.summary ?? "";
	return `${name} ${typeof main === "string" ? main : JSON.stringify(main)}`;
}

function ToolCall({ block, result, running }: { block: Extract<ContentBlock, { type: "toolCall" }>; result?: ChatMessage; running: boolean }) {
	const output = result ? text(result.content) : "";
	return (
		<details className={`tool ${result?.isError ? "failed" : ""}`}>
			<summary>
				<span>{running ? "⏳" : result?.isError ? "✗" : "▸"}</span>
				<code>{toolSummary(block.name, block.arguments ?? {})}</code>
			</summary>
			<pre>{JSON.stringify(block.arguments, null, 2)}</pre>
			{result && <pre>{output || "(no output)"}</pre>}
		</details>
	);
}

// Memoised: while a reply streams, only the streaming message changes; the finished ones above it are left alone.
const Assistant = memo(function Assistant({ m, results, running }: { m: ChatMessage; results: Map<string, ChatMessage>; running: Record<string, string> }) {
	const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
	return (
		<div className="msg assistant">
			{blocks.map((b, i) => {
				if (b.type === "text") return b.text ? <Markdown key={i} text={b.text} onLink={(path) => useStudio.getState().showAsset({ path })} /> : null;
				if (b.type === "thinking") return b.thinking ? <div key={i} className="thinking">{b.thinking}</div> : null;
				if (b.type === "toolCall") return <ToolCall key={i} block={b} result={results.get(b.id)} running={b.id in running} />;
				return null;
			})}
			{m.stopReason === "error" && <div className="msg error">{m.errorMessage ?? "The model returned an error"}</div>}
			{m.stopReason === "aborted" && <div className="muted">(stopped)</div>}
		</div>
	);
});

export function Chat({ transcript }: { transcript: Transcript }) {
	const end = useRef<HTMLDivElement>(null);
	const results = useMemo(() => new Map(transcript.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId!, m])), [transcript.messages]);
	const shown = transcript.streaming ? [...transcript.messages, transcript.streaming] : transcript.messages;

	useEffect(() => {
		// Block body: newer Chromium returns a Promise from scrollIntoView, which React would take as a cleanup.
		void end.current?.scrollIntoView({ block: "end" });
	}, [shown.length, transcript.streaming]);

	return (
		<div className="chat" data-testid="chat">
			{shown.map((m, i) => {
				if (m.role === "user") return <div key={i} className="msg user">{text(m.content)}</div>;
				if (m.role === "assistant") return <Assistant key={i} m={m} results={results} running={transcript.runningTools} />;
				return null;
			})}
			{Object.keys(transcript.runningTools).length > 0 && (
				<div className="muted">Running {Object.values(transcript.runningTools).join(", ")}…</div>
			)}
			<div ref={end} />
		</div>
	);
}
