// Game projects: opening one, and creating one from templates/game.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { addStandardDocs } from "./design-docs";
import { basename, join } from "node:path";
import type { ProjectInfo } from "../shared/types";
import { git, hasCommits, isRepo } from "./git";
import { ensureStudioIgnore, linkEngineLibs } from "./sessions";

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
	// Binary assets (models, textures, audio) go to Git LFS; see the template's gitattributes. --local keeps the
	// LFS hooks and filters in this repo instead of the user's global git config.
	await git(path, ["lfs", "install", "--local"]).catch(() => {
		throw new Error("Git LFS is required for game projects: install git-lfs, then try again");
	});

	cpSync(templateDir, path, { recursive: true });
	renameSync(join(path, "gitignore"), join(path, ".gitignore"));
	renameSync(join(path, "gitattributes"), join(path, ".gitattributes"));
	fillPlaceholders(path, { name });
	addStandardDocs(path);
	chmodSync(join(path, "build.sh"), 0o755);
	for (const dir of ASSET_DIRS) {
		mkdirSync(join(path, "assets", dir), { recursive: true });
		writeFileSync(join(path, "assets", dir, ".gitkeep"), "");
	}
	mkdirSync(join(path, ".studio/sessions"), { recursive: true });
	writeFileSync(join(path, ".studio/sessions/.gitkeep"), "");
	ensureStudioIgnore(path);
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

/**
 * Gives a project that only exists on this machine a remote and pushes its branch there (Source Control → Publish).
 * Refuses first if the engine commit the game pins isn't on the engine's remote: a clone of the game elsewhere
 * couldn't fetch it. If the push fails, the remote isn't kept, so trying again starts clean.
 */
export async function publishProject(path: string, url: string): Promise<void> {
	url = url.trim();
	if (!url) throw new Error("Give the URL of an empty remote repository");
	if ((await git(path, ["remote"])).trim()) throw new Error("This project already has a remote: use Push");
	const branch = (await git(path, ["branch", "--show-current"])).trim();
	if (!branch) throw new Error("The project isn't on a branch");
	const engine = join(path, "engine");
	if (existsSync(join(engine, ".git"))) {
		const pinned = (await git(engine, ["rev-parse", "HEAD"])).trim();
		await git(engine, ["fetch", "-q", "origin"]).catch((err: Error) => {
			throw new Error(`Couldn't reach the engine's remote to check it has the engine this game uses: ${err.message}`);
		});
		if (!(await git(engine, ["branch", "-r", "--contains", pinned])).trim()) {
			throw new Error(`The engine commit this game uses (${pinned.slice(0, 7)}) isn't on the engine's remote yet: push the engine first, or a copy of the game cloned elsewhere couldn't fetch it`);
		}
	}
	await git(path, ["remote", "add", "origin", url]);
	try {
		await git(path, ["push", "-q", "-u", "origin", branch]);
	} catch (err) {
		await git(path, ["remote", "remove", "origin"]).catch(() => {});
		throw new Error(`The push failed, so the remote wasn't kept: ${(err as Error).message}`);
	}
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
