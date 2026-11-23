// Play & Test: build and run the game from the main checkout or a session's worktree, play it inside the studio
// (hidden mode, frames streamed over the control protocol, input injected) or in its own window, inspect the
// world, and run the project's scripted tests.
import { type KeyboardEvent, type MouseEvent, type WheelEvent, useEffect, useRef, useState } from "react";
import { type CheckoutId, type CheckoutInfo, type Diagnostic, MAX_RUN_PLAYERS, type RunInfo, type TestReport } from "../../shared/run";
import { call } from "../api";
import { testKey, useStudio } from "../store";
import { ScenarioPicker } from "./Scenarios";
import { useShallow } from "zustand/react/shallow";

const STATE_LABEL: Record<RunInfo["state"], string> = {
	building: "Building…",
	build_failed: "Build failed",
	starting: "Starting…",
	running: "Running",
	exited: "Stopped",
};

/** Browser `KeyboardEvent.code` → raylib key name, as the engine's `key` command expects. */
export function raylibKey(code: string): string | null {
	if (/^Key[A-Z]$/.test(code)) return code.slice(3);
	if (/^Digit\d$/.test(code)) return ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"][Number(code[5])];
	if (/^F\d{1,2}$/.test(code)) return code;
	if (code.startsWith("Arrow")) return code.slice(5).toUpperCase();
	const sides: Record<string, string> = { Shift: "SHIFT", Control: "CONTROL", Alt: "ALT", Meta: "SUPER" };
	const side = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
	if (side) return `${side[2].toUpperCase()}_${sides[side[1]]}`;
	const named: Record<string, string> = {
		Space: "SPACE",
		Enter: "ENTER",
		Escape: "ESCAPE",
		Tab: "TAB",
		Backspace: "BACKSPACE",
		Minus: "MINUS",
		Equal: "EQUAL",
		Comma: "COMMA",
		Period: "PERIOD",
		Slash: "SLASH",
		Semicolon: "SEMICOLON",
		Quote: "APOSTROPHE",
		Backquote: "GRAVE",
		BracketLeft: "LEFT_BRACKET",
		BracketRight: "RIGHT_BRACKET",
		Backslash: "BACKSLASH",
	};
	return named[code] ?? null;
}

const quiet = (p: Promise<unknown>) => p.catch(() => {});

/** Indented JSON with short arrays (vectors, colours) kept on one line. */
function pretty(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`);
}

/** "Fix it": hands a problem to the newest session in the worktree it came from, or starts a gameplay session. */
function useFix() {
	const { sessions, worktrees, openNewSession, selectSession, selectWorktree, showError } = useStudio(
		useShallow((s) => ({
			sessions: s.sessions,
			worktrees: s.worktrees,
			openNewSession: s.openNewSession,
			selectSession: s.selectSession,
			selectWorktree: s.selectWorktree,
			showError: s.showError,
		})),
	);
	const sessionIn = (checkout: CheckoutId) =>
		checkout ? sessions.filter((s) => s.worktreeId === checkout && s.status !== "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] : undefined;
	return {
		label: (checkout: CheckoutId) => (sessionIn(checkout) ? "Send to session" : "Fix with an agent"),
		async fix(checkout: CheckoutId, problem: string) {
			const s = sessionIn(checkout);
			if (s) {
				try {
					await call("sessions.send", s.id, problem);
					selectSession(s.id);
				} catch (err) {
					showError(err);
				}
				return;
			}
			// A new session works in the worktree the problem came from (or a new one, from main).
			const w = worktrees.find((x) => x.id === checkout && x.target === "project");
			selectWorktree(w ? w.id : null);
			openNewSession({ agentType: "gameplay-engineer", target: "project", context: w ? `Fix a problem in worktree “${w.label}”` : "Fix a problem in the main checkout", prompt: problem });
		},
	};
}

function describeBuildFailure(diagnostics: Diagnostic[], output: string): string {
	const detail = diagnostics.length
		? diagnostics.map((d) => `${d.file}(${d.line}:${d.column}) ${d.severity}: ${d.message}`).join("\n")
		: output.trim().split("\n").slice(-40).join("\n");
	return `The game doesn't build:\n\n\`\`\`\n${detail}\n\`\`\`\n\nPlease fix it and check with \`./build.sh check\`.`;
}

function Diagnostics({ list, sessionId }: { list: Diagnostic[]; sessionId: CheckoutId }) {
	const { showAsset, worktrees } = useStudio(useShallow((s) => ({ showAsset: s.showAsset, worktrees: s.worktrees })));
	// Project worktrees hold the game's files; an engine worktree's files aren't studio assets.
	const draftOf = worktrees.find((w) => w.id === sessionId && w.target === "project")?.id;
	if (!list.length) return null;
	return (
		<div className="diagnostics">
			{list.map((d, i) => (
				<div key={i} className={`diagnostic ${d.severity}`} onClick={() => showAsset({ path: d.file, checkout: draftOf ?? null, line: d.line })}>
					<code>
						{d.file}:{d.line}:{d.column}
					</code>{" "}
					{d.message}
				</div>
			))}
		</div>
	);
}

export function Play() {
	const { playCheckout, playTab, openPlay, sessions, assetsVersion, showError } = useStudio(
		useShallow((s) => ({
			playCheckout: s.playCheckout,
			playTab: s.playTab,
			openPlay: s.openPlay,
			sessions: s.sessions,
			assetsVersion: s.assetsVersion,
			showError: s.showError,
		})),
	);
	const [checkouts, setCheckouts] = useState<CheckoutInfo[]>([]);

	useEffect(() => {
		call("run.checkouts").then(setCheckouts, showError);
	}, [sessions, showError]);

	// A checkout disappears when its session is merged or discarded: fall back to main.
	useEffect(() => {
		if (checkouts.length && !checkouts.some((c) => c.sessionId === playCheckout)) openPlay({ checkout: null });
	}, [checkouts, playCheckout, openPlay]);

	return (
		<div className="play">
			<div className="session-header">
				<div className="row">
					<h2 className="grow">Play &amp; Test</h2>
					<span className="muted">Code from</span>
					<select
						data-testid="checkout"
						value={playCheckout ?? ""}
						onChange={(e) => openPlay({ checkout: e.target.value || null })}
					>
						{checkouts.map((c) => (
							<option key={c.sessionId ?? ""} value={c.sessionId ?? ""}>
								{c.label}
							</option>
						))}
					</select>
				</div>
			</div>
			<div className="tabs">
				{(["run", "tests"] as const).map((t) => (
					<button key={t} className={`tab ${playTab === t ? "active" : ""}`} onClick={() => openPlay({ tab: t })}>
						{t === "run" ? "Run" : "Tests"}
					</button>
				))}
			</div>
			{playTab === "run" ? <RunPanel /> : <TestsPanel key={`${playCheckout}:${assetsVersion}`} />}
		</div>
	);
}

function RunPanel() {
	const { run, runOutput, frame, peerFrames, startRun, playCheckout, playPlayers, setPlayPlayers, showError } = useStudio(
		useShallow((s) => ({
			run: s.run,
			runOutput: s.runOutput,
			frame: s.frame,
			peerFrames: s.peerFrames,
			startRun: s.startRun,
			playCheckout: s.playCheckout,
			playPlayers: s.playPlayers,
			setPlayPlayers: s.setPlayPlayers,
			showError: s.showError,
		})),
	);
	// A multiplayer run: the copy of the game the controls, console and inspector are about (and that takes the keyboard).
	const [focus, setFocus] = useState(0);
	useEffect(() => setFocus(0), [run?.id]);
	const players = run?.players;
	const player = players?.some((p) => p.index === focus) ? focus : 0;
	const { label: fixLabel, fix } = useFix();
	const running = run?.state === "running";
	const building = run?.state === "building";
	const starting = run?.state === "starting";
	const busy = building || starting;
	const [info, setInfo] = useState<{ fps: number; frame: number; paused: boolean } | null>(null);

	useEffect(() => {
		void quiet(call("run.stream", true));
		return () => void quiet(call("run.stream", false));
	}, []);

	useEffect(() => {
		if (!running) return setInfo(null);
		const poll = () => call("run.call", "info", {}, player).then((r) => setInfo(r as typeof info), () => setInfo(null));
		poll();
		const t = setInterval(poll, 1000);
		return () => clearInterval(t);
	}, [running, run?.id, player]);

	const command = (cmd: string, args?: Record<string, unknown>) => call("run.call", cmd, args, player).catch(showError);
	const otherCheckout = run && run.sessionId !== playCheckout && run.state !== "exited" && run.state !== "build_failed";

	return (
		<div className="run-panel">
			<ScenarioPicker />
			<div className="run-controls row">
				<button className="primary" disabled={starting} onClick={() => startRun("hidden")} title={building ? "Run it here once this build finishes (the build carries on)" : "Build, then run hidden and stream it here"} data-testid="run-in-studio">
					▶ Run in studio
				</button>
				<button disabled={starting} onClick={() => startRun("window")} title={building ? "Play it in its own window once this build finishes (the build carries on)" : "Build, then run in its own window"} data-testid="play-in-window">
					⧉ Play in window
				</button>
				<button disabled={busy} onClick={() => startRun("build")}>
					⚒ Build
				</button>
				<button disabled={!running && !busy} onClick={() => call("run.stop").catch(showError)} title={building ? "Stop the build: nothing starts" : "Stop the game"} data-testid="run-stop">
					{building ? "■ Cancel build" : "■ Stop"}
				</button>
				<label className="row run-players" title="Multiplayer: start this many copies of the game. The first hosts, the others join it on this machine.">
					<span className="muted">Players</span>
					<select value={playPlayers} onChange={(e) => setPlayPlayers(Number(e.target.value))} data-testid="run-players">
						{Array.from({ length: MAX_RUN_PLAYERS }, (_, i) => (
							<option key={i} value={i + 1}>
								{i + 1}
							</option>
						))}
					</select>
				</label>
				{running && (
					<>
						<span className="sep" />
						<button onClick={() => command(info?.paused ? "resume" : "pause")}>{info?.paused ? "Resume" : "Pause"}</button>
						<button onClick={() => command("step", { frames: 1 })} title="Pause and advance one frame">
							Step
						</button>
					</>
				)}
				<span className="grow" />
				{run && (
					<span className={`badge run-${run.state}`} data-testid="run-state">
						<span className="dot" />
						{STATE_LABEL[run.state]}
						{run.state === "exited" && run.exitCode ? ` (exit ${run.exitCode})` : ""}
					</span>
				)}
				{info && (
					<span className="muted" style={{ fontSize: 12 }}>
						frame {info.frame} · {Math.round(info.fps)} fps
					</span>
				)}
			</div>
			{otherCheckout && <div className="notice">Running {run.label}, not the checkout selected above.</div>}
			<div className="run-body">
				<div className="run-main">
					{running && run.mode === "hidden" && players ? (
						<div className={`viewports players-${players.length}`} data-testid="viewports">
							{players.map((p) => {
								const f = p.index ? peerFrames[p.index] : frame;
								return (
									<div key={p.index} className={`viewport-cell ${p.index === player ? "focused" : ""}`} data-testid="player-view" data-player={p.index} onMouseDown={() => setFocus(p.index)}>
										<div className="row viewport-label">
											<strong>{p.name}</strong>
											<span className="muted">{p.role === "host" ? "hosts" : "joined"}</span>
											<span className="grow" />
											{p.state !== "running" && <span className="muted">{p.state === "starting" ? "starting…" : "stopped"}</span>}
											{p.index === player && <span className="badge current">controls</span>}
										</div>
										{p.state === "running" && f?.runId === run.id ? <Viewport frame={f} player={p.index} compact /> : <div className="viewport empty">{p.state === "exited" ? "This copy of the game has stopped." : "Starting…"}</div>}
									</div>
								);
							})}
						</div>
					) : running && run.mode === "hidden" && frame?.runId === run.id ? (
						<Viewport frame={frame} player={0} />
					) : (
						<div className="viewport empty">
							{running && run.mode === "window"
								? players
									? `Playing in ${players.length} windows, one per player. The inspector and console work on ${players[player].name}'s copy.`
									: "Playing in a separate window. The inspector and console still work."
								: busy
									? STATE_LABEL[run!.state]
									: "Run the game to see it here. Click the picture to play with keyboard and mouse; a controller works without clicking."}
						</div>
					)}
					{run?.state === "build_failed" && (
						<div className="row build-failed">
							<span className="grow">The build failed{run.diagnostics.length ? ` with ${run.diagnostics.length} error(s)` : ""}.</span>
							<button onClick={() => fix(run.sessionId, describeBuildFailure(run.diagnostics, runOutput))}>{fixLabel(run.sessionId)}</button>
						</div>
					)}
					{run && <Diagnostics list={run.diagnostics} sessionId={run.sessionId} />}
					{players && run.mode === "window" && running && (
						<div className="row run-player-pick">
							<span className="muted">Inspect and send commands to</span>
							<div className="segmented">
								{players.map((p) => (
									<button key={p.index} className={p.index === player ? "on" : ""} onClick={() => setFocus(p.index)}>
										{p.name}
									</button>
								))}
							</div>
						</div>
					)}
					<Console output={runOutput} running={running} player={player} label={players ? players[player].name : undefined} />
				</div>
				<Inspector running={running} runId={run?.id} player={player} label={players ? players[player].name : undefined} />
			</div>
		</div>
	);
}

function Viewport({ frame, player, compact }: { frame: { src: string; width: number; height: number }; player: number; compact?: boolean }) {
	const img = useRef<HTMLImageElement>(null);
	const [captured, setCaptured] = useState(false);
	const lastMove = useRef(0);

	const toFrame = (e: MouseEvent | WheelEvent) => {
		const r = img.current!.getBoundingClientRect();
		return { x: Math.round(((e.clientX - r.left) * frame.width) / r.width), y: Math.round(((e.clientY - r.top) * frame.height) / r.height) };
	};
	const send = (cmd: string, args: Record<string, unknown>) => void quiet(call("run.call", cmd, args, player));
	const key = (e: KeyboardEvent, state: "down" | "up") => {
		const name = raylibKey(e.code);
		if (!name) return;
		e.preventDefault();
		if (!e.repeat) send("key", { key: name, state });
	};
	const button = (e: MouseEvent) => ["LEFT", "MIDDLE", "RIGHT"][e.button];

	return (
		<div
			className={`viewport ${captured ? "captured" : ""}`}
			tabIndex={0}
			data-testid="viewport"
			onFocus={() => setCaptured(true)}
			onBlur={() => {
				setCaptured(false);
				send("release_input", {});
			}}
			onKeyDown={(e) => key(e, "down")}
			onKeyUp={(e) => key(e, "up")}
			onMouseMove={(e) => {
				if (!captured || Date.now() - lastMove.current < 30) return;
				lastMove.current = Date.now();
				send("mouse", toFrame(e));
			}}
			onMouseDown={(e) => captured && send("mouse", { ...toFrame(e), button: button(e), state: "down" })}
			onMouseUp={(e) => captured && send("mouse", { ...toFrame(e), button: button(e), state: "up" })}
			onMouseLeave={() => captured && send("mouse", { release: true })}
			onWheel={(e) => captured && send("mouse", { wheel: -Math.sign(e.deltaY) })}
			onContextMenu={(e) => e.preventDefault()}
		>
			<img ref={img} src={frame.src} alt="Game view" draggable={false} />
			<span className="viewport-hint">
				{compact
					? captured
						? "Playing this player. Click another to switch."
						: "Click to play this player"
					: captured
						? "Playing: keyboard, mouse and controller go to the game. Click outside to stop."
						: "Click to play with keyboard and mouse · a controller always works"}
			</span>
		</div>
	);
}

function Console({ output, running, player, label }: { output: string; running: boolean; player: number; label?: string }) {
	const [line, setLine] = useState("");
	const end = useRef<HTMLDivElement>(null);
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [output]);

	const submit = async () => {
		const text = line.trim();
		if (!text) return;
		setLine("");
		let cmd: string;
		let args: Record<string, unknown> = {};
		try {
			if (text.startsWith("{")) {
				({ cmd, ...args } = JSON.parse(text));
			} else {
				const [first, ...rest] = text.split(/\s+/);
				cmd = first;
				for (const kv of rest) {
					const [k, ...v] = kv.split("=");
					const raw = v.join("=");
					try {
						args[k] = JSON.parse(raw);
					} catch {
						args[k] = raw;
					}
				}
			}
		} catch (err) {
			appendOutput(`> ${text}\n${(err as Error).message}\n`);
			return;
		}
		try {
			const result = await call("run.call", cmd, args, player);
			appendOutput(`${label ? `[${label}] ` : ""}> ${text}\n${pretty(result)}\n`);
		} catch (err) {
			appendOutput(`> ${text}\nerror: ${(err as Error).message}\n`);
		}
	};

	return (
		<div className="console">
			<pre data-testid="console">
				{output || <span className="muted">Build and game output appears here.</span>}
				<div ref={end} />
			</pre>
			<input
				disabled={!running}
				placeholder={running ? `${label ? `To ${label}: c` : "C"}ontrol command, e.g. entities, spawn name=Box position=[0,3,0], or {"cmd": …}` : "Run the game to send commands"}
				value={line}
				onChange={(e) => setLine(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && void submit()}
			/>
		</div>
	);
}

function appendOutput(text: string): void {
	useStudio.setState((s) => ({ runOutput: s.runOutput + text }));
}

interface EntityRow {
	id: number;
	name: string;
	components: string[];
}

function Inspector({ running, runId, player, label }: { running: boolean; runId?: string; player: number; label?: string }) {
	const [entities, setEntities] = useState<EntityRow[]>([]);
	const [selected, setSelected] = useState<number | null>(null);
	const [detail, setDetail] = useState<unknown>(null);

	useEffect(() => {
		setSelected(null);
		if (!running) return setEntities([]);
		const poll = () => call("run.call", "entities", {}, player).then((r) => setEntities(r as EntityRow[]), () => setEntities([]));
		poll();
		const t = setInterval(poll, 1000);
		return () => clearInterval(t);
	}, [running, runId, player]);

	useEffect(() => {
		if (selected === null || !running) return setDetail(null);
		const poll = () => call("run.call", "entity", { entity: selected }, player).then(setDetail, () => setDetail(null));
		poll();
		const t = setInterval(poll, 500);
		return () => clearInterval(t);
	}, [selected, running, player]);

	return (
		<div className="inspector">
			<h3>
				Entities {running && <span className="muted">({entities.length})</span>}
				{label && running && <span className="muted"> · {label}</span>}
			</h3>
			{!running && <div className="muted">Not running.</div>}
			<div className="entity-list">
				{entities.map((e) => (
					<div
						key={e.id}
						data-testid="entity"
						className={`entity-row ${selected === e.id ? "selected" : ""}`}
						onClick={() => setSelected(selected === e.id ? null : e.id)}
						title={e.components.join(", ")}
					>
						<span className="muted">#{e.id}</span> {e.name || <span className="muted">(unnamed)</span>}
					</div>
				))}
			</div>
			{detail !== null && <pre className="entity-detail">{pretty((detail as { components?: unknown }).components ?? detail)}</pre>}
		</div>
	);
}

function TestsPanel() {
	const { playCheckout, testReports, testsRunning, runTests, showError } = useStudio(
		useShallow((s) => ({
			playCheckout: s.playCheckout,
			testReports: s.testReports,
			testsRunning: s.testsRunning,
			runTests: s.runTests,
			showError: s.showError,
		})),
	);
	const [scripts, setScripts] = useState<string[] | null>(null);
	const [open, setOpen] = useState<string | null>(null);

	useEffect(() => {
		call("run.tests", playCheckout).then(setScripts, showError);
	}, [playCheckout, showError]);

	const busy = testsRunning.length > 0;
	return (
		<div className="tab-body tests-panel">
			<div className="row">
				<span className="muted grow">
					Control scripts in <code>tests/</code>, run headlessly with <code>./build.sh test</code>. A test passes when every command succeeds. A <code>.mp.jsonl</code> script is
					a multiplayer test: it runs across several copies of the game, each line sent to the player it names.
				</span>
				<button className="primary" disabled={busy || !scripts?.length} onClick={() => scripts && runTests(scripts)}>
					▶ Run all
				</button>
			</div>
			{scripts?.length === 0 && <div className="empty">No tests yet. Gameplay sessions add them as <code>tests/*.jsonl</code>.</div>}
			{scripts?.map((script) => {
				const key = testKey(playCheckout, script);
				const report = testReports[key];
				const running = testsRunning.includes(key);
				const expanded = open === script || (open === null && report && !report.ok);
				return (
					<div key={script} className="test-card" data-testid="test">
						<div className="row test-head" onClick={() => setOpen(expanded ? "" : script)}>
							<span className={`test-status ${running ? "running" : report ? (report.ok ? "pass" : "fail") : ""}`}>
								{running ? "…" : report ? (report.ok ? "✓" : "✗") : "○"}
							</span>
							<code className="grow ellipsis">{script}</code>
							{report && !running && (
								<span className="muted" style={{ fontSize: 12 }}>
									{report.ok ? "passed" : "failed"} in {(report.durationMs / 1000).toFixed(1)}s
								</span>
							)}
							<button
								disabled={running}
								onClick={(e) => {
									e.stopPropagation();
									void runTests([script]);
								}}
							>
								{running ? "Running…" : "Run"}
							</button>
						</div>
						{expanded && report && <TestDetail report={report} />}
					</div>
				);
			})}
		</div>
	);
}

function describeTestFailure(r: TestReport): string {
	const failed = r.steps.filter((s) => !s.ok).map((s) => `line ${s.line}: ${s.command}\n  → ${s.error}`);
	const lines = !r.buildOk
		? r.diagnostics.map((d) => `${d.file}(${d.line}:${d.column}) ${d.message}`)
		: [...failed, ...(r.notRun ? [`${r.notRun} command(s) never ran (exit code ${r.exitCode})`] : [])];
	const detail = lines.length ? lines.join("\n") : r.output.trim().split("\n").slice(-30).join("\n");
	return `The test \`${r.script}\` fails (\`./build.sh test ${r.script}\`):\n\n\`\`\`\n${detail}\n\`\`\`\n\nPlease find out why and fix the game, or the test if the test is wrong.`;
}

function TestDetail({ report }: { report: TestReport }) {
	const { label: fixLabel, fix } = useFix();
	const [images, setImages] = useState<Record<string, string>>({});
	const [showOutput, setShowOutput] = useState(false);

	useEffect(() => {
		for (const path of report.screenshots) {
			call("run.image", report.sessionId, path).then((url) => setImages((m) => ({ ...m, [path]: url })), () => {});
		}
	}, [report]);

	return (
		<div className="test-detail col">
			{!report.buildOk && <div className="msg error">The game didn't build.</div>}
			<Diagnostics list={report.diagnostics} sessionId={report.sessionId} />
			{report.steps.map((s) => (
				<div key={s.line} className={`test-step ${s.ok ? "pass" : "fail"}`}>
					<span className="muted">{s.line}</span>
					<span>{s.ok ? "✓" : "✗"}</span>
					<code className="grow">{s.command}</code>
					{!s.ok && <span className="step-error">{s.error}</span>}
				</div>
			))}
			{report.notRun > 0 && (
				<div className="muted">
					{report.notRun} command(s) never ran (the game exited with code {String(report.exitCode)}).
				</div>
			)}
			{report.screenshots.length > 0 && (
				<div className="row" style={{ flexWrap: "wrap" }}>
					{report.screenshots.map((p) =>
						images[p] ? (
							<figure key={p} className="shot">
								<img src={images[p]} alt={p} />
								<figcaption className="muted">{p}</figcaption>
							</figure>
						) : null,
					)}
				</div>
			)}
			<div className="row">
				<button className="ghost" onClick={() => setShowOutput(!showOutput)}>
					{showOutput ? "Hide output" : "Show output"}
				</button>
				<span className="grow" />
				{!report.ok && <button onClick={() => fix(report.sessionId, describeTestFailure(report))}>{fixLabel(report.sessionId)}</button>}
			</div>
			{showOutput && <pre className="test-output">{report.output}</pre>}
		</div>
	);
}
