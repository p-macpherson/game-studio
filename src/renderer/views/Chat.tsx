// A session's conversation, two ways. `Chat`: what the person and the agent said to each other, with the agent's
// work in between folded to a line (and, while it works, a panel of what it's doing now). `FullTranscript`: all of
// it: thinking, every tool call and its output.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ChatMessage, type ContentBlock, type Transcript, useStudio } from "../store";
import { splitAttachments } from "../../shared/attachments";
import { RESUME_NOTE } from "../../shared/types";
import { CHECKS_FAILED_NOTE } from "../../shared/review";
import { RETRY_NOTE, describeModelError, retryLine } from "../../shared/model-errors";
import type { SessionAssets } from "../../shared/session-assets";
import { type Chip, Markdown } from "./Markdown";
import { AssetStrip, openCard, useChipPreview, useChips } from "./SessionAssets";

function text(content: ChatMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
const blocksOf = (m: ChatMessage): ContentBlock[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
type ToolBlock = Extract<ContentBlock, { type: "toolCall" }>;
const toolCalls = (m: ChatMessage) => blocksOf(m).filter((b): b is ToolBlock => b.type === "toolCall");

function toolSummary(name: string, args: Record<string, unknown>): string {
	const main = args.command ?? args.path ?? args.title ?? args.question ?? args.summary ?? "";
	return `${name} ${typeof main === "string" ? main : JSON.stringify(main)}`;
}

function ToolCall({ block, result, running }: { block: ToolBlock; result?: ChatMessage; running: boolean }) {
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

/** The person's message: their words, and the images they pasted with it (a click enlarges one). */
const UserMessage = memo(function UserMessage({ m, brief }: { m: ChatMessage; brief?: boolean }) {
	const { text: words, paths } = splitAttachments(text(m.content));
	const images = blocksOf(m).flatMap((b) => (b.type === "image" && typeof b.data === "string" ? [`data:${String(b.mimeType ?? "image/png")};base64,${b.data}`] : []));
	const viewer = images.map((src, i) => ({ src, label: paths[i] ?? `Image ${i + 1}` }));
	// The studio's own words on Resume, not the person's: a short note (the full transcript has the whole text).
	if (brief && words.startsWith(RESUME_NOTE)) {
		return (
			<div className="msg-note" title={words} data-testid="resumed-note">
				▶ Resumed after an interruption{words.length > RESUME_NOTE.length ? ", with its sub-agents' reports" : ""}
			</div>
		);
	}
	if (brief && words.startsWith(RETRY_NOTE)) {
		return (
			<div className="msg-note" title={words} data-testid="retried-note">
				↻ Tried again after an error
			</div>
		);
	}
	if (brief && words.startsWith(CHECKS_FAILED_NOTE)) {
		const what = words.slice(CHECKS_FAILED_NOTE.length).trim().split("\n")[0];
		return (
			<div className="msg-note" title={words} data-testid="checks-note">
				↩ Sent back by the studio before reaching you: {what}
			</div>
		);
	}
	return (
		<div className="msg user" data-testid="user-message">
			{images.length > 0 && (
				<div className="msg-images">
					{images.map((src, i) => (
						<img key={i} src={src} alt="" title={paths[i] ? `Saved for the agent at ${paths[i]}` : undefined} onClick={() => useStudio.getState().showImages(viewer, i)} data-testid="message-image" />
					))}
				</div>
			)}
			{words}
			{!images.length && paths.length > 0 && <div className="msg-attached">📎 {paths.length} image{paths.length === 1 ? "" : "s"} attached (not shown to this model): {paths.join(", ")}</div>}
		</div>
	);
});

/** What the agent's words link to, for a click: an asset it named (its card says where), else a path in the project. */
interface Links {
	chips?: Record<string, Chip>;
	open(path: string): void;
}
const plainLinks: Links = { open: (path) => useStudio.getState().showAsset({ path }) };
function useLinks(assets: SessionAssets | undefined): Links {
	const chips = useChips(assets);
	return useMemo(() => {
		if (!assets || !chips) return plainLinks;
		return { chips, open: (path) => (assets.mentions[path] ? openCard(assets.mentions[path]) : plainLinks.open(path)) };
	}, [assets, chips]);
}

// Memoised: while a reply streams, only the streaming message changes; the finished ones above it are left alone.
const Assistant = memo(function Assistant({ m, results, running, links }: { m: ChatMessage; results: Map<string, ChatMessage>; running: Record<string, string>; links: Links }) {
	return (
		<div className="msg assistant">
			{blocksOf(m).map((b, i) => {
				if (b.type === "text") return b.text ? <Markdown key={i} text={b.text} onLink={links.open} chips={links.chips} /> : null;
				if (b.type === "thinking") return b.thinking ? <div key={i} className="thinking">{b.thinking}</div> : null;
				if (b.type === "toolCall") return <ToolCall key={i} block={b} result={results.get(b.id)} running={b.id in running} />;
				return null;
			})}
			<Ending m={m} />
		</div>
	);
});

/** An error from the model's provider, in words: what happened and what to do (the raw text is the tooltip). */
export function ModelErrorText({ raw }: { raw: string }) {
	const e = describeModelError(raw);
	return (
		<span title={raw} data-testid="model-error">
			<b>{e.title}.</b> {e.detail}
		</span>
	);
}

/** Counts down to the session's next try of a failed request. */
function Retrying({ retrying }: { retrying: NonNullable<Transcript["retrying"]> }) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 500);
		return () => clearInterval(t);
	}, []);
	return (
		<div className="working-said" title={retrying.error} data-testid="retrying">
			{describeModelError(retrying.error).title}. {retryLine(retrying, now)}
		</div>
	);
}

function Ending({ m }: { m: ChatMessage }) {
	if (m.stopReason === "error") {
		return (
			<div className="msg error">
				<ModelErrorText raw={m.errorMessage ?? "The model returned an error"} />
			</div>
		);
	}
	if (m.stopReason === "aborted") return <div className="muted">(stopped)</div>;
	return null;
}

/** The agent's reply to the person: its words only. */
const Reply = memo(function Reply({ m, links }: { m: ChatMessage; links: Links }) {
	const said = text(m.content);
	if (!said.trim() && m.stopReason !== "error" && m.stopReason !== "aborted") return null;
	return (
		<div className="msg assistant">
			{said.trim() && <Markdown text={said} onLink={links.open} chips={links.chips} />}
			<Ending m={m} />
		</div>
	);
});

/**
 * A scrolling pane that follows its newest content only while the person is at the bottom: once they scroll up to
 * read, it stays put and offers "Jump to latest". `version` changes whenever the content does; `own` when the
 * person sends something (which always returns to the bottom).
 */
function Following({ version, own, testId, children }: { version: unknown; own: number; testId: string; children: React.ReactNode }) {
	const pane = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const [away, setAway] = useState(false);
	const toEnd = () => {
		const el = pane.current;
		if (el) el.scrollTop = el.scrollHeight;
	};
	useLayoutEffect(() => {
		if (following.current) toEnd();
	}, [version]);
	useLayoutEffect(() => {
		following.current = true;
		setAway(false);
		toEnd();
	}, [own]);
	const onScroll = () => {
		const el = pane.current;
		if (!el) return;
		const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		following.current = atEnd;
		setAway(!atEnd);
	};
	return (
		<div className="chat-pane">
			<div className="chat-scroll" ref={pane} onScroll={onScroll} data-testid={`${testId}-scroll`}>
				<div className="chat" data-testid={testId}>
					{children}
				</div>
			</div>
			{away && (
				<button
					className="jump-latest"
					onClick={() => {
						following.current = true;
						setAway(false);
						toEnd();
					}}
					data-testid="jump-latest"
				>
					↓ Jump to latest
				</button>
			)}
		</div>
	);
}

const userCount = (messages: ChatMessage[]) => messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);

type Item = { kind: "retried"; count: number; error: string } | { kind: "user"; m: ChatMessage } | { kind: "reply"; m: ChatMessage } | { kind: "work"; steps: number; failed: ChatMessage[] } | { kind: "compacted" };

/** The conversation as turns: what was said, with each stretch of the agent's work (messages that call tools) as one item. */
function conversation(messages: ChatMessage[], retryingNow = false): { items: Item[]; open: { steps: number; said: string } | null } {
	const items: Item[] = [];
	// A request that failed and was tried again (another attempt follows it in the same turn, or is being waited for
	// now) isn't an error to read: the tries fold into one quiet line.
	const retried = new Set<ChatMessage>();
	let failed: ChatMessage[] = [];
	for (const m of messages) {
		if (m.role === "user") failed = [];
		else if (m.role === "assistant") {
			for (const f of failed) retried.add(f);
			failed = m.stopReason === "error" ? [m] : [];
		}
	}
	if (retryingNow) for (const f of failed) retried.add(f);
	let work: { steps: number; failed: ChatMessage[]; said: string } | null = null;
	const flush = () => {
		if (work) items.push({ kind: "work", steps: work.steps, failed: work.failed });
		work = null;
	};
	for (const m of messages) {
		if (m.role === "user") {
			flush();
			items.push({ kind: "user", m });
		} else if (m.role === "assistant" && retried.has(m)) {
			const last = items.at(-1);
			if (last?.kind === "retried" && !work) last.count++;
			else {
				flush();
				items.push({ kind: "retried", count: 1, error: m.errorMessage ?? "" });
			}
		} else if (m.role === "assistant") {
			const calls = toolCalls(m).length;
			if (!calls) {
				flush();
				items.push({ kind: "reply", m });
				continue;
			}
			work ??= { steps: 0, failed: [], said: "" };
			work.steps += calls;
			if (text(m.content).trim()) work.said = text(m.content).trim();
			if (m.stopReason === "error" || m.stopReason === "aborted") work.failed.push(m);
		} else if (m.role === "compactionSummary") {
			flush();
			items.push({ kind: "compacted" });
		}
	}
	// Work at the very end is still open: the agent may be going on with it (shown as "working now" while it runs).
	const open: { steps: number; said: string } | null = work;
	if (open && (work as { failed: ChatMessage[] }).failed.length) {
		flush();
		return { items, open: null };
	}
	return { items, open };
}

/**
 * The chat: the person's messages and the agent's replies. `working`: the agent is running, so its current work
 * shows in a panel at the end (what it last said, the tools running now); once done, that work is one folded line.
 */
export function Chat({ transcript, working, onShowTranscript, assets }: { transcript: Transcript; working: boolean; onShowTranscript: () => void; assets?: SessionAssets }) {
	const links = useLinks(assets);
	const hover = useChipPreview();
	// Turn n is what follows the person's nth message; its cards go at its end (before their next message).
	let turn = 0;
	const strip = (n: number, key: React.Key) => <AssetStrip key={key} cards={assets?.turns[n]} />;
	const { items, open } = useMemo(() => conversation(transcript.messages, !!transcript.retrying), [transcript.messages, transcript.retrying]);
	const streaming = transcript.streaming;
	const streamingCalls = streaming ? toolCalls(streaming) : [];
	// A streaming message with no tool call yet is (so far) a reply being written; with one, it's work.
	const streamingReply = streaming && !streamingCalls.length && text(streaming.content).trim() ? streaming : null;
	const thinking = !!streaming && !streamingReply && !streamingCalls.length;
	const running = Object.entries(transcript.runningTools);
	const steps = (open?.steps ?? 0) + streamingCalls.length;
	const said = (streaming && streamingCalls.length && text(streaming.content).trim()) || open?.said || "";
	const live = working || !!streaming || running.length > 0;
	const workLine = (n: number, key: React.Key) => (
		<button key={key} className="work-line" onClick={onShowTranscript} title="The agent's work here: its thinking and tool calls. Click for the full transcript." data-testid="work-line">
			▸ Worked through {n} step{n === 1 ? "" : "s"}
		</button>
	);
	return (
		<Following version={[transcript.messages.length, streaming, running.length, live]} own={userCount(transcript.messages)} testId="chat">
			<div className="chat-links" onMouseOver={hover.onMouseOver} onMouseLeave={hover.onMouseLeave}>
			{items.map((it, i) => {
				if (it.kind === "user") {
					turn++;
					return (
						<div key={i} className="col chat-turn">
							{strip(turn - 1, "assets")}
							<UserMessage m={it.m} brief />
						</div>
					);
				}
				if (it.kind === "reply") return <Reply key={i} m={it.m} links={links} />;
				if (it.kind === "retried") {
					return (
						<div key={i} className="msg-note" title={it.error} data-testid="retried-tries">
							↻ Tried again {it.count === 1 ? "once" : `${it.count} times`}: {describeModelError(it.error).title.replace(/^The /, "the ")}
						</div>
					);
				}
				if (it.kind === "compacted") return <div key={i} className="chat-divider">Earlier conversation summarised to free up context</div>;
				return (
					<div key={i} className="col" style={{ gap: 4 }}>
						{workLine(it.steps, "w")}
						{it.failed.map((m, j) => (
							<Ending key={j} m={m} />
						))}
					</div>
				);
			})}
			{open && !live && workLine(open.steps, "open")}
			{streamingReply && <Reply m={streamingReply} links={links} />}
			{strip(turn, "assets-now")}
			</div>
			{hover.preview}
			{live && !streamingReply && (
				<div className="working-now" data-testid="working-now">
					<div className="row">
						<span className="dot working-dot" />
						<b>{transcript.retrying ? "Waiting to try again…" : transcript.compacting ? "Summarising the conversation…" : running.some(([, name]) => name === "ask_user") ? "Waiting for your answer (below)" : thinking ? "Thinking…" : "Working…"}</b>
						{steps > 0 && (
							<button className="link muted small" onClick={onShowTranscript}>
								{steps} step{steps === 1 ? "" : "s"} so far
							</button>
						)}
					</div>
					{transcript.retrying && <Retrying retrying={transcript.retrying} />}
					{said && <div className="working-said">{said.length > 400 ? `…${said.slice(-400)}` : said}</div>}
					{running.map(([id, name]) => {
						const call = [...streamingCalls, ...transcript.messages.slice(-4).flatMap(toolCalls)].find((c) => c.id === id);
						return (
							<code key={id} className="working-tool ellipsis">
								⏳ {call ? toolSummary(call.name, call.arguments ?? {}) : name}
							</code>
						);
					})}
				</div>
			)}
			{!live && transcript.compacting && <div className="chat-divider">Summarising the conversation…</div>}
		</Following>
	);
}

/** Everything in the session: thinking, tool calls and their output, as it happened. */
export function FullTranscript({ transcript, assets }: { transcript: Transcript; assets?: SessionAssets }) {
	const links = useLinks(assets);
	const results = useMemo(() => new Map(transcript.messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId!, m])), [transcript.messages]);
	const shown = transcript.streaming ? [...transcript.messages, transcript.streaming] : transcript.messages;
	return (
		<Following version={[shown.length, transcript.streaming, Object.keys(transcript.runningTools).length]} own={userCount(transcript.messages)} testId="transcript">
			{shown.map((m, i) => {
				if (m.role === "user") return <UserMessage key={i} m={m} />;
				if (m.role === "assistant") return <Assistant key={i} m={m} results={results} running={transcript.runningTools} links={links} />;
				if (m.role === "compactionSummary") return <div key={i} className="chat-divider">Earlier conversation summarised to free up context</div>;
				return null;
			})}
			{Object.keys(transcript.runningTools).length > 0 && <div className="muted">Running {Object.values(transcript.runningTools).join(", ")}…</div>}
		</Following>
	);
}
