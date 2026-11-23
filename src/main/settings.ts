import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Settings } from "../shared/types";
import { writeJsonAtomic } from "./json-file";

export function defaultSettings(): Settings {
	const home = homedir();
	return {
		engineRepo: join(home, "Projects/headless-game-engine"),
		studioRepo: join(home, "Projects/game-studio"),
		worktreeRoot: join(home, ".local/share/game-studio/worktrees"),
		recentProjects: [],
	};
}

/** A project folder's path in one spelling: absolute, with no trailing slash. */
export const projectPath = (path: string) => resolve(path);

const uniqueProjects = (paths: string[]) => [...new Set(paths.filter((p) => typeof p === "string" && p.trim()).map(projectPath))];

/** Settings persisted as JSON in the app's userData folder. */
export class SettingsStore {
	private value: Settings;

	constructor(private readonly file: string) {
		let saved: Partial<Settings> = {};
		try {
			saved = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// first run, or unreadable: fall back to defaults
		}
		this.value = { ...defaultSettings(), ...saved };
		// One folder, one entry: "/games/cave/" and "/games/cave" used to be remembered as two projects.
		this.value.recentProjects = uniqueProjects(Array.isArray(this.value.recentProjects) ? this.value.recentProjects : []);
		if (this.value.lastProject) this.value.lastProject = projectPath(this.value.lastProject);
	}

	get(): Settings {
		return structuredClone(this.value);
	}

	update(patch: Partial<Settings>): Settings {
		this.value = { ...this.value, ...patch };
		mkdirSync(dirname(this.file), { recursive: true });
		writeJsonAtomic(this.file, this.value);
		return this.get();
	}

	rememberProject(path: string): void {
		const p = projectPath(path);
		this.update({ recentProjects: uniqueProjects([p, ...this.value.recentProjects]).slice(0, 10), lastProject: p });
	}

	/** Takes a project off the recent list (its folder isn't touched). */
	forgetProject(path: string): void {
		const p = projectPath(path);
		this.update({ recentProjects: this.value.recentProjects.filter((x) => projectPath(x) !== p), ...(this.value.lastProject === p ? { lastProject: undefined } : {}) });
	}
}
