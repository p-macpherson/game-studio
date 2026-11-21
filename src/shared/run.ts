/** Building, running and testing the game. See the vault note "M3 Game Code & Run". */

/** `hidden`: rendered offscreen and streamed into the studio. `window`: a normal game window. */
export type RunMode = "hidden" | "window";

export type RunState = "building" | "build_failed" | "starting" | "running" | "exited";

/** A compiler message, with a repo-relative path when the file is inside the checkout. */
export interface Diagnostic {
	file: string;
	line: number;
	column: number;
	severity: "error" | "warning";
	message: string;
}

/**
 * Which code to run. `null` runs the project's main checkout; a project session runs its worktree; an engine
 * session runs the main checkout against the session's engine worktree (`ENGINE_DIR`).
 */
export type CheckoutId = string | null;

export interface CheckoutInfo {
	sessionId: CheckoutId;
	label: string;
	/** Where `build.sh` runs. */
	cwd: string;
	engineDir?: string;
}

export interface RunInfo {
	id: string;
	sessionId: CheckoutId;
	label: string;
	mode: RunMode;
	state: RunState;
	port?: number;
	exitCode?: number | null;
	diagnostics: Diagnostic[];
	startedAt: string;
	/** Set for the Scenes editor's run: the scene (assets-relative) shown paused, with the game's UI hidden. */
	scene?: string;
	/** Set for the UI section's run: the screen (assets/ui/<screen>.json) shown alone over the game, paused. */
	screen?: string;
	/** Set for the Shaders section's run: the shader's name (assets/shaders/<name>.glsl), shown on a preview mesh. */
	shader?: string;
}

/** A section's live view (Scenes, UI, Shaders) rather than the game run from Play & Test: other sections may take it over. */
export const isEditorRun = (run: { scene?: string; screen?: string; shader?: string }) => !!(run.scene || run.screen || run.shader);

export interface RunOptions {
	/** Open this scene or prefab (assets-relative) paused, as the Scenes editor's live view. */
	scene?: string;
	/** Open the game paused with only this UI screen shown (the UI section's live view). */
	screen?: string;
	/** Open a material shader on a mesh beside a stone, its time running (the Shaders section's live view). */
	shader?: { name: string; mesh?: string };
}

export interface TestStep {
	/** 1-based line in the script. */
	line: number;
	command: string;
	ok: boolean;
	result?: unknown;
	error?: string;
}

export interface TestReport {
	script: string;
	sessionId: CheckoutId;
	ok: boolean;
	buildOk: boolean;
	exitCode: number | null;
	steps: TestStep[];
	/** Commands that never replied (the game crashed or the script stopped early). */
	notRun: number;
	diagnostics: Diagnostic[];
	/** Repo-relative paths of screenshots the script took. */
	screenshots: string[];
	output: string;
	durationMs: number;
	finishedAt: string;
}

const DIAGNOSTIC = /^(.+?)\((\d+):(\d+)\) (Error|Warning|Syntax Error): (.*)$/;

/** Parses Odin compiler output. Paths under `root` become repo-relative. */
export function parseDiagnostics(output: string, root: string): Diagnostic[] {
	const prefix = root.endsWith("/") ? root : `${root}/`;
	const out: Diagnostic[] = [];
	for (const line of output.split("\n")) {
		const m = DIAGNOSTIC.exec(line.trimEnd());
		if (!m) continue;
		out.push({
			file: m[1].startsWith(prefix) ? m[1].slice(prefix.length) : m[1],
			line: Number(m[2]),
			column: Number(m[3]),
			severity: m[4] === "Warning" ? "warning" : "error",
			message: m[5].trim(),
		});
	}
	return out;
}

/** The commands of a control script with their line numbers (blank lines and comments skipped, as the engine does). */
export function scriptCommands(script: string): { line: number; command: string }[] {
	return script
		.split("\n")
		.map((text, i) => ({ line: i + 1, command: text.trim() }))
		.filter(({ command }) => command && !command.startsWith("//") && !command.startsWith("#"));
}

/** Pairs a script's commands with the engine's replies, which it prints to stdout in order, one JSON line each. */
export function pairReplies(script: string, stdout: string): { steps: TestStep[]; notRun: number } {
	const replies = stdout
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.flatMap((l) => {
			try {
				const r = JSON.parse(l);
				return typeof r === "object" && r && "ok" in r ? [r as { ok: boolean; result?: unknown; error?: string }] : [];
			} catch {
				return [];
			}
		});
	const commands = scriptCommands(script);
	const steps = commands.slice(0, replies.length).map((c, i) => ({ ...c, ok: replies[i].ok, result: replies[i].result, error: replies[i].error }));
	return { steps, notRun: commands.length - steps.length };
}
