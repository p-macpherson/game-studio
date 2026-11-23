import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, forkProject, publishProject, readProject } from "./project";
import { DESIGN_DOCS, docPath, parseDoc } from "../shared/design-docs";
import { readDesignDocs } from "./design-docs";
import { makeRepo, sh, tempDir } from "./test-helpers";

const templateDir = resolve("templates/game");

describe("createProject", () => {
	it("scaffolds the template into an empty repo with the engine as a submodule", async () => {
		const root = tempDir();
		const engineRepo = makeRepo(join(root, "engine"), {
			"engine/engine/app.odin": "package engine\n",
			".gitignore": "/third_party/lib/\n",
			"third_party/deps.sh": "",
		});
		sh(engineRepo, "remote", "add", "origin", "https://example.com/engine.git");
		mkdirSync(join(engineRepo, "third_party/lib"));
		writeFileSync(join(engineRepo, "third_party/lib/libraylib.a"), "built");
		const path = join(root, "my-game");
		mkdirSync(path);
		sh(path, "init", "-q", "-b", "main");
		sh(path, "config", "user.email", "test@example.com");
		sh(path, "config", "user.name", "Test");

		const info = await createProject({ path, name: "My Game", templateDir, engineRepo });

		expect(info).toEqual({ path, name: "My Game" });
		expect(readProject(path).name).toBe("My Game");
		expect(readFileSync(join(path, "game/main.odin"), "utf8")).toContain('title = "My Game"');
		// Every standard design doc, not established yet.
		expect(readDesignDocs(path).map((d) => [d.path, parseDoc(d.text).status])).toEqual(DESIGN_DOCS.map((d) => [docPath(d), "not-established"]).sort());
		expect(statSync(join(path, "build.sh")).mode & 0o111).toBeTruthy();
		expect(existsSync(join(path, ".gitignore"))).toBe(true);
		expect(existsSync(join(path, "engine/engine/engine/app.odin"))).toBe(true);
		expect(readFileSync(join(path, ".gitmodules"), "utf8")).toContain("https://example.com/engine.git");
		// Built engine libraries are shared by symlink without dirtying the submodule.
		expect(readFileSync(join(path, "engine/third_party/lib/libraylib.a"), "utf8")).toBe("built");
		expect(sh(path, "status", "--porcelain")).toBe("");
		expect(sh(path, "log", "--format=%s")).toBe("Create My Game with Game Studio\n");

		// Binary assets are committed as Git LFS pointers.
		writeFileSync(join(path, "assets/textures/brick.png"), "\x89PNG fake image data");
		sh(path, "add", "assets/textures/brick.png");
		sh(path, "commit", "-q", "-m", "texture");
		expect(sh(path, "lfs", "ls-files", "--name-only")).toBe("assets/textures/brick.png\n");
		expect(sh(path, "show", "HEAD:assets/textures/brick.png")).toContain("version https://git-lfs.github.com/spec/v1");
	});

	it("forks a project from its main branch alone: no worktrees, other branches, sessions, remote or uncommitted edits", async () => {
		const root = tempDir();
		const engineRepo = makeRepo(join(root, "engine"), { "engine/engine/app.odin": "package engine\n" });
		const source = join(root, "cave-game");
		mkdirSync(source);
		sh(source, "init", "-q", "-b", "main");
		sh(source, "config", "user.email", "test@example.com");
		sh(source, "config", "user.name", "Test");
		await createProject({ path: source, name: "Cave Game", templateDir, engineRepo });
		// On main: a binary asset (LFS), and the studio's records of a worktree and a session.
		const image = "\x89PNG real image bytes, not a pointer";
		writeFileSync(join(source, "assets/textures/brick.png"), image);
		mkdirSync(join(source, ".studio/worktrees"), { recursive: true });
		writeFileSync(join(source, ".studio/worktrees/w1.json"), "{}");
		mkdirSync(join(source, ".studio/sessions/s1"), { recursive: true });
		writeFileSync(join(source, ".studio/sessions/s1/session.json"), "{}");
		sh(source, "add", "-A");
		sh(source, "commit", "-q", "-m", "a texture and some records");
		sh(source, "remote", "add", "origin", "https://example.com/cave-game.git");
		// Not on main: a worktree's branch, and an edit that was never committed.
		sh(source, "branch", "studio/w1");
		sh(source, "checkout", "-q", "studio/w1");
		writeFileSync(join(source, "game/secret.odin"), "package game\n");
		sh(source, "add", "-A");
		sh(source, "commit", "-q", "-m", "worktree work");
		sh(source, "checkout", "-q", "main");
		writeFileSync(join(source, "game/unsaved.odin"), "package game\n");

		const path = join(root, "cave-game-2");
		const info = await forkProject({ source, path, name: "Cave Game 2", engineRepo });

		expect(info).toEqual({ path, name: "Cave Game 2" });
		expect(readProject(path).name).toBe("Cave Game 2");
		expect(JSON.parse(readFileSync(join(path, ".studio/project.json"), "utf8")).forkedFrom.name).toBe("Cave Game");
		expect(readFileSync(join(path, "game/main.odin"), "utf8")).toContain('title = "Cave Game 2"');
		// Main's files, binary ones as real files, and the engine.
		expect(readFileSync(join(path, "assets/textures/brick.png"), "utf8")).toBe(image);
		expect(existsSync(join(path, "engine/engine/engine/app.odin"))).toBe(true);
		// Nothing from outside main.
		expect(sh(path, "branch", "--format=%(refname:short)")).toBe("main\n");
		expect(sh(path, "remote")).toBe("");
		expect(existsSync(join(path, "game/secret.odin"))).toBe(false);
		expect(existsSync(join(path, "game/unsaved.odin"))).toBe(false);
		expect(existsSync(join(path, ".studio/worktrees"))).toBe(false);
		expect(existsSync(join(path, ".studio/sessions/s1"))).toBe(false);
		expect(sh(path, "status", "--porcelain")).toBe("");
		expect(sh(path, "log", "-1", "--format=%s")).toBe("Fork Cave Game as Cave Game 2\n");
		// The original is untouched, and a folder that isn't empty is refused.
		expect(sh(source, "status", "--porcelain")).toContain("game/unsaved.odin");
		await expect(forkProject({ source, path, name: "Again", engineRepo })).rejects.toThrow("is not empty");
	});

	it("publishes a local-only project to a new remote once the engine commit it pins is on the engine's remote", async () => {
		const root = tempDir();
		const engineRepo = makeRepo(join(root, "engine"), { "engine/engine/app.odin": "package engine\n" });
		const engineRemote = join(root, "engine.git");
		sh(root, "init", "-q", "--bare", engineRemote);
		sh(engineRepo, "remote", "add", "origin", engineRemote);
		sh(engineRepo, "push", "-q", "origin", "HEAD:main");
		writeFileSync(join(engineRepo, "new.odin"), "package engine\n");
		sh(engineRepo, "add", "-A");
		sh(engineRepo, "commit", "-q", "-m", "not pushed yet");
		const path = join(root, "game");
		mkdirSync(path);
		sh(path, "init", "-q", "-b", "main");
		sh(path, "config", "user.email", "test@example.com");
		sh(path, "config", "user.name", "Test");
		await createProject({ path, name: "Game", templateDir, engineRepo });
		const gameRemote = join(root, "game.git");
		sh(root, "init", "-q", "--bare", gameRemote);

		// The game pins an engine commit only this machine has: nothing is added or pushed.
		await expect(publishProject(path, gameRemote)).rejects.toThrow(/isn't on the engine's remote yet/);
		expect(sh(path, "remote").trim()).toBe("");

		// A failed push doesn't leave a half-set-up remote behind.
		sh(engineRepo, "push", "-q", "origin", "HEAD:main");
		await expect(publishProject(path, join(root, "missing.git"))).rejects.toThrow(/push failed/);
		expect(sh(path, "remote").trim()).toBe("");

		await publishProject(path, gameRemote);
		expect(sh(path, "rev-parse", "--abbrev-ref", "main@{upstream}").trim()).toBe("origin/main");
		expect(sh(gameRemote, "log", "--format=%s", "main")).toBe("Create Game with Game Studio\n");
		await expect(publishProject(path, gameRemote)).rejects.toThrow(/already has a remote/);
	});

	it("refuses a folder that isn't empty", async () => {
		const root = tempDir();
		const engineRepo = makeRepo(join(root, "engine"));
		const path = join(root, "busy");
		makeRepo(path);
		writeFileSync(join(path, "x.txt"), "");
		await expect(createProject({ path, name: "x", templateDir, engineRepo })).rejects.toThrow(/not empty/);
	});
});
