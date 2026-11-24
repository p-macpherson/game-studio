// The studio's own checks of a game worktree before a person reviews it: it builds, and its tests pass. Run when a
// session asks for review (and on request from the Review page), once per commit; the result is kept in memory.
import type { ReviewChecks } from "../shared/review";
import type { Diagnostic, TestReport } from "../shared/run";
import { inParallel, longestFirst } from "./release";

export interface ReviewCheckDeps {
	/** The worktree's HEAD commit. */
	head(worktreeId: string): Promise<string>;
	compile(worktreeId: string): Promise<{ ok: boolean; diagnostics: Diagnostic[]; output: string }>;
	tests(worktreeId: string): string[];
	/** One script against what `compile` built; with `parallel`, several at once. */
	test(worktreeId: string, script: string): Promise<TestReport>;
	/** How many scripts run at once (default 1). */
	parallel?: number;
	changed(worktreeId: string): void;
}

export class ReviewCheckService {
	private readonly results = new Map<string, ReviewChecks>();
	private readonly running = new Map<string, Promise<void>>();
	/** Worktrees asked for again while their checks ran (a newer commit): checked once more afterwards. */
	private readonly again = new Set<string>();

	constructor(private readonly deps: ReviewCheckDeps) {}

	get(worktreeId: string): ReviewChecks | null {
		return this.results.get(worktreeId) ?? null;
	}

	forget(worktreeId: string): void {
		this.results.delete(worktreeId);
	}

	/** Checks the worktree unless its current commit has been checked already (`force`: check it again anyway). */
	async request(worktreeId: string, force = false): Promise<void> {
		if (this.running.has(worktreeId)) {
			this.again.add(worktreeId);
			return this.running.get(worktreeId);
		}
		const commit = await this.deps.head(worktreeId);
		const known = this.results.get(worktreeId);
		if (!force && known?.state === "done" && known.commit === commit) return;
		const run = this.run(worktreeId, commit).finally(() => {
			this.running.delete(worktreeId);
			if (this.again.delete(worktreeId)) void this.request(worktreeId).catch(() => {});
		});
		this.running.set(worktreeId, run);
		return run;
	}

	private async run(worktreeId: string, commit: string): Promise<void> {
		const previous = this.results.get(worktreeId);
		const result: ReviewChecks = { worktreeId, state: "running", commit, startedAt: new Date().toISOString(), doing: "Building…", tests: [] };
		const publish = () => {
			this.results.set(worktreeId, { ...result, tests: [...result.tests] });
			this.deps.changed(worktreeId);
		};
		publish();
		try {
			const built = await this.deps.compile(worktreeId);
			const errors = built.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.file}:${d.line}: ${d.message}`);
			result.build = { ok: built.ok, errors: built.ok ? [] : errors.length ? errors.slice(0, 20) : [built.output.trim().split("\n").slice(-8).join("\n") || "The build failed"] };
			if (built.ok) {
				const scripts = this.deps.tests(worktreeId);
				// The longest last time first, so the slowest doesn't run on alone at the end.
				const took = new Map((previous?.tests ?? []).map((t) => [t.script, t.durationMs]));
				result.doing = `Running ${scripts.length} test${scripts.length === 1 ? "" : "s"}…`;
				publish();
				await inParallel(longestFirst(scripts, (s) => took.get(s)), this.deps.parallel ?? 1, async (script) => {
					const r = await this.deps.test(worktreeId, script);
					const failed = r.steps.find((s) => !s.ok);
					const problem = r.ok ? undefined : !r.buildOk ? "It didn't build" : failed ? `Line ${failed.line} (${failed.command}): ${failed.error ?? "failed"}` : r.notRun ? `${r.notRun} command${r.notRun === 1 ? "" : "s"} never ran: the game stopped early` : `The game exited with code ${r.exitCode}`;
					result.tests.push({ script, ok: r.ok, durationMs: r.durationMs, ...(problem ? { problem } : {}) });
					result.tests.sort((a, b) => a.script.localeCompare(b.script));
					result.doing = `Running tests: ${result.tests.length} of ${scripts.length} done…`;
					publish();
				});
			}
		} catch (err) {
			result.build ??= { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
		}
		result.state = "done";
		result.doing = undefined;
		result.finishedAt = new Date().toISOString();
		publish();
	}
}
