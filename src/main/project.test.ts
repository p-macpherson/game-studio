import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject, readProject } from "./project";
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

	it("refuses a folder that isn't empty", async () => {
		const root = tempDir();
		const engineRepo = makeRepo(join(root, "engine"));
		const path = join(root, "busy");
		makeRepo(path);
		writeFileSync(join(path, "x.txt"), "");
		await expect(createProject({ path, name: "x", templateDir, engineRepo })).rejects.toThrow(/not empty/);
	});
});
