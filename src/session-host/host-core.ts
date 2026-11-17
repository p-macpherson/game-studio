// Everything the session host does, independent of how it's transported: the utility process wraps it
// with parentPort, and tests drive it in-process.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import type { HostApi, HostEvent, HostInfo, PromptMode, SessionOpenSpec } from "../shared/host";
import type { ModelInfo, ProviderInfo } from "../shared/types";
import { createFaux } from "./faux";
import { studioTools } from "./studio-tools";

interface Live {
	session: AgentSession;
	unsubscribe: () => void;
}

interface Waiter {
	resolve(value: string): void;
	reject(err: Error): void;
}

export interface HostCoreOptions {
	agentDir: string;
	post(event: HostEvent): void;
	/** Registers the scripted `faux/echo` model (tests and e2e). */
	faux?: boolean;
}

/** Event payloads are forwarded over structured clone; strip anything that isn't plain JSON. */
const sanitize = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class HostCore implements HostApi {
	private readonly sessions = new Map<string, Live>();
	private readonly logins = new Map<string, (value: string | null) => void>();
	private readonly questions = new Map<string, Waiter>();

	private constructor(
		private readonly runtime: ModelRuntime,
		private readonly opts: HostCoreOptions,
		private readonly faux?: ReturnType<typeof createFaux>,
	) {}

	static async create(opts: HostCoreOptions): Promise<HostCore> {
		mkdirSync(opts.agentDir, { recursive: true });
		const runtime = await ModelRuntime.create({
			authPath: join(opts.agentDir, "auth.json"),
			modelsPath: join(opts.agentDir, "models.json"),
		});
		let faux: ReturnType<typeof createFaux> | undefined;
		if (opts.faux) {
			faux = createFaux();
			runtime.registerNativeProvider(faux.provider);
		}
		return new HostCore(runtime, opts, faux);
	}

	info(): HostInfo {
		return { node: process.versions.node, piVersion: VERSION, providers: this.runtime.getProviders().length };
	}

	providers(): ProviderInfo[] {
		return this.runtime
			.getProviders()
			.filter((p) => p.auth.oauth || p.auth.apiKey)
			.map((p) => {
				const status = this.runtime.getProviderAuthStatus(p.id);
				const { oauth, apiKey } = p.auth;
				return {
					id: p.id,
					name: p.name,
					configured: status.configured,
					source: status.label ?? status.source,
					oauth: oauth && { name: oauth.name, loginLabel: oauth.loginLabel, isSubscription: oauth.isSubscription },
					apiKey: apiKey && { name: apiKey.name, interactive: Boolean(apiKey.login) },
				};
			});
	}

	async models(): Promise<ModelInfo[]> {
		const available = [...(await this.runtime.getAvailable()), ...(this.faux?.models ?? [])];
		const seen = new Set<string>();
		return available
			.map((m) => ({ ref: `${m.provider}/${m.id}`, provider: m.provider, id: m.id, name: m.name ?? m.id, reasoning: Boolean(m.reasoning) }))
			.filter((m) => !seen.has(m.ref) && seen.add(m.ref));
	}

	async login(loginId: string, provider: string, type: "oauth" | "api_key"): Promise<void> {
		const abort = new AbortController();
		let answer: Waiter | undefined;
		this.logins.set(loginId, (value) => {
			if (value === null) {
				abort.abort();
				answer?.reject(new Error("Login cancelled"));
			} else answer?.resolve(value);
			answer = undefined;
		});
		const interaction: AuthInteraction = {
			signal: abort.signal,
			prompt: ({ signal, ...prompt }) =>
				new Promise<string>((resolve, reject) => {
					answer = { resolve, reject };
					signal?.addEventListener("abort", () => reject(new Error("Prompt no longer needed")));
					this.opts.post({ type: "login_prompt", loginId, prompt: sanitize(prompt) });
				}),
			notify: (notice) => this.opts.post({ type: "login_notice", loginId, notice: sanitize(notice) }),
		};
		try {
			await this.runtime.login(provider, type, interaction, { agentName: "Game Studio", getDeviceId: () => this.deviceId() });
		} finally {
			this.logins.delete(loginId);
		}
	}

	loginAnswer(loginId: string, value: string | null): void {
		this.logins.get(loginId)?.(value);
	}

	async logout(provider: string): Promise<void> {
		await this.runtime.logout(provider);
	}

	private deviceId(): string {
		const file = join(this.opts.agentDir, "device-id");
		if (!existsSync(file)) writeFileSync(file, randomUUID());
		return readFileSync(file, "utf8").trim();
	}

	private resolveModel(ref: string) {
		const slash = ref.indexOf("/");
		const model = this.runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1));
		if (!model) throw new Error(`Unknown model ${ref}`);
		return model;
	}

	async openSession(spec: SessionOpenSpec): Promise<{ sessionFile: string }> {
		this.closeSession(spec.id);
		mkdirSync(spec.sessionDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({
			cwd: spec.cwd,
			agentDir: this.opts.agentDir,
			settingsManager,
			additionalSkillPaths: spec.skillPaths,
			appendSystemPrompt: spec.appendSystemPrompt,
		});
		await loader.reload();
		const sessionManager = spec.sessionFile
			? SessionManager.open(spec.sessionFile, spec.sessionDir, spec.cwd)
			: SessionManager.create(spec.cwd, spec.sessionDir);
		const tools = studioTools({
			sessionId: spec.id,
			post: this.opts.post,
			ask: (questionId, signal) =>
				new Promise<string>((resolve, reject) => {
					this.questions.set(questionId, { resolve, reject });
					signal?.addEventListener("abort", () => {
						this.questions.delete(questionId);
						reject(new Error("Question cancelled"));
					});
				}),
		});
		const { session } = await createAgentSession({
			cwd: spec.cwd,
			agentDir: this.opts.agentDir,
			modelRuntime: this.runtime,
			model: this.resolveModel(spec.model),
			thinkingLevel: spec.thinking,
			resourceLoader: loader,
			sessionManager,
			settingsManager,
			customTools: tools,
		});
		const unsubscribe = session.subscribe((event) => {
			this.opts.post({ type: "session_event", id: spec.id, event: sanitize(event) as { type: string } });
		});
		this.sessions.set(spec.id, { session, unsubscribe });
		const file = session.sessionFile;
		if (!file) throw new Error("Pi did not create a session file");
		return { sessionFile: basename(file) };
	}

	isOpen(id: string): boolean {
		return this.sessions.has(id);
	}

	private live(id: string): AgentSession {
		const live = this.sessions.get(id);
		if (!live) throw new Error(`Session ${id} is not open`);
		return live.session;
	}

	prompt(id: string, text: string, mode?: PromptMode): void {
		const session = this.live(id);
		this.faux?.refill();
		session.prompt(text, session.isStreaming ? { streamingBehavior: mode ?? "followUp" } : undefined).catch((err: unknown) => {
			this.opts.post({ type: "session_error", id, error: err instanceof Error ? err.message : String(err) });
		});
	}

	async abort(id: string): Promise<void> {
		await this.live(id).abort();
	}

	closeSession(id: string): void {
		const live = this.sessions.get(id);
		if (!live) return;
		live.unsubscribe();
		live.session.dispose();
		this.sessions.delete(id);
	}

	messages(id: string): unknown[] {
		return sanitize(this.live(id).messages);
	}

	async setModel(id: string, model: string): Promise<void> {
		await this.live(id).setModel(this.resolveModel(model));
	}

	answerQuestion(_id: string, questionId: string, answer: string): void {
		this.questions.get(questionId)?.resolve(answer);
		this.questions.delete(questionId);
	}
}
