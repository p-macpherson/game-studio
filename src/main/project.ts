// Game projects: opening one, and creating one from templates/game.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProjectInfo } from "../shared/types";
import { git, hasCommits, isRepo } from "./git";
import { linkEngineLibs } from "./sessions";

export const PROJECT_FILE = ".studio/project.json";
const ASSET_DIRS = ["models", "textures", "music", "sounds", "scenes", "prefabs"];

export function readProject(path: string): ProjectInfo {
	const file = join(path, PROJECT_FILE);
	if (!existsSync(file)) throw new Error(`${path} is not a Game Studio project (no ${PROJECT_FILE})`);
	const { name } = JSON.parse(readFileSync(file, "utf8")) as { name?: string };
	return { path, name: name || basename(path) };
}

/**
 * Scaffolds a game project into `path`, which must be empty or contain only an empty git repo. Adds the
 * engine as the `engine/` submodule (cloned from the local engine checkout, recorded with its origin URL)
 * and makes the initial commit.
 */
export async function createProject(opts: { path: string; name: string; templateDir: string; engineRepo: string }): Promise<ProjectInfo> {
	const { path, name, templateDir, engineRepo } = opts;
	mkdirSync(path, { recursive: true });
	const existing = readdirSync(path).filter((f) => f !== ".git");
	if (existing.length > 0) throw new Error(`${path} is not empty`);
	if (existsSync(join(path, ".git"))) {
		if (await hasCommits(path)) throw new Error(`${path} already has commits; projects must start empty`);
	} else {
		await git(path, ["init", "-q", "-b", "main"]);
	}
	if (!(await isRepo(engineRepo))) throw new Error(`engine repo not found at ${engineRepo} (check Settings)`);

	cpSync(templateDir, path, { recursive: true });
	renameSync(join(path, "gitignore"), join(path, ".gitignore"));
	fillPlaceholders(path, { name });
	chmodSync(join(path, "build.sh"), 0o755);
	for (const dir of ASSET_DIRS) {
		mkdirSync(join(path, "assets", dir), { recursive: true });
		writeFileSync(join(path, "assets", dir, ".gitkeep"), "");
	}
	mkdirSync(join(path, ".studio/sessions"), { recursive: true });
	writeFileSync(join(path, ".studio/sessions/.gitkeep"), "");
	writeFileSync(join(path, PROJECT_FILE), `${JSON.stringify({ name, formatVersion: 1, createdAt: new Date().toISOString() }, null, "\t")}\n`);

	await git(path, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", engineRepo, "engine"]);
	const origin = await git(engineRepo, ["remote", "get-url", "origin"]).then((s) => s.trim(), () => "");
	if (origin) {
		await git(path, ["submodule", "set-url", "engine", origin]);
		await git(join(path, "engine"), ["remote", "set-url", "origin", origin]);
	}
	await linkEngineLibs(join(path, "engine"), engineRepo);
	await git(path, ["add", "-A"]);
	await git(path, ["commit", "-q", "-m", `Create ${name} with Game Studio`]);
	return { path, name };
}

function fillPlaceholders(dir: string, values: Record<string, string>): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry !== ".git") fillPlaceholders(full, values);
			continue;
		}
		const text = readFileSync(full, "utf8");
		const filled = text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m);
		if (filled !== text) writeFileSync(full, filled);
	}
}
