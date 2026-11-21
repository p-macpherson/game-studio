// Studio requests: the steps agents call as tools (`studio_request` from the session host) and people run from a
// section's buttons (`worktrees.run`), each in one checkout. Every part of the studio registers its own (models.ts,
// music.ts, sounds.ts, textures.ts, scenes.ts, asset-move.ts): how to run it and, when it changes files, what the
// undo history calls a person's run of it. Adding a tool means a handler in its module's file, its name in
// StudioRequestMethod (src/shared/host.ts) and its definition for agents in session-host/studio-tools.ts.
import type { GenJob } from "../shared/gen";
import type { StudioRequestMethod } from "../shared/host";
import type { Scope } from "./edit-history";
import type { GenService } from "./gen";
import type { StudioRequest } from "./sessions";

export interface PipelineContext {
	/** Checkout root (absolute). */
	cwd: string;
	sessionId?: string;
	progress?(text: string): void;
	/** Lets a caller cancel the jobs it started. */
	onJob?(job: GenJob): void;
}

/** The context of a request: who asked (a session's id, or a worktree's for a section's step). */
export type RequestContext = PipelineContext & { sessionId: string };

/** A person's run of a step, as the undo history records it: its name and the files it may change. */
export interface StepInfo {
	label: string;
	scopes: Scope[];
}

export interface StudioRequestHandler {
	run(ctx: RequestContext, params: Record<string, unknown>): unknown;
	/** Absent for steps that change nothing (previews): they aren't recorded. */
	step?(params: Record<string, unknown>): StepInfo;
}

export type StudioRequestHandlers = Partial<Record<Exclude<StudioRequestMethod, "delegate">, StudioRequestHandler>>;

/** A handler with typed parameters (their shape is checked where agents call it, by the tool's schema). */
export function handler<P>(run: (ctx: RequestContext, params: P) => unknown, step?: (params: P) => StepInfo): StudioRequestHandler {
	return { run: run as StudioRequestHandler["run"], ...(step ? { step: step as StudioRequestHandler["step"] } : {}) };
}

/**
 * Serves requests with the handlers of every part given, and cancels a request's generation jobs when its agent is
 * stopped. Plug `studioRequest` and `cancelStudioRequest` into SessionService.
 */
export function studioRequests(gen: GenService, ...parts: StudioRequestHandlers[]) {
	const handlers = new Map<string, StudioRequestHandler>();
	for (const part of parts) {
		for (const [method, h] of Object.entries(part)) {
			if (handlers.has(method)) throw new Error(`Two handlers for the studio request "${method}"`);
			handlers.set(method, h);
		}
	}
	const jobs = new Map<string, Set<string>>();
	return {
		async studioRequest(req: StudioRequest): Promise<unknown> {
			const h = handlers.get(req.method);
			if (!h) throw new Error(`This studio can't serve "${req.method}"`);
			if (typeof req.params !== "object" || req.params === null || Array.isArray(req.params)) throw new Error(`"${req.method}" takes an object of parameters`);
			const started = new Set<string>();
			jobs.set(req.requestId, started);
			try {
				return await h.run({ cwd: req.cwd, sessionId: req.sessionId, progress: req.progress, onJob: (j) => started.add(j.id) }, req.params);
			} finally {
				jobs.delete(req.requestId);
			}
		},
		cancelStudioRequest(requestId: string): void {
			for (const id of jobs.get(requestId) ?? []) gen.cancel(id);
		},
		/** A person's run of `method` as an undo step; null when it isn't one (it changes nothing, or isn't known). */
		step(method: string, params: Record<string, unknown>): StepInfo | null {
			return handlers.get(method)?.step?.(params) ?? null;
		},
	};
}
