// The studio's own small files (session and worktree records, settings): written so that a crash mid-write leaves the
// old file, never half of the new one.
import { renameSync, writeFileSync } from "node:fs";

/** Writes `text` beside `file` and renames it into place (atomic on one filesystem). */
export function writeFileAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown): void {
	writeFileAtomic(file, `${JSON.stringify(value, null, "\t")}\n`);
}
