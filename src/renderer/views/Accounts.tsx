import { useCallback, useEffect, useRef, useState } from "react";
import type { LoginNotice, LoginPrompt, ProviderInfo } from "../../shared/types";
import { call, onEvent } from "../api";
import { useStudio } from "../store";

/** Shown first; everything else Pi supports sits under "More providers". */
const FEATURED = ["anthropic", "openai-codex", "openai", "google", "github-copilot", "openrouter"];

function LoginDialog({ provider, type, onDone }: { provider: ProviderInfo; type: "oauth" | "api_key"; onDone(): void }) {
	const [loginId] = useState(() => crypto.randomUUID());
	const [notices, setNotices] = useState<LoginNotice[]>([]);
	const [prompt, setPrompt] = useState<LoginPrompt | null>(null);
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);

	const started = useRef(false);

	useEffect(
		() =>
			onEvent((e) => {
				if (e.type === "login_notice" && e.loginId === loginId) {
					setNotices((n) => [...n, e.notice]);
					if (e.notice.type === "auth_url") window.open(e.notice.url);
				}
				if (e.type === "login_prompt" && e.loginId === loginId) {
					setPrompt(e.prompt);
					setValue("");
				}
			}),
		[loginId],
	);

	useEffect(() => {
		if (started.current) return; // StrictMode runs effects twice in development
		started.current = true;
		call("accounts.login", loginId, provider.id, type).then(onDone, (err: Error) => setError(err.message));
	}, [loginId, provider.id, type, onDone]);

	const answer = (v: string | null) => {
		setPrompt(null);
		void call("accounts.answer", loginId, v);
		if (v === null) onDone();
	};

	return (
		<div className="modal-backdrop">
			<div className="modal">
				<h2>
					{type === "oauth" ? provider.oauth?.name : provider.apiKey?.name ?? provider.name}
				</h2>
				{notices.map((n, i) => (
					<div key={i}>
						{n.type === "auth_url" && (
							<div className="col">
								<span>{n.instructions ?? "Complete the sign-in in your browser."}</span>
								<a href={n.url} target="_blank" rel="noreferrer" className="ellipsis">
									{n.url}
								</a>
							</div>
						)}
						{n.type === "device_code" && (
							<div className="col">
								<span>
									Go to{" "}
									<a href={n.verificationUri} target="_blank" rel="noreferrer">
										{n.verificationUri}
									</a>{" "}
									and enter:
								</span>
								<code style={{ fontSize: 20 }}>{n.userCode}</code>
							</div>
						)}
						{(n.type === "progress" || n.type === "info") && <span className="muted">{n.message}</span>}
					</div>
				))}
				{prompt && (
					<div className="col">
						<span>{prompt.message}</span>
						{prompt.type === "select" ? (
							prompt.options.map((o) => (
								<button key={o.id} className="agent-type" onClick={() => answer(o.id)}>
									<strong>{o.label}</strong>
									{o.description && <small>{o.description}</small>}
								</button>
							))
						) : (
							<div className="row">
								<input
									className="grow"
									autoFocus
									type={prompt.type === "secret" ? "password" : "text"}
									placeholder={prompt.placeholder}
									value={value}
									onChange={(e) => setValue(e.target.value)}
									onKeyDown={(e) => e.key === "Enter" && value && answer(value)}
								/>
								<button className="primary" disabled={!value} onClick={() => answer(value)}>
									Continue
								</button>
							</div>
						)}
					</div>
				)}
				{!prompt && !error && notices.length === 0 && <span className="muted">Starting…</span>}
				{error && <div className="msg error">{error}</div>}
				<div className="row" style={{ justifyContent: "flex-end" }}>
					<button onClick={() => (error ? onDone() : answer(null))}>{error ? "Close" : "Cancel"}</button>
				</div>
			</div>
		</div>
	);
}

function ProviderRow({ p, onLogin, onLogout }: { p: ProviderInfo; onLogin(type: "oauth" | "api_key"): void; onLogout(): void }) {
	return (
		<div className="list-row">
			<div className="grow col" style={{ gap: 0 }}>
				<strong>{p.name}</strong>
				<span className="muted" style={{ fontSize: 12 }}>
					{p.configured ? `✓ Connected${p.source ? ` (${p.source})` : ""}` : "Not connected"}
				</span>
			</div>
			{p.oauth && <button onClick={() => onLogin("oauth")}>{p.oauth.loginLabel ?? (p.oauth.isSubscription ? "Sign in with subscription" : "Sign in")}</button>}
			{p.apiKey?.interactive && <button onClick={() => onLogin("api_key")}>API key</button>}
			{p.configured && (
				<button className="danger" onClick={onLogout}>
					Sign out
				</button>
			)}
		</div>
	);
}

export function Accounts() {
	const { models, refreshModels, showError } = useStudio();
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [login, setLogin] = useState<{ provider: ProviderInfo; type: "oauth" | "api_key" } | null>(null);
	const [showAll, setShowAll] = useState(false);

	const reload = useCallback(async () => {
		try {
			setProviders(await call("accounts.providers"));
			await refreshModels();
		} catch (err) {
			showError(err);
		}
	}, [refreshModels, showError]);

	useEffect(() => void reload(), [reload]);
	const onDone = useCallback(() => {
		setLogin(null);
		void reload();
	}, [reload]);

	const featured = FEATURED.map((id) => providers.find((p) => p.id === id)).filter((p): p is ProviderInfo => Boolean(p));
	const others = providers.filter((p) => !FEATURED.includes(p.id) && p.id !== "faux");
	const row = (p: ProviderInfo) => (
		<ProviderRow
			key={p.id}
			p={p}
			onLogin={(type) => setLogin({ provider: p, type })}
			onLogout={async () => {
				if (!window.confirm(`Sign out of ${p.name}?`)) return;
				await call("accounts.logout", p.id).catch(showError);
				void reload();
			}}
		/>
	);
	const byProvider = new Map<string, number>();
	for (const m of models) byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);

	return (
		<div className="page">
			<h2>Accounts</h2>
			<p className="muted">
				Connect AI accounts here. Subscriptions sign in through your browser; API keys are stored in Game Studio's own Pi credentials file.
				The models your accounts unlock are the models sessions can use.
			</p>
			<div className="card">
				{featured.map(row)}
				<button className="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(!showAll)}>
					{showAll ? "Hide" : "More providers"} ({others.length})
				</button>
				{showAll && others.map(row)}
			</div>
			<div className="card">
				<h3>Available models ({models.length})</h3>
				{models.length === 0 && <span className="muted">None yet: connect an account above.</span>}
				{[...byProvider].map(([provider, count]) => (
					<details key={provider}>
						<summary>
							{provider} ({count})
						</summary>
						<div className="col" style={{ padding: "6px 14px", gap: 2 }}>
							{models
								.filter((m) => m.provider === provider)
								.map((m) => (
									<code key={m.ref}>
										{m.id} <span className="muted">{m.name !== m.id ? m.name : ""}</span>
									</code>
								))}
						</div>
					</details>
				))}
			</div>
			{login && <LoginDialog provider={login.provider} type={login.type} onDone={onDone} />}
		</div>
	);
}
