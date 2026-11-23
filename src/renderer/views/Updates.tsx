// Settings → General → Updates: the stable install's version, the pushed changes it doesn't have, and updating to
// them (prepared in the background while you work, then a restart). A development checkout only shows its version.
import { call, relativeTime } from "../api";
import { useStudio } from "../store";
import { useShallow } from "zustand/react/shallow";

export function UpdatesCard() {
	const { update, sessions, showError } = useStudio(useShallow((s) => ({ update: s.update, sessions: s.sessions, showError: s.showError })));
	if (!update) return null;
	const working = sessions.filter((s) => s.status === "in_progress").length;
	const restart = () => {
		const warn = working ? `\n\n${working} session${working > 1 ? "s are" : " is"} working: ${working > 1 ? "they stop" : "it stops"} and can be resumed afterwards.` : "";
		if (window.confirm(`Restart Game Studio to finish updating?${warn}`)) call("updates.restart").catch(showError);
	};
	const n = update.available.length;
	return (
		<div className="card" data-testid="updates">
			<h3>Updates</h3>
			{update.current && (
				<span className="muted">
					This version: <code>{update.current.commit}</code> {update.current.subject} ({relativeTime(update.current.date)})
				</span>
			)}
			{!update.installed ? (
				<span className="muted">Running from a development checkout: it updates with git, not here. The installed studio (the Game Studio menu entry) updates itself.</span>
			) : (
				<>
					{update.error && <div className="bad-text">{update.error}</div>}
					{n === 0 && update.phase !== "ready" && (
						<div className="row">
							<span className="grow muted">Up to date{update.checkedAt ? ` (checked ${relativeTime(update.checkedAt)})` : ""}.</span>
							<button onClick={() => call("updates.check").catch(showError)}>Check now</button>
						</div>
					)}
					{n > 0 && (
						<>
							<span>
								{n === 1 ? "1 change" : `${n} changes`} since this version:
							</span>
							<ul className="update-list">
								{update.available.slice(0, 12).map((c) => (
									<li key={c.commit}>
										{c.subject} <span className="muted small">{relativeTime(c.date)}</span>
									</li>
								))}
								{n > 12 && <li className="muted">…and {n - 12} more</li>}
							</ul>
						</>
					)}
					{update.phase === "preparing" && (
						<>
							<div className="row">
								<span className="spinner" /> <span className="grow">Preparing the update: building it and checking it starts, while you work…</span>
							</div>
							<pre className="console update-log">{update.log.slice(-6).join("\n")}</pre>
						</>
					)}
					{update.phase === "failed" && <pre className="console update-log">{update.log.slice(-12).join("\n")}</pre>}
					<div className="row">
						<span className="grow" />
						{update.phase === "ready" ? (
							<button className="primary" data-testid="update-restart" onClick={restart}>
								Restart to update
							</button>
						) : (
							n > 0 && (
								<button className="primary" data-testid="update-prepare" disabled={update.phase === "preparing"} onClick={() => call("updates.prepare").catch(showError)}>
									{update.phase === "failed" ? "Try again" : "Update"}
								</button>
							)
						)}
					</div>
				</>
			)}
		</div>
	);
}
