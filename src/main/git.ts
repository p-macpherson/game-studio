// Thin wrapper over the git CLI. Every function takes the repo (or worktree) directory first.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitCommit, GitStatus } from "../shared/types";

const exec = promisify(execFile);

export class GitError extends Error {}

export async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await exec("git", args, {
			cwd,
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		return stdout;
	} catch (err) {
		const e = err as { stderr?: string; stdout?: string; message: string };
		const detail = (e.stderr || e.stdout || e.message).trim();
		throw new GitError(`git ${args[0]}: ${detail}`);
	}
}

export async function isRepo(dir: string): Promise<boolean> {
	try {
		return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
	} catch {
		return false;
	}
}

export async function hasCommits(dir: string): Promise<boolean> {
	try {
		await git(dir, ["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

export async function currentBranch(dir: string): Promise<string> {
	return (await git(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
}

export async function revParse(dir: string, rev: string): Promise<string> {
	return (await git(dir, ["rev-parse", rev])).trim();
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
	try {
		await git(dir, ["rev-parse", "--verify", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

export async function isAncestor(dir: string, ancestor: string, of: string): Promise<boolean> {
	try {
		await git(dir, ["merge-base", "--is-ancestor", ancestor, of]);
		return true;
	} catch {
		return false;
	}
}

export async function status(dir: string): Promise<GitStatus> {
	// Read-only: no index refresh, so it never holds index.lock while a commit or merge runs in the same checkout.
	const out = await git(dir, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
	const result: GitStatus = { branch: "", ahead: 0, behind: 0, files: [], hasRemote: !!(await git(dir, ["remote"])).trim() };
	const records = out.split("\0");
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		if (r.startsWith("# branch.head ")) result.branch = r.slice(14);
		else if (r.startsWith("# branch.upstream ")) result.upstream = r.slice(18);
		else if (r.startsWith("# branch.ab ")) {
			const [a, b] = r.slice(12).split(" ");
			result.ahead = Number(a.slice(1));
			result.behind = Number(b.slice(1));
		} else if (r.startsWith("1 ") || r.startsWith("u ")) {
			const parts = r.split(" ");
			const fields = r.startsWith("1 ") ? 8 : 10;
			result.files.push({ index: parts[1][0], worktree: parts[1][1], path: parts.slice(fields).join(" ") });
		} else if (r.startsWith("2 ")) {
			const parts = r.split(" ");
			result.files.push({ index: parts[1][0], worktree: parts[1][1], path: parts.slice(9).join(" ") });
			i++; // the original path follows as its own record
		} else if (r.startsWith("? ")) {
			result.files.push({ index: "?", worktree: "?", path: r.slice(2) });
		}
	}
	return result;
}

export async function log(dir: string, limit: number, rev = "HEAD"): Promise<GitCommit[]> {
	if (!(await hasCommits(dir))) return [];
	const out = await git(dir, ["log", `-${limit}`, "--format=%H%x1f%s%x1f%an%x1f%aI", rev]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, subject, author, date] = line.split("\x1f");
			return { hash, subject, author, date };
		});
}

/** Stages everything and commits it; false if there was nothing committable (e.g. only submodule noise). */
export async function commitAll(dir: string, message: string): Promise<boolean> {
	await git(dir, ["add", "-A"]);
	if (!(await git(dir, ["diff", "--cached", "--name-only"])).trim()) return false;
	await git(dir, ["commit", "-q", "-m", message]);
	return true;
}

/** Commits exactly `paths` (staging them first), leaving anything else staged untouched. */
export async function commitPaths(dir: string, paths: string[], message: string): Promise<boolean> {
	await git(dir, ["add", "-A", "--", ...paths]);
	const staged = await git(dir, ["diff", "--cached", "--name-only", "--", ...paths]);
	if (!staged.trim()) return false;
	await git(dir, ["commit", "-q", "-m", message, "--only", "--", ...paths]);
	return true;
}

export async function worktreeAdd(repo: string, path: string, branch: string, startPoint?: string): Promise<void> {
	if (startPoint) await git(repo, ["worktree", "add", "-q", "-b", branch, path, startPoint]);
	else await git(repo, ["worktree", "add", "-q", path, branch]);
}

export async function worktreeRemove(repo: string, path: string): Promise<void> {
	await git(repo, ["worktree", "remove", "--force", path]);
}
