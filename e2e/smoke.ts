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

const app = await electron.launch({
	args: ["."],
	// Faux agent model, and a fake generation backend (fixture outputs, no GPU); Blender runs for real.
	env: { ...process.env, GAME_STUDIO_USER_DATA: userData, GAME_STUDIO_FAUX: "1", GAME_STUDIO_GEN_FAKE: "1", GAME_STUDIO_GEN: join(root, "gen") },
});
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

	// Design Docs: the template's overview is listed and rendered.
	await page.getByRole("button", { name: "Design Docs" }).click();
	const docs = page.getByTestId("asset-item");
	await docs.filter({ hasText: "E2E Game" }).waitFor();
	await page.locator(".markdown h1", { hasText: "E2E Game" }).waitFor();
	await step("08-design-docs", page);

	// "New doc" starts a Project Scoping session; its new doc shows as an unmerged draft.
	await page.getByRole("button", { name: "+ New doc" }).click();
	await page.locator(".agent-type.on", { hasText: "Project Scoping" }).waitFor();
	await page.getByTestId("new-session-prompt").fill("write docs/design/Combat.md: # Combat\n\nHit things. See [the overview](Overview.md).");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByRole("button", { name: "Design Docs" }).click();
	await docs.filter({ hasText: "Combat" }).filter({ hasText: "New, not merged yet" }).click();
	await page.locator(".markdown h1", { hasText: "Combat" }).waitFor();
	await step("09-draft-doc", page);
	await page.locator(".markdown a", { hasText: "the overview" }).click();
	await page.locator(".markdown h1", { hasText: "E2E Game" }).waitFor();

	// Merging the session makes it a regular doc.
	await docs.filter({ hasText: "Combat" }).click();
	await page.getByRole("button", { name: "Open session" }).click();
	await page.getByRole("button", { name: "Merge" }).click();
	await page.locator(".session-detail .status-done").waitFor();
	await page.getByRole("button", { name: "Design Docs" }).click();
	await docs.filter({ hasText: "Combat" }).filter({ hasText: "Hit things." }).waitFor();
	if ((await docs.filter({ hasText: "Combat" }).textContent())?.includes("not merged")) throw new Error("merged doc still a draft");

	// "Discuss / modify" links the session to the doc; its edit shows as a draft of the overview.
	await docs.filter({ hasText: "E2E Game" }).click();
	await page.getByRole("button", { name: "Discuss / modify" }).click();
	await page.locator(".modal code", { hasText: "About docs/design/Overview.md" }).waitFor();
	await page.getByTestId("new-session-prompt").fill("write docs/design/Overview.md: # E2E Game\n\nNow with [combat](Combat.md).");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByRole("button", { name: "Design Docs" }).click();
	await docs.filter({ hasText: "E2E Game" }).filter({ hasText: "1 draft in progress" }).click();
	await page.locator(".version-bar .chip", { hasText: "Draft:" }).click();
	await page.locator(".markdown", { hasText: "Now with combat" }).waitFor();
	await page.getByText("Sessions on this doc").waitFor();
	await step("10-doc-draft-of-existing", page);

	// Game Code lists the template's code.
	const nav = page.locator("nav.sidebar");
	await nav.getByRole("button", { name: "Game Code" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "main.odin" }).waitFor();
	await page.getByTestId("code-view").getByText("package game").first().waitFor();
	await step("11-game-code", page);

	// Play & Test: run the main checkout hidden, streamed into the studio, with the inspector.
	await nav.getByRole("button", { name: "Play & Test" }).click();
	await page.getByRole("button", { name: "▶ Run in studio" }).click();
	await page.getByTestId("run-state").getByText("Running").waitFor({ timeout: 60_000 });
	await page.waitForFunction(() => (document.querySelector("[data-testid=viewport] img") as HTMLImageElement | null)?.naturalWidth === 1280);
	await page.getByTestId("entity").filter({ hasText: "Cube" }).click();
	await page.locator(".entity-detail", { hasText: "Mesh_Renderer" }).waitFor();
	await page.getByTestId("viewport").click();
	await page.keyboard.press("Space");
	await step("12-play", page);
	await page.getByRole("button", { name: "■ Stop" }).click();
	await page.getByTestId("run-state").getByText("Stopped").waitFor();

	// Tests: the template's smoke test passes, with its screenshot.
	await page.getByRole("button", { name: "Tests", exact: true }).click();
	await page.getByRole("button", { name: "▶ Run all" }).click();
	await page.locator(".test-status.pass").waitFor({ timeout: 60_000 });
	await page.locator(".test-head", { hasText: "tests/smoke.jsonl" }).click();
	await page.waitForFunction(() => ((document.querySelector(".shot img") as HTMLImageElement | null)?.naturalWidth ?? 0) > 0);
	await step("13-tests", page);

	// A session's draft that doesn't compile: build its worktree, follow the error into its draft code.
	await nav.getByRole("button", { name: "Game Code" }).click();
	await page.getByRole("button", { name: "+ New feature" }).click();
	await page.getByTestId("new-session-prompt").fill("write game/extra.odin: package game\n\nextra :: proc() {\n\tx := nope\n}\n");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.locator(".session-header").getByRole("button", { name: "▶ Play & Test" }).click();
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await page.getByRole("button", { name: "⚒ Build" }).click();
	await page.getByTestId("run-state").getByText("Build failed").waitFor({ timeout: 60_000 });
	await page.getByRole("button", { name: "Send to session" }).waitFor();
	await step("14-build-failed", page);
	await page.locator(".diagnostic", { hasText: "game/extra.odin:4" }).click();
	await page.locator(".code-line.target", { hasText: "nope" }).waitFor();
	await page.locator(".version-bar .chip.on", { hasText: "Draft:" }).waitFor();
	await step("15-error-in-draft", page);

	// Asset generation: an agent's tools make concepts, then a model; the jobs show in Settings.
	await nav.getByRole("button", { name: "Sessions" }).click();
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.getByTestId("new-session-prompt").fill('tool generate_concept_images {"model": "crate", "prompt": "a wooden crate", "count": 2, "seed": 4}');
	await page.getByRole("button", { name: "Start session" }).click();
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*crate-4\.png/).waitFor({ timeout: 30_000 });
	await page.locator(".session-detail .status-idle").waitFor();
	await page.getByTestId("composer").fill('tool generate_model {"model": "crate", "image": "assets/models/crate/concepts/crate-4.png", "height": 0.6}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*crate\.glb/).waitFor({ timeout: 60_000 });
	await step("16-generation-chat", page);

	// Codemode: a script in the session host's sandbox calls a studio tool (two concept variations at once).
	await page.locator(".session-detail .status-idle").waitFor();
	const code =
		'const r = await Promise.all([1, 2].map((seed) => tools.generate_concept_images({ model: "barrel", prompt: "a barrel", count: 1, seed }))); return "made " + r.length;';
	await page.getByTestId("composer").fill(`tool codemode ${JSON.stringify({ code })}`);
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*made 2/).waitFor({ timeout: 60_000 });
	// preview_model: the agent gets the model as the game's engine draws it.
	await page.locator(".session-detail .status-idle").waitFor();
	await page.getByTestId("composer").fill('tool preview_model {"model": "crate"}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*crate in the game's engine/).waitFor({ timeout: 120_000 });
	await nav.getByRole("button", { name: "Settings" }).click();
	await page.getByTestId("gen-job").filter({ hasText: "Finalize crate" }).filter({ hasText: "done" }).waitFor();
	await page.getByTestId("gen-component").filter({ hasText: "Fake worker" }).waitFor();
	await step("17-generation-jobs", page);

	// 3D Models: a new model gets concepts, one becomes a 3D model in the viewer, and the engine renders it.
	await nav.getByRole("button", { name: "3D Models" }).click();
	await page.getByRole("button", { name: "+ New model" }).click();
	await page.getByTestId("new-model-description").fill("A wooden crate with iron corners");
	await page.getByRole("button", { name: "Generate concepts" }).click();
	await page.getByTestId("concept").nth(3).waitFor({ timeout: 30_000 });
	await page.getByTestId("concept").nth(1).click();
	// The tab shows this model's own prompt (not the previously selected model's).
	await page.waitForFunction(
		() => (document.querySelector("[data-testid=concept-prompt]") as HTMLTextAreaElement | null)?.value === "A wooden crate with iron corners",
	);
	await step("18-concepts", page);
	await page.getByRole("button", { name: "Generate 3D model" }).click();
	await page.locator("[data-testid=model-viewer][data-loaded=true]").waitFor({ timeout: 60_000 });
	await page.getByTestId("asset-item").filter({ hasText: "Wooden crate iron" }).locator("img.model-thumb").waitFor();
	await step("19-model-viewer", page);
	await page.getByRole("button", { name: "In engine", exact: true }).click();
	await page.getByTestId("render-in-engine").click();
	await page.getByTestId("engine-shot").nth(2).waitFor({ timeout: 60_000 });
	await step("20-model-in-engine", page);

	// A hinge rig for the crate: its open/close clips show in the viewer.
	await page.getByRole("button", { name: "Model", exact: true }).click();
	await page.getByRole("button", { name: "Rig as prop (hinge)" }).click();
	await page.getByRole("button", { name: "Rig prop" }).click();
	await page.getByTestId("prop-rig").waitFor({ timeout: 60_000 });
	await page.locator(".model-side select").filter({ hasText: "Rest pose" }).selectOption("open");
	await step("21-prop-rig", page);

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
