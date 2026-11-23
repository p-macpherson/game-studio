// Updates for the stable install (~/.local/share/game-studio/app, made by install/install.sh): which pushed commits
// are newer than this copy, preparing the next version in the background (install/game-studio-update --prepare:
// clone, install, build and a startup check into app-next) and restarting into it (--apply-after: the script waits for this
// process to exit, swaps the copies and reopens the studio). A development checkout has no updates.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { StudioEvent } from "../shared/ipc";
import type { UpdateStatus } from "../shared/types";

const run = promisify(execFile);

export class UpdateService {
	private readonly base: string | null;
	private state: UpdateStatus;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly appRoot: string,
		private readonly emit: (e: StudioEvent) => void,
	) {
		// Installed when this copy is <home>/app beside <home>/bin/game-studio-update.
		const home = dirname(appRoot);
		this.base = basename(appRoot) === "app" && existsSync(join(home, "bin/game-studio-update")) ? home : null;
		this.state = { installed: !!this.base, current: null, available: [], phase: "idle", log: [] };
	}

	/** Checks now, then every six hours (only for an installed copy). */
	start(): void {
		void this.check().catch(() => {});
		if (this.base) this.timer = setInterval(() => void this.check().catch(() => {}), 6 * 3600_000);
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}

	status(): UpdateStatus {
		return structuredClone(this.state);
	}

	/** Fetches origin and lists its main's commits that this copy doesn't have (first parents: merges, not their insides). */
	async check(): Promise<UpdateStatus> {
		const git = (...args: string[]) => run("git", ["-C", this.appRoot, ...args], { encoding: "utf8" }).then((r) => r.stdout.trim());
		const head = (await git("log", "-1", "--format=%h%x09%s%x09%cI").catch(() => "")).split("\t");
		this.state.current = head[0] ? { commit: head[0], subject: head[1], date: head[2] } : null;
		if (this.base) {
			try {
				await git("fetch", "-q", "origin", "main");
				const log = await git("log", "--first-parent", "--format=%h%x09%s%x09%cI", "HEAD..origin/main");
				this.state.available = log ? log.split("\n").map((l) => ({ commit: l.split("\t")[0], subject: l.split("\t")[1], date: l.split("\t")[2] })) : [];
				this.state.checkedAt = new Date().toISOString();
				this.state.error = undefined;
			} catch (err) {
				this.state.error = `Couldn't check for updates: ${(err as Error).message.split("\n")[0]}`;
			}
		}
		this.changed();
		return this.status();
	}

	/** Builds the newest version beside this one and checks it starts; the studio keeps running meanwhile. */
	async prepare(): Promise<UpdateStatus> {
		if (!this.base) throw new Error("This studio runs from a development checkout: it has no updates");
		if (this.state.phase === "preparing") return this.status();
		this.state = { ...this.state, phase: "preparing", log: [], error: undefined };
		this.changed();
		const ok = await new Promise<boolean>((resolve) => {
			const child = spawn(join(this.base!, "bin/game-studio-update"), ["--prepare"], { stdio: ["ignore", "pipe", "pipe"] });
			const line = (d: Buffer) => {
				for (const l of d.toString().split("\n")) if (l.trim()) this.state.log.push(l.trim());
				this.state.log = this.state.log.slice(-200);
				this.changed();
			};
			child.stdout.on("data", line);
			child.stderr.on("data", line);
			child.on("error", (e) => (this.state.log.push(String(e)), resolve(false)));
			child.on("close", (code) => resolve(code === 0));
		});
		const prepared = join(this.base, "app-next/.prepared");
		if (ok && existsSync(prepared)) {
			this.state.phase = "ready";
			this.state.prepared = readFileSync(prepared, "utf8").trim().slice(0, 7);
		} else {
			this.state.phase = ok ? "idle" : "failed";
			if (!ok) this.state.error = "The update didn't build or didn't start; this version stays. The log shows why.";
		}
		this.changed();
		return this.status();
	}

	/** Hands over to the updater, which waits for this process to exit, switches versions and reopens the studio. */
	restart(quit: () => void): void {
		if (!this.base || this.state.phase !== "ready") throw new Error("No update is ready");
		spawn(join(this.base, "bin/game-studio-update"), ["--apply-after", String(process.pid), "--relaunch"], { detached: true, stdio: "ignore" }).unref();
		quit();
	}

	private changed(): void {
		this.emit({ type: "update_status", status: this.status() });
	}
}
