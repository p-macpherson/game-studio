import { PASTE_HINT, usePastedImages } from "./PastedImages";
import { useEffect, useRef, useState } from "react";
import type { PromptMode } from "../../shared/host";
import type { ContextUsage, SessionSummary } from "../../shared/types";
import { findAgentType } from "../../shared/agents";
import { call, relativeTime, studioFile } from "../api";
import { useStudio } from "../store";
import { Chat, FullTranscript } from "./Chat";
import { Markdown } from "./Markdown";
import { loadDraft, saveDraft } from "../drafts";
import { StatusBadge, TargetBadge } from "./Sessions";
import { useShallow } from "zustand/react/shallow";

type Tab = "chat" | "transcript" | "subagents" | "raw";
const TAB_LABEL: Record<Tab, string> = { chat: "Chat", transcript: "Full transcript", subagents: "Sub-agents", raw: "Raw (Pi)" };

/** How a sub-agent stands, in a word, and the row's colour for it. */
function standing(c: SessionSummary): { label: string; tone: "working" | "waiting" | "failed" | "done" } {
	if (c.status === "in_progress" || c.status === "starting") return { label: c.pendingQuestion ? "Asking you" : "Working", tone: c.pendingQuestion ? "waiting" : "working" };
	if (c.error) return { label: "Failed", tone: "failed" };
	if (c.status === "interrupted") return { label: "Interrupted", tone: "failed" };
	if (c.status === "done") return { label: c.outcome ? `Done · ${c.outcome}` : "Done", tone: "done" };
	return { label: c.pendingQuestion ? "Asking you" : "Idle", tone: "waiting" };
}

/**
 * The agent's question to the person (ask_user): the options are suggestions to pick from; picking one puts it in the
 * answer box, where it can be reworded, and what's in the box is what "Send answer" sends. The answer being written
 * is kept like any unsent message.
 */
function QuestionCard({ sessionId, question, busy, onAnswer }: { sessionId: string; question: NonNullable<SessionSummary["pendingQuestion"]>; busy: boolean; onAnswer: (answer: string) => void }) {
	const draftKey = `${sessionId}:answer:${question.questionId}`;
	const [answer, setAnswerText] = useState(() => loadDraft(draftKey));
	const setAnswer = (text: string) => {
		setAnswerText(text);
		saveDraft(draftKey, text);
	};
	const box = useRef<HTMLTextAreaElement>(null);
	const options = question.options ?? [];
	const send = () => {
		const text = answer.trim();
		if (!text || busy) return;
		saveDraft(draftKey, "");
		onAnswer(text);
	};
	return (
		<div className="composer">
			<div className="question" data-testid="question">
				<div className="question-label">
					<span className="dot" />
					The agent is waiting for your answer
				</div>
				<Markdown className="question-text" text={question.question} />
				{!!question.images?.length && (
					<div className="question-images" data-testid="question-images">
						{question.images.map((p, i) => (
							<button
								key={p}
								className="question-image"
								title={`${p} (click to enlarge)`}
								onClick={() => useStudio.getState().showImages(question.images!.map((x) => ({ src: studioFile(sessionId, x), label: x })), i)}
							>
								<img src={studioFile(sessionId, p)} alt={p} />
								<span className="small ellipsis">{p.split("/").pop()}</span>
							</button>
						))}
					</div>
				)}
				{options.length > 0 && (
					<div className="question-options" role="radiogroup" aria-label="Suggested answers">
						{options.map((o, i) => {
							const picked = answer.trim() === o.trim();
							return (
								<button
									key={i}
									role="radio"
									aria-checked={picked}
									className={`question-option ${picked ? "picked" : ""}`}
									onClick={() => {
										setAnswer(o);
										box.current?.focus();
									}}
									data-testid="question-option"
								>
									<span className="question-radio" />
									<span className="grow">{o}</span>
								</button>
							);
						})}
					</div>
				)}
				<textarea
					ref={box}
					rows={2}
					placeholder={options.length ? "Pick a suggestion above (you can then reword it), or write your own answer…" : "Write your answer…"}
					value={answer}
					onChange={(e) => setAnswer(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
					data-testid="question-answer"
				/>
				<div className="row">
					<span className="muted grow" style={{ fontSize: 12 }}>
						{options.length > 0 && answer.trim() && !options.some((o) => o.trim() === answer.trim()) ? "Your own wording · " : ""}
						Enter to send · Shift+Enter for a new line
					</span>
					{answer && (
						<button className="ghost" onClick={() => setAnswer("")}>
							Clear
						</button>
					)}
					<button className="primary" disabled={busy || !answer.trim()} onClick={send} data-testid="question-send">
						Send answer
					</button>
				</div>
			</div>
		</div>
	);
}

/** The Sub-agents tab: the tree of sessions below this one, each with how it stands; Done ones can be hidden. */
function SubAgents({ root, sessions, typeName, onOpen }: { root: SessionSummary; sessions: SessionSummary[]; typeName: (id: string) => string; onOpen: (id: string) => void }) {
	const [showDone, setShowDone] = useState(() => localStorage.getItem("subagents-show-done") !== "0");
	const toggleDone = () => {
		localStorage.setItem("subagents-show-done", showDone ? "0" : "1");
		setShowDone(!showDone);
	};
	const kids = (id: string) => sessions.filter((x) => x.parentId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const all: SessionSummary[] = [];
	const walk = (id: string) => kids(id).forEach((c) => (all.push(c), walk(c.id)));
	walk(root.id);
	const count = (tone: string) => all.filter((c) => standing(c).tone === tone).length;
	// With Done hidden, a done sub-agent still shows while something below it isn't done.
	const visible = (c: SessionSummary): boolean => showDone || c.status !== "done" || kids(c.id).some(visible);
	const hidden = all.filter((c) => !visible(c)).length;
	const row = (c: SessionSummary, depth: number): React.ReactNode => {
		if (!visible(c)) return null;
		const st = standing(c);
		return (
			<div key={c.id}>
				<button className={`subagent-row tone-${st.tone}`} style={{ paddingLeft: 12 + depth * 22 }} onClick={() => onOpen(c.id)} title="Open this sub-agent's session" data-testid="subagent-row" data-status={c.status}>
					<span className="subagent-status">
						<span className="dot" />
						{st.label}
					</span>
					<span className="col grow" style={{ gap: 2, minWidth: 0 }}>
						<span className="subagent-title ellipsis">{c.title}</span>
						<span className="muted small ellipsis">
							{typeName(c.agentType)} · {relativeTime(c.updatedAt)}
							{c.error ? ` · ${c.error}` : ""}
						</span>
					</span>
					{c.reviewRequested && <span className="badge badge-green">Ready for review</span>}
				</button>
				{kids(c.id).map((k) => row(k, depth + 1))}
			</div>
		);
	};
	return (
		<div className="subagents" data-testid="subagents">
			<div className="row subagents-head">
				<span className="grow subagents-summary" data-testid="subagents-summary">
					{count("working") > 0 && <span className="tone-working">{count("working")} working</span>}
					{count("waiting") > 0 && <span className="tone-waiting">{count("waiting")} idle</span>}
					{count("failed") > 0 && <span className="tone-failed">{count("failed")} failed</span>}
					<span className="tone-done">{count("done")} done</span>
				</span>
				<label className="row small" style={{ gap: 6 }}>
					<input type="checkbox" checked={showDone} onChange={toggleDone} data-testid="subagents-show-done" />
					Show done
				</label>
			</div>
			{kids(root.id).map((c) => row(c, 0))}
			{hidden > 0 && <div className="muted small subagents-hidden-note">{hidden} done sub-agent{hidden === 1 ? "" : "s"} hidden</div>}
		</div>
	);
}

export function SessionDetail({ session: s }: { session: SessionSummary }) {
	const { agentTypes, models, showError, loadTranscript, sessions, selectWorktree, selectSession } = useStudio(
		useShallow((st) => ({
			agentTypes: st.agentTypes,
			models: st.models,
			showError: st.showError,
			loadTranscript: st.loadTranscript,
			sessions: st.sessions,
			selectWorktree: st.selectWorktree,
			selectSession: st.selectSession,
		})),
	);
	// Only this session's transcript: other sessions streaming must not redraw this page.
	const transcript = useStudio((st) => st.transcripts[s.id]);
	const [tab, setTab] = useState<Tab>("chat");
	// The unsent message: kept per session, so it's still there after a visit to another session or section.
	const [draft, setDraftText] = useState(() => loadDraft(s.id));
	const setDraft = (text: string) => {
		setDraftText(text);
		saveDraft(s.id, text);
	};
	// How full the agent's context window is (known while its agent is loaded), refreshed as the conversation moves.
	const [context, setContext] = useState<ContextUsage | null>(null);
	const [busy, setBusy] = useState(false);
	const [raw, setRaw] = useState("");
	const running = s.status === "in_progress" || s.status === "starting";
	const parent = sessions.find((x) => x.id === s.parentId);
	// Everything below it in the tree (its sub-agents, and theirs), for the Sub-agents tab.
	const below: SessionSummary[] = [];
	const collect = (id: string) => {
		for (const c of sessions.filter((x) => x.parentId === id)) {
			below.push(c);
			collect(c.id);
		}
	};
	collect(s.id);
	const belowWorking = below.filter((x) => x.status === "in_progress" || x.status === "starting").length;
	// Sub-agents cut off together with this session: Resume carries them on too.
	const cutOffBelow = s.status === "interrupted" ? below.filter((x) => x.status === "interrupted" && x.interruptedAt === s.interruptedAt).length : 0;

	useEffect(() => {
		if (!transcript) void loadTranscript(s.id);
	}, [s.id, transcript, loadTranscript]);

	const messageCount = transcript?.messages.length ?? 0;
	// Its asset cards and links: read again a moment after the conversation, its worktree or the assets change.
	const assets = useStudio((st) => st.sessionAssets[s.id]);
	const assetsVersion = useStudio((st) => st.assetsVersion);
	useEffect(() => {
		const t = setTimeout(() => void useStudio.getState().loadSessionAssets(s.id), 300);
		return () => clearTimeout(t);
	}, [s.id, s.status, s.worktree, messageCount, assetsVersion]);
	const compacting = !!transcript?.compacting;
	useEffect(() => {
		let live = true;
		call("sessions.context", s.id).then((c) => live && setContext(c), () => {});
		return () => {
			live = false;
		};
	}, [s.id, s.status, messageCount, compacting]);
	const compact = () =>
		act(async () => {
			await call("sessions.compact", s.id);
			await loadTranscript(s.id);
			setContext(await call("sessions.context", s.id));
			useStudio.getState().notify("Summarised the conversation: its context is freed up");
		}, "Summarise the conversation so far to free up the agent's context? It keeps a summary in place of the full history (the Raw tab still has all of it).");

	useEffect(() => {
		if (tab === "raw") call("sessions.raw", s.id).then(setRaw, showError);
	}, [tab, s.id, s.updatedAt, showError]);

	const act = async (action: () => Promise<unknown>, confirmText?: string) => {
		if (confirmText && !window.confirm(confirmText)) return;
		setBusy(true);
		try {
			await action();
		} catch (err) {
			showError(err);
		} finally {
			setBusy(false);
		}
	};

	const pasted = usePastedImages(s.id);
	const send = (mode?: PromptMode) => {
		const text = draft.trim();
		if (!text && !pasted.images.length) return;
		const images = pasted.take();
		setDraft("");
		void act(() => call("sessions.send", s.id, text, mode, images.length ? images : undefined));
	};

	const typeName = findAgentType(agentTypes, s.agentType)?.name ?? s.agentType;
	const hasWorktree = s.worktree === "active";

	return (
		<div className="session-detail">
			<div className="session-header">
				<div className="row">
					<h2 className="grow ellipsis" title={s.title}>
						{s.title}
					</h2>
					{running && (
						<button disabled={busy} onClick={() => act(() => call("sessions.abort", s.id))}>
							■ Stop
						</button>
					)}
					{!running && s.status !== "done" && (
						<button disabled={busy} onClick={() => act(() => call("sessions.markDone", s.id))} title="Close this session. Its worktree and changes stay; merge or discard those from the worktree bar">
							Mark done
						</button>
					)}
					{s.status === "interrupted" && (
						<button
							className="primary"
							disabled={busy}
							onClick={() => act(() => call("sessions.resume", s.id))}
							title={
								cutOffBelow
									? `Carry on from where it was cut off. Its ${cutOffBelow} interrupted sub-agent${cutOffBelow > 1 ? "s are" : " is"} resumed first, and it continues once they report`
									: "Carry on from where it was cut off"
							}
							data-testid="session-resume-interrupted"
						>
							▶ Resume{cutOffBelow ? ` (+${cutOffBelow} sub-agent${cutOffBelow > 1 ? "s" : ""})` : ""}
						</button>
					)}
					{s.status === "done" && (
						<button className="primary" disabled={busy} onClick={() =>
								act(async () => {
									await call("sessions.resume", s.id);
									// Its worktree is open again: show it (and the session in it), in whichever repo.
									await useStudio.getState().refreshWorktrees();
									useStudio.getState().selectWorktree(s.worktreeId);
								})
							}>
							Resume
						</button>
					)}
				</div>
				<div className="row" style={{ flexWrap: "wrap" }}>
					<StatusBadge s={s} />
					<TargetBadge target={s.target} />
					<span className="badge">{typeName}</span>
					{s.reviewRequested && (
						<button className="chip badge badge-green" onClick={() => useStudio.getState().openReview(s.worktreeId)} title="Review what its worktree changed: look, listen, and send your notes back" data-testid="session-review">
							Ready for review ›
						</button>
					)}
					{hasWorktree && (
						<button className="chip" onClick={() => useStudio.getState().openChanges(s.worktreeId)} title="Read what its worktree changed (Worktrees → View changes)" data-testid="session-changes">
							Changes ›
						</button>
					)}
					{s.target === "project" && s.worktree === "active" ? (
						<button className="chip session-worktree-chip ellipsis" title={`Show worktree “${s.worktreeLabel}” in the sections (${s.branch})`} onClick={() => selectWorktree(s.worktreeId)} data-testid="session-worktree">
							⎇ {s.worktreeLabel}
						</button>
					) : (
						<code className="muted" title={s.worktreeLabel}>
							{s.branch}
						</code>
					)}
					<span className="grow" />
					<span
						className={`context-meter ${(context?.percent ?? 0) >= 80 ? "high" : ""}`}
						title={
							context
								? context.tokens === null
									? `Context window: ${context.window.toLocaleString()} tokens; how much is used is known after the agent's next reply`
									: `${context.tokens.toLocaleString()} of ${context.window.toLocaleString()} tokens of the model's context window are in use`
								: "How full the agent's context window is: known once the agent is loaded (send it a message)"
						}
						data-testid="context-meter"
					>
						<span className="context-bar">
							<span style={{ width: `${Math.min(100, context?.percent ?? 0)}%` }} />
						</span>
						Context {context?.percent != null ? `${Math.round(context.percent)}%` : "–"}
					</span>
					<button
						className="small"
						disabled={busy || running || compacting || !s.piSessionFile}
						onClick={compact}
						title={running ? "Wait for the agent to finish" : "Summarise the conversation so far to free up context"}
						data-testid="context-compact"
					>
						{compacting ? "Compacting…" : "Compact"}
					</button>
					<select
						value={s.model}
						disabled={running}
						onChange={(e) => act(() => call("sessions.setModel", s.id, e.target.value))}
						title="Model"
						className="session-model"
					>
						{!models.some((m) => m.ref === s.model) && <option value={s.model}>{s.model} (unavailable)</option>}
						{models.map((m) => (
							<option key={m.ref} value={m.ref}>
								{m.ref}
							</option>
						))}
					</select>
				</div>
				{s.error && <div className="msg error">{s.error}</div>}
				{parent && (
					<div className="row session-family" data-testid="session-family">
						{parent && (
							<button className="chip" onClick={() => selectSession(parent.id)} title="The session that delegated this one">
								↑ Sub-agent of “{parent.title}”
							</button>
						)}
					</div>
				)}
			</div>
			<div className="tabs">
				{(["chat", "transcript", "subagents", "raw"] as const)
					.filter((t) => t !== "subagents" || below.length > 0)
					.map((t) => (
						<button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)} data-testid={`session-tab-${t}`}>
							{TAB_LABEL[t]}
							{t === "subagents" && (
								<span className={`tab-count ${belowWorking ? "working" : ""}`} title={belowWorking ? `${belowWorking} working` : "All done or idle"}>
									{belowWorking ? `${belowWorking}/${below.length}` : below.length}
								</span>
							)}
						</button>
					))}
			</div>
			<div className={`tab-body ${tab === "chat" || tab === "transcript" ? "fill" : ""}`}>
				{tab === "chat" && transcript && <Chat transcript={transcript} working={running} onShowTranscript={() => setTab("transcript")} assets={assets} />}
				{tab === "transcript" && transcript && <FullTranscript transcript={transcript} assets={assets} />}
				{tab === "subagents" && <SubAgents root={s} sessions={sessions} typeName={(id) => findAgentType(agentTypes, id)?.name ?? id} onOpen={selectSession} />}
				{tab === "raw" && (
					<div className="col" style={{ padding: 12 }}>
						<div className="row">
							<span className="muted grow">
								The underlying Pi session ({s.piSessionFile ?? "no transcript yet"}). Open it in the Pi CLI to use Pi directly.
							</span>
							<button disabled={busy || running} onClick={() => act(() => call("sessions.openTerminal", s.id))}>
								Open in terminal
							</button>
						</div>
						<pre className="diff" style={{ padding: 0 }}>
							{raw
								.split("\n")
								.filter(Boolean)
								.map((l) => JSON.stringify(JSON.parse(l), null, 1).replace(/\n\s*/g, " "))
								.join("\n")}
						</pre>
					</div>
				)}
			</div>
			{s.pendingQuestion && (
				<QuestionCard
					key={s.pendingQuestion.questionId}
					sessionId={s.id}
					question={s.pendingQuestion}
					busy={busy}
					onAnswer={(answer) => act(() => call("sessions.answer", s.id, s.pendingQuestion!.questionId, answer))}
				/>
			)}
			{(tab === "chat" || tab === "transcript") && !s.pendingQuestion && (
				<div className="composer">
					{pasted.tray}
					<textarea
						data-testid="composer"
						title={PASTE_HINT}
						{...pasted.handlers}
						placeholder={
							s.status === "done" ? "Send a message to resume this session…" : running ? "Queue a follow-up (or steer the agent)…" : "Message the agent…"
						}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<div className="row">
						<span className="muted grow" style={{ fontSize: 12 }}>
							Enter to send · Shift+Enter for a new line · paste or drop images
						</span>
						{running && (
							<button disabled={!draft.trim() && !pasted.images.length} onClick={() => send("steer")} title="Deliver after the current tool call">
								Steer
							</button>
						)}
						<button className="primary" disabled={!draft.trim() && !pasted.images.length} onClick={() => send()}>
							{running ? "Queue" : "Send"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
