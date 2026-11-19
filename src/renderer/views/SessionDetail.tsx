import { useEffect, useState } from "react";
import type { PromptMode } from "../../shared/host";
import type { SessionSummary } from "../../shared/types";
import { call } from "../api";
import { useStudio } from "../store";
import { Chat } from "./Chat";
import { Diff } from "./Diff";
import { StatusBadge, TargetBadge } from "./Sessions";

type Tab = "chat" | "changes" | "raw";

export function SessionDetail({ session: s }: { session: SessionSummary }) {
	const { transcripts, agentTypes, models, showError, loadTranscript, openPlay } = useStudio();
	const transcript = transcripts[s.id];
	const [tab, setTab] = useState<Tab>("chat");
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [diff, setDiff] = useState<string | null>(null);
	const [raw, setRaw] = useState("");
	const running = s.status === "in_progress" || s.status === "starting";

	useEffect(() => {
		if (!transcript) void loadTranscript(s.id);
	}, [s.id, transcript, loadTranscript]);

	useEffect(() => {
		if (tab === "changes") call("sessions.diff", s.id).then(setDiff, (e) => setDiff(`Could not load the diff: ${(e as Error).message}`));
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

	const send = (mode?: PromptMode) => {
		const text = draft.trim();
		if (!text) return;
		setDraft("");
		void act(() => call("sessions.send", s.id, text, mode));
	};

	const typeName = agentTypes.find((t) => t.id === s.agentType)?.name ?? s.agentType;
	const hasWorktree = s.worktree === "active";

	return (
		<div className="session-detail">
			<div className="session-header">
				<div className="row">
					<h2 className="grow ellipsis" title={s.title}>
						{s.title}
					</h2>
					{hasWorktree && s.target !== "studio" && (
						<button title="Build and run the game with this session's changes" onClick={() => openPlay({ checkout: s.id, tab: "run" })}>
							▶ Play &amp; Test
						</button>
					)}
					{running && (
						<button disabled={busy} onClick={() => act(() => call("sessions.abort", s.id))}>
							■ Stop
						</button>
					)}
					{!running && s.status !== "done" && (
						<>
							{hasWorktree && (
								<button
									className="primary"
									disabled={busy}
									onClick={() => act(() => call("sessions.merge", s.id), `Merge ${s.branch} into ${s.baseBranch}?`)}
								>
									Merge
								</button>
							)}
							<button disabled={busy} onClick={() => act(() => call("sessions.markDone", s.id))}>
								Mark done
							</button>
							<button
								className="danger"
								disabled={busy}
								onClick={() => act(() => call("sessions.discard", s.id), "Discard this session? Its worktree is removed; the branch is kept so it can be resumed.")}
							>
								Discard
							</button>
						</>
					)}
					{s.status === "done" && (
						<button className="primary" disabled={busy} onClick={() => act(() => call("sessions.resume", s.id))}>
							Resume
						</button>
					)}
				</div>
				<div className="row" style={{ flexWrap: "wrap" }}>
					<StatusBadge s={s} />
					<TargetBadge target={s.target} />
					<span className="badge">{typeName}</span>
					{s.reviewRequested && <span className="badge review">Ready for review</span>}
					<code className="muted">{s.branch}</code>
					<span className="grow" />
					<select
						value={s.model}
						disabled={running}
						onChange={(e) => act(() => call("sessions.setModel", s.id, e.target.value))}
						title="Model"
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
			</div>
			<div className="tabs">
				{(["chat", "changes", "raw"] as const).map((t) => (
					<button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
						{t === "chat" ? "Chat" : t === "changes" ? "Changes" : "Raw (Pi)"}
					</button>
				))}
			</div>
			<div className="tab-body">
				{tab === "chat" && transcript && <Chat transcript={transcript} />}
				{tab === "changes" && (diff === null ? <div className="empty">Loading…</div> : <Diff text={diff} />)}
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
				<div className="composer">
					<div className="question">
						<strong>{s.pendingQuestion.question}</strong>
						{s.pendingQuestion.options && (
							<div className="row" style={{ flexWrap: "wrap" }}>
								{s.pendingQuestion.options.map((o) => (
									<button key={o} onClick={() => act(() => call("sessions.answer", s.id, s.pendingQuestion!.questionId, o))}>
										{o}
									</button>
								))}
							</div>
						)}
						<div className="row">
							<input className="grow" placeholder="Or type an answer…" value={draft} onChange={(e) => setDraft(e.target.value)} />
							<button
								className="primary"
								disabled={!draft.trim()}
								onClick={() => {
									const answer = draft.trim();
									setDraft("");
									void act(() => call("sessions.answer", s.id, s.pendingQuestion!.questionId, answer));
								}}
							>
								Answer
							</button>
						</div>
					</div>
				</div>
			)}
			{tab === "chat" && !s.pendingQuestion && (
				<div className="composer">
					<textarea
						data-testid="composer"
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
							Enter to send · Shift+Enter for a new line
						</span>
						{running && (
							<button disabled={!draft.trim()} onClick={() => send("steer")} title="Deliver after the current tool call">
								Steer
							</button>
						)}
						<button className="primary" disabled={!draft.trim()} onClick={() => send()}>
							{running ? "Queue" : "Send"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
