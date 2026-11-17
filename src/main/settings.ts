import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Settings } from "../shared/types";

export function defaultSettings(): Settings {
	const home = homedir();
	return {
		engineRepo: join(home, "Projects/headless-game-engine"),
		studioRepo: join(home, "Projects/game-studio"),
		worktreeRoot: join(home, ".local/share/game-studio/worktrees"),
		recentProjects: [],
	};
}

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
	}

	get(): Settings {
		return structuredClone(this.value);
	}

	update(patch: Partial<Settings>): Settings {
		this.value = { ...this.value, ...patch };
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, `${JSON.stringify(this.value, null, "\t")}\n`);
		return this.get();
	}

	rememberProject(path: string): void {
		const recent = [path, ...this.value.recentProjects.filter((p) => p !== path)].slice(0, 10);
		this.update({ recentProjects: recent, lastProject: path });
	}
}
