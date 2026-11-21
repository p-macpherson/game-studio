// Settings → Asset generation: whether the local models are installed, the GPU worker, and the job queue.
import { useEffect, useRef, useState } from "react";
import type { GenJob, GenStatus } from "../../shared/gen";
import { call, onEvent, relativeTime } from "../api";
import { useStudio } from "../store";
import { useShallow } from "zustand/react/shallow";

const ACTIVE = new Set(["queued", "running"]);

export function AssetGeneration() {
	const { showError, selectSession, sessions } = useStudio(
		useShallow((s) => ({
			showError: s.showError,
			selectSession: s.selectSession,
			sessions: s.sessions,
		})),
	);
	const [status, setStatus] = useState<GenStatus | null>(null);
	const [jobs, setJobs] = useState<GenJob[]>([]);
	const [log, setLog] = useState("");
	const logEnd = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const refresh = () => call("gen.status").then(setStatus, showError);
		refresh();
		call("gen.jobs").then(setJobs, showError);
		return onEvent((e) => {
			if (e.type === "gen_changed") refresh();
			if (e.type === "gen_job") {
				setJobs((list) => (list.some((j) => j.id === e.job.id) ? list.map((j) => (j.id === e.job.id ? e.job : j)) : [...list, e.job]));
				refresh();
			}
			if (e.type === "gen_setup") setLog((l) => (l + e.text).slice(-50_000));
		});
	}, [showError]);

	useEffect(() => {
		logEnd.current?.scrollIntoView({ block: "end" });
	}, [log]);

	if (!status) return null;
	const recent = [...jobs].reverse().slice(0, 30);
	const install = () => {
		setLog("");
		call("gen.install").catch(showError);
	};

	return (
		<div className="card" data-testid="asset-generation">
			<div className="row">
				<h3 className="grow">Asset generation</h3>
				{status.worker && (
					<span className="badge" title="The model worker holding the GPU. It stops after 5 idle minutes.">
						<span className={`dot gen-${status.worker.state}`} />
						GPU: {status.worker.family} ({status.worker.state})
					</span>
				)}
				{!status.fake && (
					<button disabled={status.installing} onClick={install}>
						{status.installing ? "Installing…" : status.ready ? "Repair / update" : "Install"}
					</button>
				)}
			</div>
			<small className="muted">
				Local models on your GPU make concept images, 3D models, textures and rigs. They take about 45 GB in <code>{status.root}</code>, and only one
				runs at a time.
			</small>
			<div className="gen-components">
				{status.components.map((c) => (
					<div key={c.id} className="row" data-testid="gen-component">
						<span className={c.ok ? "ok-mark" : "bad-mark"}>{c.ok ? "✓" : "✗"}</span>
						<span className="grow">{c.name}</span>
						<span className="muted ellipsis" style={{ fontSize: 12, maxWidth: "55%" }} title={c.detail}>
							{c.detail}
						</span>
					</div>
				))}
			</div>
			{log && (
				<pre className="test-output" data-testid="gen-setup-log">
					{log}
					<div ref={logEnd} />
				</pre>
			)}
			<h3>Jobs</h3>
			{recent.length === 0 && <span className="muted">No generation jobs yet. Agents start them with the generation tools.</span>}
			{recent.map((j) => (
				<div key={j.id} className="list-row gen-job" data-testid="gen-job">
					<span className={`badge gen-status-${j.status}`}>{j.status}</span>
					<span className="grow ellipsis" title={j.error ?? j.progress?.message}>
						{j.label}
						{j.status === "running" && j.progress && <span className="muted"> · {j.progress.message}</span>}
						{j.status === "failed" && <span className="step-error"> · {j.error}</span>}
					</span>
					{j.sessionId && sessions.some((s) => s.id === j.sessionId) && (
						<button className="ghost" onClick={() => selectSession(j.sessionId!)}>
							Session
						</button>
					)}
					<span className="muted" style={{ fontSize: 11 }}>
						{j.status === "done" && typeof j.result?.seconds === "number" ? `${j.result.seconds}s · ` : ""}
						{relativeTime(j.finishedAt ?? j.startedAt ?? j.createdAt)}
					</span>
					{ACTIVE.has(j.status) && (
						<button className="ghost" onClick={() => call("gen.cancel", j.id).catch(showError)}>
							Cancel
						</button>
					)}
				</div>
			))}
		</div>
	);
}
