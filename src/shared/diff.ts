// A unified diff (git's) as files, hunks and numbered lines, for the Worktrees page's Changes view.

export interface DiffLine {
	kind: "context" | "add" | "del";
	/** Line numbers in the old and the new file (absent on the side the line isn't in). */
	old?: number;
	new?: number;
	text: string;
}

export interface DiffHunk {
	/** What git names after the range: usually the enclosing function or heading. */
	context: string;
	lines: DiffLine[];
}

export interface DiffFile {
	path: string;
	/** Where it was, when it was moved or renamed. */
	from?: string;
	change: "added" | "modified" | "deleted" | "renamed";
	/** Not text (an image, a model, audio…): there are no lines to show. */
	binary: boolean;
	/** Its size in bytes now, when git says (a file kept in Git LFS). */
	size?: number;
	added: number;
	removed: number;
	hunks: DiffHunk[];
}

export function parseDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | null = null;
	let hunk: DiffHunk | null = null;
	let oldNo = 0;
	let newNo = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("diff --git ")) {
			// "a/<path> b/<path>": the same path twice unless it was renamed (then "rename to" says).
			const rest = line.slice("diff --git ".length);
			const path = rest.length % 2 === 1 ? rest.slice((rest.length - 5) / 2 + 5) : rest.slice(rest.lastIndexOf(" b/") + 3);
			file = { path, change: "modified", binary: false, added: 0, removed: 0, hunks: [] };
			files.push(file);
			hunk = null;
			continue;
		}
		if (!file) continue;
		if (!hunk) {
			if (line.startsWith("new file mode")) file.change = "added";
			else if (line.startsWith("deleted file mode")) file.change = "deleted";
			else if (line.startsWith("rename from ")) {
				file.from = line.slice("rename from ".length);
				file.change = "renamed";
			} else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
			else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) file.binary = true;
			else if (line.startsWith("+++ b/")) file.path = line.slice(6);
			else if (line.startsWith("--- a/") && file.change === "deleted") file.path = line.slice(6);
		}
		const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
		if (range) {
			oldNo = Number(range[1]);
			newNo = Number(range[2]);
			hunk = { context: range[3], lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (!hunk) continue;
		if (line.startsWith("+")) {
			hunk.lines.push({ kind: "add", new: newNo++, text: line.slice(1) });
			file.added++;
		} else if (line.startsWith("-")) {
			hunk.lines.push({ kind: "del", old: oldNo++, text: line.slice(1) });
			file.removed++;
		} else if (line.startsWith(" ")) hunk.lines.push({ kind: "context", old: oldNo++, new: newNo++, text: line.slice(1) });
		// "\ No newline at end of file" and the blank after the last line: nothing to show.
	}
	// A file kept in Git LFS diffs as its three-line pointer: that's a binary file, not text to read.
	for (const f of files) {
		const all = f.hunks.flatMap((h) => h.lines);
		if (!all.some((l) => l.text.startsWith("version https://git-lfs.github.com/spec/"))) continue;
		const size = all.find((l) => l.kind !== "del" && l.text.startsWith("size "));
		Object.assign(f, { binary: true, hunks: [], added: 0, removed: 0, ...(size ? { size: Number(size.text.slice(5)) } : {}) });
	}
	return files;
}
