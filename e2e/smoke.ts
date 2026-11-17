// End-to-end: drives the built app through creating a project and a full session lifecycle with the
// scripted faux/echo model. Uses a temp user-data dir, temp worktree root and temp project; the engine repo
// from default settings is only read (cloned as the project's submodule).
// Run: npm run build && node e2e/smoke.ts [screenshot-dir]
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type Page } from "playwright";

const shots = resolve(process.argv[2] ?? "out/e2e");
mkdirSync(shots, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "game-studio-e2e-"));
const userData = join(root, "user-data");
const projectPath = join(root, "e2e-game");
mkdirSync(userData);
writeFileSync(
	join(userData, "settings.json"),
	JSON.stringify({
		engineRepo: process.env.ENGINE_REPO ?? join(homedir(), "Projects/headless-game-engine"),
		studioRepo: resolve("."),
		worktreeRoot: join(root, "worktrees"),
		recentProjects: [],
	}),
);

const app = await electron.launch({ args: ["."], env: { ...process.env, GAME_STUDIO_USER_DATA: userData, GAME_STUDIO_FAUX: "1" } });
const step = async (name: string, page: Page) => {
	await page.screenshot({ path: join(shots, `${name}.png`) });
	console.log(`✓ ${name}`);
};

try {
	const page = await app.firstWindow();
	page.on("dialog", (d) => void d.accept());
	page.on("pageerror", (err) => console.error("renderer error:", err.stack));
	page.on("console", (m) => m.type() === "error" && console.error("renderer console:", m.text()));
	await page.setViewportSize({ width: 1440, height: 900 });

	// Create a project from the template.
	await page.getByRole("button", { name: "New project…" }).click();
	await page.getByPlaceholder("/home/…/my-game").fill(projectPath);
	await page.locator(".modal input").nth(1).fill("E2E Game");
	await page.getByRole("button", { name: "Create project" }).click();
	await page.locator(".project-name", { hasText: "E2E Game" }).waitFor({ timeout: 60_000 });
	await step("01-project", page);

	// Start a session with the faux model.
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.getByTestId("new-session-prompt").fill("add a note");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByTestId("chat").getByText("Noted: add a note").waitFor();
	await step("02-session-idle", page);

	await page.getByRole("button", { name: "Changes" }).click();
	await page.locator(".diff .add", { hasText: "+add a note" }).waitFor();
	await step("03-changes", page);

	// Merge: done sessions are hidden by default.
	await page.getByRole("button", { name: "Merge" }).click();
	await page.locator(".session-items .empty").waitFor();
	if (readFileSync(join(projectPath, "faux-notes.md"), "utf8") !== "add a note\n") throw new Error("merge did not reach main");
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await page.getByTestId("session-item").getByText("Done · merged").waitFor();
	await page.getByTestId("session-item").click();
	await step("04-merged", page);

	// Resume and keep talking.
	await page.getByRole("button", { name: "Resume" }).click();
	await page.locator(".session-detail .status-idle").waitFor();
	await page.getByRole("button", { name: "Chat" }).click();
	await page.getByTestId("composer").fill("second note");
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText("Noted: second note").waitFor({ timeout: 30_000 });
	await page.locator(".session-detail .status-idle").waitFor();
	await step("05-resumed", page);

	// Source control and accounts render.
	await page.getByRole("button", { name: "Source Control" }).click();
	await page.locator(".list-row", { hasText: "studio: session" }).first().waitFor();
	await page.locator("code", { hasText: "⎇ main" }).waitFor();
	await step("06-source-control", page);
	await page.getByRole("button", { name: "Accounts" }).click();
	await page.getByText("Available models").waitFor();
	await step("07-accounts", page);
	console.log(`passed; screenshots in ${shots}`);
} catch (err) {
	const page = await app.firstWindow();
	await page.screenshot({ path: join(shots, "failed.png") });
	console.error(`failed; see ${join(shots, "failed.png")}`);
	throw err;
} finally {
	await app.close();
}
