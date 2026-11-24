// Settings → General → Remote access: the studio's remote page for Pat's other devices, over Tailscale.
import { useEffect, useState } from "react";
import { REMOTE_DEFAULT_PORT, type RemoteStatus } from "../../shared/types";
import { call } from "../api";
import { useStudio } from "../store";

export function RemoteAccessCard() {
	const settings = useStudio((s) => s.settings);
	const showError = useStudio((s) => s.showError);
	const refresh = useStudio((s) => s.refresh);
	const [status, setStatus] = useState<RemoteStatus | null>(null);
	const remote = settings?.remoteAccess;
	const port = remote?.port ?? REMOTE_DEFAULT_PORT;
	const [logins, setLogins] = useState((remote?.logins ?? []).join("\n"));

	const read = () => void call("remote.status").then(setStatus, () => {});
	useEffect(read, []);
	// Who was last turned away shows up without reopening the page.
	useEffect(() => {
		if (!remote?.enabled) return;
		const t = setInterval(read, 5000);
		return () => clearInterval(t);
	}, [remote?.enabled]);

	const save = async (patch: Partial<NonNullable<typeof remote>>) => {
		try {
			await call("settings.update", { remoteAccess: { enabled: false, ...remote, ...patch } });
			await refresh();
		} catch (err) {
			showError(err);
		}
		read();
	};
	const parsed = logins
		.split(/[\s,]+/)
		.map((l) => l.trim())
		.filter(Boolean);
	const allowRefused = () => {
		const who = status?.lastRefused?.who;
		if (!who || who.includes(" ")) return;
		const next = [...new Set([...parsed, who])];
		setLogins(next.join("\n"));
		void save({ logins: next });
	};

	return (
		<div className="card" data-testid="remote-access">
			<h3>Remote access</h3>
			<label className="row" style={{ gap: 8 }}>
				<input type="checkbox" checked={!!remote?.enabled} onChange={(e) => void save({ enabled: e.target.checked })} data-testid="remote-enabled" />
				Serve a remote page for my other devices (over Tailscale)
			</label>
			<small className="muted">
				Sessions, chat, new sessions and merging, from a phone or laptop away from home. The studio listens on this computer only (127.0.0.1:{port}); Tailscale makes it
				reachable from your own devices. Anyone who reaches it can start agents on this computer, so never share it beyond your tailnet (no Funnel, no port forwarding).
			</small>
			{remote?.enabled && (
				<>
					<div className="row" style={{ gap: 8 }} data-testid="remote-status">
						{status?.running ? <span className="badge badge-green">Serving on 127.0.0.1:{status.port}</span> : <span className="badge">Not running</span>}
						{status?.error && <span className="msg error">{status.error}</span>}
					</div>
					<div className="col" style={{ gap: 4 }}>
						<span>Once, in a terminal, to publish it to your tailnet:</span>
						<code>tailscale serve --bg {port}</code>
						<small className="muted">Then open the https://…ts.net address it prints on your phone. `tailscale serve status` shows it again; `tailscale serve reset` stops it.</small>
					</div>
					<label className="field">
						<span>Tailscale logins allowed in (one per line; empty: any login on your tailnet)</span>
						<textarea rows={2} value={logins} onChange={(e) => setLogins(e.target.value)} onBlur={() => void save({ logins: parsed })} data-testid="remote-logins" />
					</label>
					{status?.lastRefused && (
						<div className="row" style={{ gap: 8 }}>
							<small className="muted grow">
								Last turned away: <code>{status.lastRefused.who}</code> ({new Date(status.lastRefused.at).toLocaleTimeString()})
							</small>
							{!status.lastRefused.who.includes(" ") && <button onClick={allowRefused}>Allow this login</button>}
						</div>
					)}
					<div className="row" style={{ gap: 8 }}>
						<label className="row" style={{ gap: 6 }}>
							Port
							<input
								type="number"
								min={1024}
								max={65535}
								defaultValue={port}
								style={{ width: 90 }}
								onBlur={(e) => {
									const p = Number(e.target.value);
									if (p !== port && p >= 1024 && p <= 65535) void save({ port: p });
								}}
							/>
						</label>
					</div>
				</>
			)}
		</div>
	);
}
