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
		set({ checkout, state: "building", step: "Starting" });
		(this.d.build ?? buildPlayable)({ root, projectName: this.d.projectName(), engineRepo: this.d.engineRepo(), out, onProgress: (step) => set({ checkout, state: "building", step }) })
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
}
