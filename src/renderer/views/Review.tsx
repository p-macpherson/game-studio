// Reviewing a worktree in one pass: what it changed as cards you can look at and listen to, main's version beside
// the worktree's; a verdict per card (fine, or needs work with a note); and one button that sends every note back to
// the sessions that made those things. Code and other files are read as a diff (WorktreeChanges), a click away.
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type ReviewChecks, type ReviewItem, type StyleCheck, type StyleNote, styleSubjects, type ReviewPreview, type Verdict, type WorktreeReview, checksLine, reviewMessages } from "../../shared/review";
import { findAgentType } from "../../shared/agents";
import { call, onEvent, studioFile } from "../api";
import { useStudio } from "../store";

const CHANGE = { added: "New", modified: "Changed", deleted: "Removed" } as const;
const stills = (paths: string[]) => paths.filter((p) => !p.endsWith(".webm"));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const key = (worktreeId: string) => `review:${worktreeId}`;
function loadVerdicts(worktreeId: string): Record<string, Verdict> {
	try {
		return JSON.parse(localStorage.getItem(key(worktreeId)) ?? "{}") as Record<string, Verdict>;
	} catch {
		return {};
	}
}

/** One side of a comparison: the asset as main has it, or as the worktree does. */
function Side({ label, preview, checkout, version, icon, absent, other }: { label: string; preview?: ReviewPreview; checkout: string; version?: string; icon: string; absent?: string; other?: { src: string; label: string } }) {
	const src = preview ? studioFile(checkout, preview.path, version) : null;
	return (
		<div className="review-side" data-testid="review-side">
			<span className="review-side-label">{label}</span>
			{absent ? (
				<span className="review-side-none">{absent}</span>
			) : preview?.kind === "image" && src ? (
				<img
					src={src}
					alt=""
					loading="lazy"
					title="Click to enlarge"
					onClick={() => useStudio.getState().showImages([...(other ? [other] : []), { src, label: `${label}: ${preview.path}` }], other ? 1 : 0)}
				/>
			) : preview?.kind === "audio" && src ? (
				<audio controls preload="none" src={src} />
			) : (
				<span className="review-side-none">{icon} no preview: open it in its section</span>
			)}
		</div>
	);
}

function Card({ item, worktreeId, version, verdict, maker, style, onVerdict }: { item: ReviewItem; worktreeId: string; version?: string; verdict?: Verdict; maker?: string; style?: StyleNote; onVerdict(v: Verdict | undefined): void }) {
	const before = item.before?.kind === "image" ? { src: studioFile("main", item.before.path), label: `In main: ${item.before.path}` } : undefined;
	return (
		<div className={`review-card ${verdict ? `verdict-${verdict.verdict}` : ""}`} data-testid="review-card" data-path={item.path}>
			<div className="row review-card-head">
				<span className={`change-label change-${item.change}`}>{CHANGE[item.change]}</span>
				<b className="grow ellipsis" title={item.path}>
					{item.name}
				</b>
				{item.change !== "deleted" && (
					<button className="link small" onClick={() => useStudio.getState().showAsset({ path: item.path, checkout: worktreeId })} title={`Open it in ${item.module.name}, in this worktree`}>
						Open ›
					</button>
				)}
			</div>
			{item.preview || item.before ? (
				<div className="review-compare">
					{item.change !== "added" && <Side label="In main" preview={item.before} checkout="main" icon={item.module.icon} />}
					<Side label="This worktree" preview={item.preview} checkout={worktreeId} version={version} icon={item.module.icon} absent={item.change === "deleted" ? "Removed" : undefined} other={before} />
				</div>
			) : (
				// Nothing to look at or hear (a doc, a scene, a shader): its words, and its lines a click away.
				<button className="review-text" onClick={() => useStudio.getState().openChanges(worktreeId, item.path)} title="Read what changed in it, line by line">
					<span className="review-excerpt">{item.excerpt || `${item.module.icon} ${item.path}`}</span>
					<span className="link small">Read its changes ›</span>
				</button>
			)}
			<span className="muted small" title={item.files.map((f) => `${CHANGE[f.change]}: ${f.path}`).join("\n")}>
				{plural(item.files.length, "file")}
				{maker ? ` · by “${maker}”` : ""}
			</span>
			{style && (
				<div className={`small review-style style-${style.verdict}`} data-testid="review-style-note">
					<b>{style.verdict === "fits" ? "✓" : style.verdict === "drifts" ? "⚠" : "?"} Style Reviewer: {STYLE[style.verdict]}.</b> {style.reason}
					{style.verdict === "drifts" && !verdict && (
						<button className="link small" onClick={() => onVerdict({ verdict: "redo", note: `Doesn't fit the art style: ${style.reason}` })}>
							Use as my note
						</button>
					)}
				</div>
			)}
			<div className="row review-verdict">
				<button className={`small ${verdict?.verdict === "fine" ? "picked" : ""}`} onClick={() => onVerdict(verdict?.verdict === "fine" ? undefined : { verdict: "fine" })} data-testid="review-fine">
					✓ Fine
				</button>
				<button className={`small ${verdict?.verdict === "redo" ? "picked" : ""}`} onClick={() => onVerdict(verdict?.verdict === "redo" ? undefined : { verdict: "redo", note: verdict?.note })} data-testid="review-redo">
					✎ Needs work
				</button>
			</div>
			{verdict?.verdict === "redo" && (
				<textarea autoFocus rows={2} placeholder="What should change? (goes to the agent that made it)" value={verdict.note ?? ""} onChange={(e) => onVerdict({ verdict: "redo", note: e.target.value })} data-testid="review-note" />
			)}
		</div>
	);
}

/** The studio's own checks of the worktree: whether it builds and its tests pass, with what failed. */
export function useChecks(worktreeId: string, enabled: boolean): ReviewChecks | null {
	const [checks, setChecks] = useState<ReviewChecks | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const load = () => call("worktrees.checks", worktreeId).then((c) => live && setChecks(c), () => {});
		load();
		const off = onEvent((e) => e.type === "review_checks" && e.worktreeId === worktreeId && load());
		return () => {
			live = false;
			off();
		};
	}, [worktreeId, enabled]);
	return checks;
}

const STYLE = { fits: "fits the art style", drifts: "may not fit the art style", unsure: "style: couldn't tell" } as const;

function useStyle(worktreeId: string, enabled: boolean): StyleCheck | null {
	const [style, setStyle] = useState<StyleCheck | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		const load = () => call("worktrees.style", worktreeId).then((c) => live && setStyle(c), () => {});
		load();
		const off = onEvent((e) => e.type === "review_checks" && e.worktreeId === worktreeId && load());
		return () => {
			live = false;
			off();
		};
	}, [worktreeId, enabled]);
	return style;
}

/** The style check: a model's opinion of the new art against the Art Style doc. Costs a model call, so it's asked for. */
function Style({ worktreeId, style, subjects }: { worktreeId: string; style: StyleCheck | null; subjects: number }) {
	const notes = Object.values(style?.notes ?? {});
	const n = (v: StyleNote["verdict"]) => notes.filter((x) => x.verdict === v).length;
	const drifts = n("drifts");
	return (
		<div className={`review-checks ${style?.state === "done" ? (drifts ? "hint" : "passed") : style?.state === "failed" ? "failed" : ""}`} data-testid="review-style">
			<div className="row">
				<b>
					{!style
						? `Style check: have the Style Reviewer look at the ${plural(subjects, "picture")} beside the Art Style doc`
						: style.state === "running"
							? "⏳ The Style Reviewer is looking…"
							: style.state === "failed"
								? "✗ The style check didn't finish"
								: `Style (a hint): ${[n("fits") && `${n("fits")} fit`, drifts && `${drifts} may not`, n("unsure") && `${n("unsure")} unclear`].filter(Boolean).join(" · ")}`}
				</b>
				<span className="grow" />
				{style?.sessionId && (
					<button className="link small" onClick={() => useStudio.getState().selectSession(style.sessionId!)}>
						Its reasoning ›
					</button>
				)}
				<button className="small" disabled={style?.state === "running"} onClick={() => call("worktrees.checkStyle", worktreeId).catch(useStudio.getState().showError)} title="Starts a Style Reviewer session in this worktree (a model call). Its opinion is a hint on each card, never a gate." data-testid="review-check-style">
					{style ? "Check again" : "Check the style"}
				</button>
			</div>
			{style?.error && <div className="small">{style.error}</div>}
		</div>
	);
}

function Checks({ worktreeId, checks }: { worktreeId: string; checks: ReviewChecks | null }) {
	const line = checks ? checksLine(checks) : null;
	const failed = checks?.tests.filter((t) => !t.ok) ?? [];
	return (
		<div className={`review-checks ${line?.ok === false ? "failed" : line?.ok ? "passed" : ""}`} data-testid="review-checks">
			<div className="row">
				<b>{line ? `${line.ok === false ? "✗" : line.ok ? "✓" : "⏳"} ${line.text}` : "Not checked yet: does it build, do its tests pass?"}</b>
				{checks?.state === "done" && (
					<span className="muted small" title={`Checked at commit ${checks.commit.slice(0, 7)}`}>
						checked {new Date(checks.finishedAt ?? checks.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
					</span>
				)}
				<span className="grow" />
				<button className="small" disabled={checks?.state === "running"} onClick={() => void call("worktrees.runChecks", worktreeId)} data-testid="review-run-checks">
					{checks ? "Check again" : "Check now"}
				</button>
			</div>
			{checks?.build && !checks.build.ok && <pre className="review-check-output">{checks.build.errors.join("\n")}</pre>}
			{failed.map((t) => (
				<div key={t.script} className="small">
					<code>{t.script}</code>: {t.problem}
				</div>
			))}
		</div>
	);
}

export function Review({ worktreeId }: { worktreeId: string }) {
	const { worktree, sessions, agentTypes, assetsVersion, openReview, showError } = useStudio(
		useShallow((s) => ({
			worktree: s.worktrees.find((w) => w.id === worktreeId),
			sessions: s.sessions,
			agentTypes: s.agentTypes,
			assetsVersion: s.assetsVersion,
			openReview: s.openReview,
			showError: s.showError,
		})),
	);
	const [review, setReview] = useState<WorktreeReview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [verdicts, setVerdicts] = useState<Record<string, Verdict>>(() => loadVerdicts(worktreeId));
	const [general, setGeneral] = useState("");
	const [sending, setSending] = useState(false);
	const mine = sessions.filter((s) => s.worktreeId === worktreeId);
	// Reload when the worktree changes, and when one of its sessions asks for review or stops asking.
	const asking = mine.map((s) => `${s.id}:${s.reviewRequested ? s.reviewRequestedAt : ""}`).join(",");
	useEffect(() => {
		let live = true;
		call("worktrees.review", worktreeId).then(
			(r) => live && (setReview(r), setError(null)),
			(e) => live && setError((e as Error).message),
		);
		return () => {
			live = false;
		};
	}, [worktreeId, worktree?.updatedAt, assetsVersion, asking]);
	const setVerdict = (path: string, v: Verdict | undefined) =>
		setVerdicts((all) => {
			const next = { ...all };
			if (v) next[path] = v;
			else delete next[path];
			localStorage.setItem(key(worktreeId), JSON.stringify(next));
			return next;
		});

	const items = review?.items ?? [];
	const groups = useMemo(() => {
		const out: { id: string; name: string; icon: string; items: ReviewItem[] }[] = [];
		for (const i of items) {
			const g = out.find((x) => x.id === i.module.id);
			if (g) g.items.push(i);
			else out.push({ ...i.module, items: [i] });
		}
		return out;
	}, [items]);
	const count = (v: Verdict["verdict"]) => items.filter((i) => verdicts[i.path]?.verdict === v).length;
	const fine = count("fine");
	const redo = count("redo");
	const working = mine.some((s) => s.status === "in_progress" || s.status === "starting");
	const messages = review ? reviewMessages(items, verdicts, review.fallbackSession, general) : [];
	const title = (id: string | undefined) => sessions.find((s) => s.id === id)?.title;
	const game = worktree?.target === "project";
	const checks = useChecks(worktreeId, game);
	const style = useStyle(worktreeId, game);
	const pictures = styleSubjects(items).length;
	const send = async () => {
		setSending(true);
		try {
			for (const m of messages) await call("sessions.send", m.sessionId, m.text);
			// What was sent is with the agents now; what was fine stays ticked for the next look.
			setVerdicts((all) => {
				const next = Object.fromEntries(Object.entries(all).filter(([, v]) => v.verdict === "fine"));
				localStorage.setItem(key(worktreeId), JSON.stringify(next));
				return next;
			});
			setGeneral("");
			useStudio.getState().notify(`Sent your notes to ${plural(messages.length, "session")}`);
			await useStudio.getState().refreshSessions();
		} catch (err) {
			showError(err);
		} finally {
			setSending(false);
		}
	};
	const play = () => {
		useStudio.getState().selectWorktree(worktreeId);
		useStudio.getState().setView("play");
	};
	/** Play & Test, with the game brought to the moment the agent set up. */
	const playFrom = (script: string) => {
		play();
		// A scenario: Play & Test starts it with its saved (or default) values, and shows its parameters.
		if (script.endsWith(".json")) {
			useStudio.getState().setPlayScenario(script);
			return void useStudio.getState().startRun("hidden");
		}
		call("run.startAt", worktreeId, script).then((r) => {
			const first = r.failed[0];
			useStudio.getState().notify(first ? `Started, but ${script} line ${first.line} failed: ${first.error}` : `Started at the moment set up by ${script}`);
		}, showError);
	};

	return (
		<div className="review" data-testid="review">
			<div className="changes-head">
				<button onClick={() => openReview(null)} data-testid="review-back">
					← Worktrees
				</button>
				<div className="col grow" style={{ gap: 2, minWidth: 0 }}>
					<h2 className="ellipsis">Review “{worktree?.label ?? worktreeId}”</h2>
					<span className="muted small" data-testid="review-summary">
						{review === null ? "Loading…" : items.length + review.code.length === 0 ? "Nothing changed against main." : [items.length ? `${plural(items.length, "thing")} to look at` : "", review.code.length ? `${plural(review.code.length, "file")} of code and other changes` : ""].filter(Boolean).join(" · ")}
					</span>
				</div>
				{worktree?.target === "project" && (
					<button onClick={play} title="Switch to this worktree and open Play & Test, to build and play what it changed" data-testid="review-play">
						▶ Play this worktree
					</button>
				)}
				<button disabled={!review?.code.length && !items.length} onClick={() => useStudio.getState().openChanges(worktreeId)} title="Every changed file, line by line" data-testid="review-code">
					Read the changes{review?.code.length ? ` (${review.code.length} code)` : ""}
				</button>
				{worktree?.status === "active" && (
					<button className="primary" onClick={() => useStudio.getState().openMerge(worktreeId)}>
						Merge…
					</button>
				)}
			</div>
			{error && <div className="msg error" style={{ margin: 16 }}>Could not load the review: {error}</div>}
			<div className="review-body">
				{game && review && items.length + review.code.length > 0 && <Checks worktreeId={worktreeId} checks={checks} />}
				{game && pictures > 0 && <Style worktreeId={worktreeId} style={style} subjects={pictures} />}
				{review?.requests.map((r) => (
					<div key={r.sessionId} className="review-request" data-testid="review-request">
						<div className="row">
							<span className="badge badge-green">Ready for review</span>
							<b className="grow ellipsis">
								{findAgentType(agentTypes, r.agentType)?.name ?? r.agentType}: {r.title}
							</b>
							{r.startHere && game && (
								<button className="small primary" onClick={() => playFrom(r.startHere!)} title={`Build and start this worktree's game, then run ${r.startHere} to bring it to the moment to look at. You play on from there.`} data-testid="review-play-from">
									▶ Play from here
								</button>
							)}
							<button className="link small" onClick={() => useStudio.getState().selectSession(r.sessionId)}>
								Open the session ›
							</button>
						</div>
						{r.summary && <div className="review-request-summary">{r.summary}</div>}
						{r.lookAt.length > 0 && (
							<ul className="review-look-at" data-testid="review-look-at">
								{r.lookAt.map((line, i) => (
									<li key={i}>{line}</li>
								))}
							</ul>
						)}
						{r.images.length > 0 && (
							<div className="review-evidence" data-testid="review-evidence">
								{r.images.map((p) =>
									p.endsWith(".webm") ? (
										<video key={p} src={studioFile(worktreeId, p, r.at)} title={p} controls loop muted playsInline preload="metadata" data-testid="review-clip" />
									) : (
										<img key={p} src={studioFile(worktreeId, p, r.at)} alt="" title={p} loading="lazy" onClick={() => useStudio.getState().showImages(stills(r.images).map((x) => ({ src: studioFile(worktreeId, x, r.at), label: x })), stills(r.images).indexOf(p))} />
									),
								)}
							</div>
						)}
					</div>
				))}
				{groups.map((g) => (
					<div key={g.id} className="col" style={{ gap: 8 }}>
						<h3>
							{g.icon} {g.name} <span className="muted">{g.items.length}</span>
						</h3>
						<div className="review-cards">
							{g.items.map((i) => (
								<Card key={i.path} item={i} worktreeId={worktreeId} version={worktree?.updatedAt} verdict={verdicts[i.path]} maker={title(i.sessionId)} style={style?.notes[i.path]} onVerdict={(v) => setVerdict(i.path, v)} />
							))}
						</div>
					</div>
				))}
				{review && !items.length && review.code.length > 0 && <div className="empty">This worktree changed only code and other files: read them with “Read the changes”{worktree?.target === "project" ? ", or play it" : ""}.</div>}
			</div>
			{review && (items.length > 0 || review.fallbackSession) && (
				<div className="review-foot" data-testid="review-foot">
					<span className="muted small" data-testid="review-tally">
						{items.length > 0 ? `${fine} fine · ${redo} need work · ${items.length - fine - redo} not looked at` : ""}
					</span>
					<input className="grow" placeholder={review.fallbackSession ? `A note on the whole thing (to “${title(review.fallbackSession) ?? "the session"}”)` : "No session in this worktree to send notes to"} disabled={!review.fallbackSession} value={general} onChange={(e) => setGeneral(e.target.value)} data-testid="review-general" />
					<button
						className="primary"
						disabled={sending || !messages.length}
						onClick={send}
						title={messages.length ? `Sends one message to ${messages.map((m) => `“${title(m.sessionId) ?? m.sessionId}”`).join(", ")}${working ? ". An agent is working: it gets the message when it finishes its current step" : ""}` : "Mark something as needing work, or write a note, first"}
						data-testid="review-send"
					>
						{sending ? "Sending…" : `Send notes to the agents${redo ? ` (${redo})` : ""}`}
					</button>
				</div>
			)}
		</div>
	);
}
