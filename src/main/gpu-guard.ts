// Sharing the GPU with everything else on the machine. A model worker needs most of the 10 GB card, so:
// - one Game Studio at a time may hold a model worker: a lock file in the generation folder (shared by every studio
//   on this machine: the installed one, a development run, a studio session's own copy), cleared when its holder
//   has died;
// - a model is only loaded when the card has the memory it needs free (a game, or another app, may be using it).
//   What a family needs is learned from the peaks its workers report (peak_vram_gib), with cautious defaults first.
import { execFile } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GenFamily } from "../shared/gen";

const run = promisify(execFile);

/** Before a family's peak is known (GiB, with offloading where the worker uses it); measured peaks replace these. */
const DEFAULT_NEED_GIB: Record<GenFamily, number> = { image: 6, hunyuan3d: 7, unirig: 5, "stable-audio": 3, voice: 4, surface: 0 };
/** Headroom above a measured peak: fragmentation and the CUDA context. */
const MARGIN_GIB = 0.75;

export class GpuGuard {
	private held = false;

	constructor(
		private readonly root: string,
		/** Free memory on the card (GiB), or null when it can't be read (no NVIDIA tools): then there's no check. */
		private readonly freeGib: () => Promise<number | null> = nvidiaFreeGib,
	) {
		live.add(this);
	}

	private get lockFile(): string {
		return join(this.root, "gpu.lock");
	}

	/** Takes the machine's GPU lock; false when another live studio holds it. */
	tryLock(): boolean {
		if (this.held) return true;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(this.lockFile, "wx");
				writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
				closeSync(fd);
				this.held = true;
				return true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
				const holder = this.holder();
				if (holder !== null && holder !== process.pid && alive(holder)) return false;
				// Ours from before, or left by a studio that died: take it over.
				try {
					unlinkSync(this.lockFile);
				} catch {
					// another studio cleared it first
				}
			}
		}
		return false;
	}

	release(): void {
		if (!this.held) return;
		this.held = false;
		if (this.holder() === process.pid) {
			try {
				unlinkSync(this.lockFile);
			} catch {
				// already gone
			}
		}
	}

	/** The process holding the lock, if any. */
	holder(): number | null {
		try {
			return Number(JSON.parse(readFileSync(this.lockFile, "utf8")).pid) || null;
		} catch {
			return null;
		}
	}

	/** GiB a family's worker needs free before it loads: its largest measured peak plus a margin, else the default. */
	need(family: GenFamily): number {
		const peak = this.peaks()[family];
		return peak ? Math.round((peak + MARGIN_GIB) * 10) / 10 : DEFAULT_NEED_GIB[family];
	}

	/** Remembers a job's measured peak (the worker reports it with each result). */
	recordPeak(family: GenFamily, gib: number): void {
		const peaks = this.peaks();
		if (!(gib > (peaks[family] ?? 0))) return;
		peaks[family] = gib;
		writeFileSync(join(this.root, "vram-peaks.json"), `${JSON.stringify(peaks, null, "\t")}\n`);
	}

	/** Free memory on the card, null when unknown. */
	free(): Promise<number | null> {
		return this.freeGib().catch(() => null);
	}

	private peaks(): Partial<Record<GenFamily, number>> {
		const file = join(this.root, "vram-peaks.json");
		try {
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Record<GenFamily, number>>) : {};
		} catch {
			return {};
		}
	}
}

/** A studio that exits gives back the lock it holds (one listener for every guard). */
const live = new Set<GpuGuard>();
process.once("exit", () => {
	for (const g of live) g.release();
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function nvidiaFreeGib(): Promise<number | null> {
	const { stdout } = await run("nvidia-smi", ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { timeout: 5000 });
	const mib = Number(stdout.trim().split("\n")[0]);
	return Number.isFinite(mib) ? mib / 1024 : null;
}
