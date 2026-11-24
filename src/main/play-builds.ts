// Web builds to play now, one per checkout (remote access's Play: vault Initiatives/Remote Access.md). Built into the
// studio's data folder, not the game's builds/: they're throwaway, replaced by the next one, and never part of a release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioEvent } from "../shared/ipc";
import type { PlayBuild } from "../shared/types";
import { buildPlayable } from "./release";

export interface PlayBuildDeps {
	/** Where the builds go (`<userData>/play`). */
	dataDir: string;
	/** "main" or a worktree's id → its folder. */
	checkoutRoot(checkout: string): string;
	projectName(): string;
	engineRepo(): string;
	emit(event: StudioEvent): void;
	/**
	 * Starts a session to fix a failed build: in `checkout`'s worktree, or with null (main) in a new one from main. Its id.
	 * Without it nothing is investigated.
	 */
	investigate?(checkout: string | null, title: string, prompt: string): Promise<string>;
	/** Stand-in for the real build (tests). */
	build?: typeof buildPlayable;
}

const headOf = (root: string) => {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return undefined;
	}
};

export class PlayBuildService {
	private readonly current = new Map<string, PlayBuild>();
	private building: string | null = null;
	/** The step each checkout's last build was on: where a failure happened. */
	private readonly lastStep = new Map<string, string>();

	constructor(private readonly d: PlayBuildDeps) {}

	/** A checkout's build folder: per checkout folder, so another project's "main" never shares one. */
	dirOf(checkout: string): string {
		const root = this.d.checkoutRoot(checkout);
		return join(this.d.dataDir, createHash("sha1").update(root).digest("hex").slice(0, 16));
	}

	status(checkout: string): PlayBuild {
		const now = this.current.get(checkout);
		if (now?.state === "building" || now?.state === "failed") return { ...now, head: headOf(this.d.checkoutRoot(checkout)) };
		const record = join(this.dirOf(checkout), "play.json");
		const built = existsSync(record) ? (JSON.parse(readFileSync(record, "utf8")) as { builtAt: string; commit?: string }) : undefined;
		return { checkout, state: built ? "ready" : "none", ...built, head: headOf(this.d.checkoutRoot(checkout)) };
	}

	/** Starts a build and returns at once; progress arrives as `play_build` events. One at a time: the compiler is heavy. */
	build(checkout: string): void {
		if (this.building) throw new Error(this.building === checkout ? "It's being built already" : "Another build is running: wait for it to finish");
		const root = this.d.checkoutRoot(checkout);
		const out = this.dirOf(checkout);
		const commit = headOf(root);
		this.building = checkout;
		const set = (b: PlayBuild) => {
			this.current.set(checkout, b);
			this.d.emit({ type: "play_build", build: { ...b, head: commit } });
		};
		const step = (s: string) => {
			this.lastStep.set(checkout, s);
			set({ checkout, state: "building", step: s });
		};
		step("Starting");
		(this.d.build ?? buildPlayable)({ root, projectName: this.d.projectName(), engineRepo: this.d.engineRepo(), out, onProgress: step })
			.then(() => {
				const builtAt = new Date().toISOString();
				writeFileSync(join(out, "play.json"), `${JSON.stringify({ builtAt, commit })}\n`);
				set({ checkout, state: "ready", builtAt, commit });
			})
			.catch((err: unknown) => set({ checkout, state: "failed", error: err instanceof Error ? err.message : String(err) }))
			.finally(() => {
				this.building = null;
			});
	}

	/**
	 * Starts a session to fix a failed build, so a failure seen away from the desk isn't a dead end. Once per failure:
	 * asked again, it's the same session. Building again forgets it.
	 */
	async investigate(checkout: string): Promise<string> {
		if (!this.d.investigate) throw new Error("Sessions can't be started from here");
		const failed = this.current.get(checkout);
		if (failed?.state !== "failed") throw new Error("There's no failed build to look into");
		if (failed.investigation) return failed.investigation;
		const where = checkout === "main" ? "main" : "this worktree";
		const id = await this.d.investigate(checkout === "main" ? null : checkout, checkout === "main" ? "Fix main's web build" : "Fix the web build", playBrief(this.d.projectName(), where, this.lastStep.get(checkout), failed.error ?? ""));
		const now = this.current.get(checkout);
		// A build started meanwhile replaced the failure: the session still runs, but it's no longer this build's.
		if (now === failed) {
			const b = { ...failed, investigation: id };
			this.current.set(checkout, b);
			this.d.emit({ type: "play_build", build: { ...b, head: headOf(this.d.checkoutRoot(checkout)) } });
		}
		return id;
	}
}

/** What a session is told about a failed play build. */
export function playBrief(name: string, where: "main" | "this worktree", step: string | undefined, error: string): string {
	return [
		`The remote page's Play remotely built ${name} for the web from ${where}, and the build failed: there's nothing to play.`,
		step ? `It failed at the step "${step}".` : "",
		`The error:\n${error}`,
		"How it's built: the studio links the engine, copies the files the newest release in release.json ships (or the defaults without one) into an assets folder, then runs `engine/tools/web.sh game <out> <assets>` (Odin for wasm, Emscripten, WebGL 2). It's a test build: no version, archive or checks.",
		`Find the cause and fix it in this worktree${where === "main" ? " (it reaches main when merged)" : ""}. To confirm, build it the same way from the worktree's root, which must finish without errors: \`out=$(mktemp -d); engine/tools/web.sh game "$out" assets; rm -rf "$out"\`.`,
		"Then report what was wrong and what you changed. If the cause is outside the game (the engine, the studio's build steps, a tool missing on this machine), say so plainly rather than working around it in the game.",
	]
		.filter(Boolean)
		.join("\n\n");
}
