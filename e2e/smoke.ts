// End-to-end: drives the built app through creating a project and a full session lifecycle with the
// scripted faux/echo model. Uses a temp user-data dir, temp worktree root, temp project and a clone of the engine
// repo (the real one is only read).
// Run: npm run build && node e2e/smoke.ts [screenshot-dir]
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type Page } from "playwright";
import { defaultOrbit, project } from "../src/modules/scenes/orbit.ts";

const shots = resolve(process.argv[2] ?? "out/e2e");
mkdirSync(shots, { recursive: true });
// A failed run keeps its folder for debugging; ones over an hour old (no run lasts that long) go now, since /tmp is RAM here.
for (const old of readdirSync(tmpdir()).filter((n) => n.startsWith("game-studio-e2e-"))) {
	const dir = join(tmpdir(), old);
	if (Date.now() - statSync(dir).mtimeMs > 3_600_000) rmSync(dir, { recursive: true, force: true });
}
const root = mkdtempSync(join(tmpdir(), "game-studio-e2e-"));
const userData = join(root, "user-data");
const projectPath = join(root, "e2e-game");
mkdirSync(userData);
// A clone of the engine, so the real repo's own sessions and worktrees (an agent may be working in it) never show up
// here, and nothing here touches it. Its built libraries are linked in, not rebuilt.
const realEngine = process.env.ENGINE_REPO ?? join(homedir(), "Projects/headless-game-engine");
const engineRepo = join(root, "engine");
execSync(`git clone -q --shared ${JSON.stringify(realEngine)} ${JSON.stringify(engineRepo)}`);
execSync(`ln -s ${JSON.stringify(join(realEngine, "third_party/lib"))} ${JSON.stringify(join(engineRepo, "third_party/lib"))}`);
writeFileSync(join(engineRepo, ".git/info/exclude"), "/third_party/lib\n", { flag: "a" });
// Release builds need the Debian sysroot the real engine fetched (third_party/deps.sh).
execSync(`ln -s ${JSON.stringify(join(realEngine, "third_party/sysroot"))} ${JSON.stringify(join(engineRepo, "third_party/sysroot"))}`);
writeFileSync(join(engineRepo, ".git/info/exclude"), "/third_party/sysroot\n", { flag: "a" });
// Web builds need the Emscripten SDK the real engine fetched (third_party/deps.sh --target=web), where there is one.
if (existsSync(join(realEngine, "third_party/tools"))) {
	execSync(`ln -s ${JSON.stringify(join(realEngine, "third_party/tools"))} ${JSON.stringify(join(engineRepo, "third_party/tools"))}`);
	writeFileSync(join(engineRepo, ".git/info/exclude"), "/third_party/tools\n", { flag: "a" });
}
// A stand-in for itch.io's butler: publishing records its arguments instead of uploading anything.
const fakeButler = join(root, "fake-butler.sh");
writeFileSync(fakeButler, `#!/bin/sh\necho "$@" > ${JSON.stringify(join(root, "butler-args"))}\necho "• Pushing 1 file"\n`, { mode: 0o755 });
// Without the real repo's own session and worktree records (they're committed there).
execSync("git rm -rq --ignore-unmatch .studio && git -c user.name=e2e -c user.email=e2e@example.com commit -qm 'e2e: no studio records' || true", { cwd: engineRepo });
// The studio's repo likewise: a clone without the real one's session records (a Studio Engineer session's are committed).
const studioRepo = join(root, "studio");
execSync(`git clone -q --shared ${JSON.stringify(resolve("."))} ${JSON.stringify(studioRepo)}`);
execSync("git checkout -q -B main", { cwd: studioRepo }); // run from another branch (a worktree), the clone has no main yet
execSync("git rm -rq --ignore-unmatch .studio && git -c user.name=e2e -c user.email=e2e@example.com commit -qm 'e2e: no studio records' || true", { cwd: studioRepo });
writeFileSync(
	join(userData, "settings.json"),
	JSON.stringify({
		engineRepo,
		studioRepo,
		worktreeRoot: join(root, "worktrees"),
		recentProjects: [],
	}),
);

const app = await electron.launch({
	args: ["."],
	// Faux agent model, and a fake generation backend (fixture outputs, no GPU); Blender runs for real.
	// Music renders for real with the installed SoundFont (FluidSynth runs on the CPU).
	env: {
		// Without the shell's provider credentials: with one set (say GEMINI_API_KEY), Pi lists that provider's models, the
		// New Session dialog picks the first of them instead of faux/echo, and the run talks to a real API.
		// Nor the dev server of a studio run with `npm run dev` (a studio-engineer session inherits its environment): the
		// app would load that studio's renderer instead of the one just built.
		...Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !/_API_KEY$|_AUTH_TOKEN$|^AWS_|^GOOGLE_APPLICATION_CREDENTIALS$|^ELECTRON_RENDERER_URL$/.test(name)),
		),
		GAME_STUDIO_USER_DATA: userData,
		GAME_STUDIO_FAUX: "1",
		GAME_STUDIO_GEN_FAKE: "1",
		GAME_STUDIO_BUTLER: fakeButler,
		GAME_STUDIO_APPIMAGETOOL: "off",
		GAME_STUDIO_GEN: join(root, "gen"),
		GAME_STUDIO_SOUNDFONT: process.env.GAME_STUDIO_SOUNDFONT ?? join(homedir(), ".local/share/game-studio/gen/models/soundfonts/GeneralUser-GS.sf2"),
	},
});
/** Selects "main" in the sidebar's worktree selector, so the next session or edit gets a worktree of its own. */
const selectMain = async (page: Page) => {
	await page.getByTestId("worktree-current").click();
	await page.getByTestId("worktree-menu").getByRole("button", { name: /^main/ }).click();
	await page.getByTestId("worktree-current").filter({ hasText: "main" }).waitFor();
};
const step = async (name: string, page: Page) => {
	await page.screenshot({ path: join(shots, `${name}.png`) });
	console.log(`✓ ${name}`);
};

let passed = false;
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

	// New Session can show the agent types as the delegation graph: a node picks the type.
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.getByTestId("new-session-layout-graph").click();
	await page.getByTestId("agent-node").filter({ hasText: "Gameplay Engineer" }).click();
	await page.getByTestId("new-session-type-description").filter({ hasText: "Gameplay Engineer" }).waitFor();
	await step("01b-new-session-graph", page);
	await page.getByTestId("new-session-layout-list").click(); // remembered: the steps below pick from the list
	await page.getByRole("button", { name: "Cancel" }).click();

	// Start a session with the faux model.
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.getByTestId("new-session-prompt").fill("add a note");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByTestId("chat").getByText("Noted: add a note").waitFor();
	await step("02-session-idle", page);

	// What its worktree changed is read on the Worktrees page: the files by section, the picked one's lines.
	await page.getByTestId("session-changes").click();
	await page.getByTestId("changes-summary").filter({ hasText: /1 file · 1 new · 1 line added, 0 removed/ }).waitFor();
	await page.getByTestId("changes-file").filter({ hasText: "faux-notes.md" }).filter({ hasText: "New" }).waitFor();
	await page.locator(".diff-line.add", { hasText: "add a note" }).waitFor();
	await step("03-changes", page);
	await page.getByTestId("changes-back").click();
	await page.getByTestId("worktrees-page").waitFor();
	await page.locator("nav.sidebar").getByRole("button", { name: "Sessions" }).click();

	// Merge: done sessions are hidden by default.
	await page.locator(".session-header").getByRole("button", { name: "Merge" }).click();
	await page.getByTestId("merge-confirm").click();
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

	// Design Docs: the standard docs are listed (the brief first), each not established yet.
	await page.getByRole("button", { name: "Design Docs" }).click();
	const docs = page.getByTestId("asset-item");
	await docs.filter({ hasText: "Game Brief" }).filter({ hasText: "Not established" }).waitFor();
	await page.locator(".markdown h1", { hasText: "Game Brief" }).waitFor();
	if (!(await docs.first().textContent())?.includes("Game Brief")) throw new Error("the game brief isn't the first doc listed");
	await page.getByTestId("doc-banner").filter({ hasText: "Not decided yet" }).waitFor();
	await step("08-design-docs", page);

	// "New doc" starts a Game Designer session in a new worktree, which the sidebar selects; its new doc shows there.
	await selectMain(page); // resuming selected the resumed session's worktree
	await page.getByRole("button", { name: "+ New doc" }).click();
	await page.locator(".agent-type.on", { hasText: "Game Designer" }).waitFor();
	await page.getByTestId("new-session-prompt").fill("write docs/design/Combat.md: # Combat\n\nHit things. See [the brief](Game%20Brief.md).");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByRole("button", { name: "Design Docs" }).click();
	await docs.filter({ hasText: "Combat" }).filter({ hasText: "⎇ New" }).click();
	await page.locator(".markdown h1", { hasText: "Combat" }).waitFor();
	await page.getByTestId("worktree-current").filter({ hasText: "write docs/design/Combat.md" }).waitFor();
	await step("09-draft-doc", page);
	await page.locator(".markdown a", { hasText: "the brief" }).click();
	await page.locator(".markdown h1", { hasText: "Game Brief" }).waitFor();

	// Merging the worktree (from the sidebar) makes it a regular doc; the selection goes back to main. The Merge
	// dialog sums up its changes by section and lists its sessions: one still working blocks the merge; idle, a warning.
	// A second session in the worktree that works for a few seconds (a fresh one, so it's busy from its first prompt).
	await page.evaluate(async () => {
		const all = (await window.studio.call("sessions.list")) as { worktreeId: string; worktreeLabel: string; status: string }[];
		const worktreeId = all.find((x) => x.status !== "done" && x.worktreeLabel.startsWith("write docs/design/Combat.md"))!.worktreeId;
		void window.studio.call("sessions.create", {
			agentType: "project-scoping",
			target: "project",
			model: "faux/echo",
			prompt: `tool bash ${JSON.stringify({ command: "sleep 30" })}`,
			worktreeId,
		});
	});
	await page.waitForFunction(
		async () => ((await window.studio.call("sessions.list")) as { status: string; title: string }[]).some((s) => s.status === "in_progress" && s.title.startsWith("tool bash")),
		undefined,
		{ timeout: 15_000 },
	);
	await page.getByTestId("worktree-merge").click();
	await page.getByTestId("merge-blocked").waitFor({ timeout: 10_000 });
	if (await page.getByTestId("merge-confirm").isEnabled()) throw new Error("merge allowed while a session works");
	await step("44-merge-blocked", page);
	// Stopping it unblocks the merge (it's idle now: a warning).
	await page.evaluate(async () => {
		const s = ((await window.studio.call("sessions.list")) as { id: string; title: string }[]).find((x) => x.title.startsWith("tool bash"))!;
		await window.studio.call("sessions.abort", s.id);
	});
	await page.getByTestId("merge-warning").waitFor({ timeout: 30_000 });
	await page.getByTestId("merge-group").filter({ hasText: "Design Docs" }).click();
	await page.getByTestId("merge-session").filter({ hasText: "write docs/design/Combat.md" }).waitFor();
	await page.getByTestId("merge-session").nth(1).waitFor(); // and the second one
	await step("45-merge-dialog", page);
	await page.getByTestId("merge-confirm").click();
	await page.getByTestId("worktree-current").filter({ hasText: "main" }).waitFor({ timeout: 30_000 });
	await docs.filter({ hasText: "Combat" }).and(page.locator('[title*="Hit things."]')).waitFor(); // the excerpt, as its tooltip
	if ((await docs.filter({ hasText: "Combat" }).textContent())?.includes("⎇")) throw new Error("merged doc still shown as worktree work");

	// "Discuss / modify" links the session to the doc; its edit shows as a draft of the overview.
	await docs.filter({ hasText: "Game Brief" }).click();
	await page.getByRole("button", { name: "Discuss / modify" }).click();
	await page.locator(".modal code", { hasText: "About docs/design/Game Brief.md" }).waitFor();
	await page.getByTestId("new-session-prompt").fill("write docs/design/Game Brief.md: ---\nstatus: draft\n---\n# Game Brief\n\nNow with [combat](Combat.md).");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByRole("button", { name: "Design Docs" }).click();
	await docs.filter({ hasText: "Game Brief" }).filter({ hasText: "⎇ Modified" }).filter({ hasText: "Draft" }).click();
	await page.locator(".markdown", { hasText: "Now with combat" }).waitFor();
	// The user sets the status and edits the doc by hand, in the selected worktree.
	await page.getByTestId("doc-status").selectOption("established");
	await page.getByTestId("doc-banner").filter({ hasText: "Established" }).waitFor();
	await page.getByTestId("doc-edit").click();
	await page.getByTestId("doc-source").fill("# Game Brief\n\nNow with [combat](Combat.md), edited by hand.");
	await page.getByTestId("doc-save").click();
	await page.locator(".markdown", { hasText: "edited by hand" }).waitFor();
	await page.getByTestId("doc-banner").filter({ hasText: "Established" }).waitFor();
	// A reference image: picked, captioned, saved in docs/design/references/ and shown in the doc.
	await page.getByTestId("doc-image-input").setInputFiles({ name: "glade.png", mimeType: "image/png", buffer: readFileSync(resolve("gen/workers/fixtures/concept.png")) });
	await page.getByTestId("doc-image-caption").locator("input").fill("the clearing's light");
	await page.getByTestId("doc-image-add").click();
	const ref = page.locator('.markdown img[title="the clearing\'s light"]');
	await ref.waitFor();
	for (let i = 0; !(await ref.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)); i++) {
		if (i > 50) throw new Error("the reference image didn't load");
		await page.waitForTimeout(100);
	}
	await step("10b-doc-status-and-edit", page);
	await page.getByTestId("worktree-save").click();
	await page.getByTestId("save-ok").click();
	await page.getByTestId("worktree-unsaved").waitFor({ state: "detached", timeout: 10_000 });
	await page.getByText("Sessions on this doc").waitFor();
	await step("10-doc-draft-of-existing", page);
	// The same session removes a doc: listed as removed; the sidebar counts the section's changes by kind; the
	// "only changes" filter narrows the list.
	await page.getByText("Sessions on this doc").locator("..").locator(".list-row").first().click();
	await page.getByTestId("composer").fill(`tool bash ${JSON.stringify({ command: "git rm -q docs/design/Combat.md && git commit -qm 'Remove combat doc'" })}`);
	await page.getByTestId("composer").press("Enter");
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByRole("button", { name: "Design Docs" }).click();
	await docs.filter({ hasText: "⎇ Removed" }).filter({ hasText: "Combat" }).click();
	await page.getByTestId("asset-removed").waitFor();
	await page.locator(".sidebar").getByTestId("change-counts").locator(".change-deleted").first().waitFor();
	await page.getByTestId("filter-changed").check();
	await step("36-worktree-changes", page);
	await page.getByTestId("filter-changed").uncheck();
	await page.getByTestId("worktree-current").click();
	await page.getByTestId("worktree-menu").waitFor();
	await step("31-worktree-selector", page);
	await page.getByTestId("worktree-current").click();

	// Updating from main: main rewrites the overview too, so the update conflicts. The Conflict Resolver starts
	// (briefed with the worktree's sessions); the Sessions page lists this worktree's sessions only; aborting the
	// update goes back. With main selected, the page says a new session starts its own worktree.
	writeFileSync(join(projectPath, "docs/design/Game Brief.md"), "# Game Brief\n\nMain's own brief.\n");
	execSync("git add 'docs/design/Game Brief.md' && git commit -qm 'Main rewrites the overview'", { cwd: projectPath });
	await page.getByTestId("worktree-behind").filter({ hasText: "main has 1 new commit" }).waitFor({ timeout: 30_000 });
	await page.getByTestId("worktree-update").click();
	await page.getByTestId("worktree-conflicts").filter({ hasText: "1 conflict" }).waitFor({ timeout: 30_000 });
	await page.locator(".session-header", { hasText: "Resolve conflicts with main" }).waitFor({ timeout: 30_000 });
	await page.getByTestId("sessions-scope").filter({ hasText: "its sessions" }).waitFor();
	await page.getByTestId("session-item").nth(1).waitFor();
	if ((await page.getByTestId("session-item").count()) !== 2) throw new Error("the Sessions page should list only this worktree's two sessions");
	await page.getByTestId("chat").getByText(/Resolve every conflict/).first().waitFor({ timeout: 30_000 });
	await step("48-update-conflicts", page);
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByTestId("worktree-abort-update").click();
	await page.getByTestId("worktree-behind").waitFor({ timeout: 30_000 });
	const overviewWorktree = (await page.getByTestId("worktree-current").textContent()) ?? "";
	await selectMain(page);
	await page.getByTestId("sessions-scope").filter({ hasText: "its own worktree" }).waitFor();
	await step("49-sessions-main", page);
	// Archived: read from the archive folder only when asked for (nothing is a week old here).
	await page.getByTestId("archived-chip").click();
	await page.getByText("Nothing archived matches").waitFor();
	await step("52-archived", page);
	await page.getByTestId("archived-chip").click();
	await page.getByTestId("worktree-current").click();
	await page.getByTestId("worktree-option").filter({ hasText: overviewWorktree.replace(/[⎇▾●]/g, "").trim().slice(0, 20) }).click();

	// Game Code lists the template's code.
	const nav = page.locator("nav.sidebar");
	await nav.getByRole("button", { name: "Code", exact: true }).click();
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

	// Multiplayer: two copies of the game side by side, the first hosting; the console and inspector follow the one clicked.
	await page.getByTestId("run-players").selectOption("2");
	await page.getByRole("button", { name: "▶ Run in studio" }).click();
	await page.waitForFunction(() => document.querySelectorAll("[data-testid=player-view] [data-testid=viewport] img").length === 2, undefined, { timeout: 60_000 });
	const netOf = (player: number) => page.evaluate((p) => window.studio.call("run.call", "net", {}, p), player) as Promise<{ role: string; players: unknown[] }>;
	for (let i = 0; i < 100 && (await netOf(1)).players.length !== 2; i++) await page.waitForTimeout(100);
	if ((await netOf(0)).role !== "Host" || (await netOf(1)).role !== "Client" || (await netOf(1)).players.length !== 2) throw new Error("the second copy of the game should have joined the first");
	await page.locator("[data-testid=player-view][data-player='1']").click();
	await page.locator("[data-testid=player-view][data-player='1'].focused").waitFor();
	await page.locator(".inspector h3", { hasText: "Player 2" }).waitFor();
	await step("12a-play-multiplayer", page);
	await page.getByRole("button", { name: "■ Stop" }).click();
	await page.getByTestId("run-state").getByText("Stopped").waitFor();
	await page.getByTestId("run-players").selectOption("1");

	// Tests: the template's smoke test passes, with its screenshot.
	await page.getByRole("button", { name: "Tests", exact: true }).click();
	await page.getByRole("button", { name: "▶ Run all" }).click();
	await page.locator(".test-status.pass").waitFor({ timeout: 60_000 });
	await page.locator(".test-head", { hasText: "tests/smoke.jsonl" }).click();
	await page.waitForFunction(() => ((document.querySelector(".shot img") as HTMLImageElement | null)?.naturalWidth ?? 0) > 0);
	await step("13-tests", page);

	// A session's code that doesn't compile (started from main, so in a new worktree): build its worktree, follow the
	// error into its code there.
	await selectMain(page);
	await nav.getByRole("button", { name: "Code", exact: true }).click();
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
	await page.locator(".asset-item.selected", { hasText: "⎇ New" }).waitFor();
	await page.getByTestId("worktree-current").filter({ hasText: "write game/extra.odin" }).waitFor();
	await step("15-error-in-draft", page);

	// Asset generation (from main, in a worktree of its own): an agent's tools make concepts, then a model; the jobs show in Settings.
	await selectMain(page);
	await nav.getByRole("button", { name: "Sessions" }).click();
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.locator(".agent-type", { has: page.locator("strong", { hasText: /^3D Modeller$/ }) }).click();
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
	// No model yet: the list shows its newest concept instead of a thumbnail.
	await page.getByTestId("asset-item").filter({ hasText: "Wooden crate iron" }).getByTestId("concept-thumb").locator("img").waitFor();
	await page.getByTestId("concept").nth(1).click();
	// The tab shows this model's own prompt (not the previously selected model's).
	await page.waitForFunction(
		() => (document.querySelector("[data-testid=concept-prompt]") as HTMLTextAreaElement | null)?.value === "A wooden crate with iron corners",
	);
	await step("18-concepts", page);
	// Handing chosen concepts (Ctrl-click adds one) to a 3D Modeller session prefills its brief.
	await page.getByTestId("concept").nth(2).click({ modifiers: ["Control"] });
	await page.getByTestId("hand-to-modeller").click();
	await page.locator(".agent-type.on", { hasText: "3D Modeller" }).waitFor();
	await page.waitForFunction(() => /^Make the 3D model "wooden-crate-iron[\s\S]*also chosen/.test((document.querySelector("[data-testid=new-session-prompt]") as HTMLTextAreaElement | null)?.value ?? ""));
	await step("34-hand-to-modeller", page);
	await page.getByRole("button", { name: "Cancel" }).click();
	await page.getByTestId("concept").nth(1).click();
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

	// Music: "New piece" starts a Composer session; its score renders, and the section shows and plays it.
	const theme = {
		title: "E2E Theme",
		tempo: 120,
		key: "C major",
		instruments: { lead: { program: "flute" }, drums: { drums: true } },
		sections: { A: { bars: 2, tracks: { lead: "C5:q E5 G5 E5 | D5:h G4", drums: "kick:q hat snare hat" } } },
		arrangement: ["A", "A"],
	};
	await nav.getByRole("button", { name: "Music" }).click();
	await page.getByRole("button", { name: "+ New piece" }).click();
	await page.locator(".agent-type.on", { hasText: "Composer" }).waitFor();
	await page.getByTestId("new-session-prompt").fill(`write assets/music/e2e-theme/song.json: ${JSON.stringify(theme)}`);
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByTestId("composer").fill('tool render_song {"name": "e2e-theme"}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*e2e-theme\.ogg/).waitFor({ timeout: 60_000 });
	await nav.getByRole("button", { name: "Music" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "E2E Theme" }).click();
	await page.locator("[data-testid=render-status][data-state=current]").waitFor({ timeout: 30_000 });
	await page.getByTestId("arr-track").nth(1).waitFor();
	await page.locator("[data-testid=music-play]:not([disabled])").waitFor();
	await step("22-music", page);

	// The mix bar: tempo applies to the score and re-renders; the space toggles straight away.
	await page.getByTestId("music-tempo").fill("90");
	await page.getByTestId("music-mix-apply").click();
	await page.locator(".music-facts", { hasText: "90 bpm" }).waitFor({ timeout: 30_000 });
	await page.locator("[data-testid=render-status][data-state=current]").waitFor({ timeout: 30_000 });
	await page.getByTestId("music-space-hall").click();
	await page.locator("[data-testid=music-space-hall].on").waitFor({ timeout: 30_000 });
	await page.locator("[data-testid=render-status][data-state=current]").waitFor({ timeout: 30_000 });
	await step("23-music-edit", page);

	// Muting: "Mute all" then unmuting one track plays its stem alone.
	await page.getByTestId("mute-all").click();
	await page.getByTestId("stems-playing").filter({ hasText: "2 muted" }).waitFor({ timeout: 60_000 });
	await page.getByTestId("arr-track").nth(0).getByTestId("mute-track").click();
	await page.getByTestId("stems-playing").filter({ hasText: "1 muted" }).waitFor();
	await page.getByTestId("music-play").click();
	await page.getByTestId("music-play").filter({ hasText: "Pause" }).waitFor();
	// The stems really play: the clock moves.
	await page.locator(".music-player .mono").filter({ hasText: /^0:0[1-9] \// }).waitFor({ timeout: 10_000 });
	await step("23b-music-muted", page);
	await page.getByTestId("music-play").click();
	await page.getByTestId("mute-all").click(); // "Unmute all" now? one is unmuted, so it mutes all
	await page.getByTestId("mute-all").filter({ hasText: "Unmute all" }).click();
	await page.getByTestId("stems-playing").waitFor({ state: "detached" });

	// Recompose: drag over bar 2 of the lead; the brief names the section's bar and that "A" repeats.
	const lane = page.getByTestId("arr-track-lane").nth(0);
	const laneBox = (await lane.boundingBox())!;
	await page.mouse.move(laneBox.x + laneBox.width * 0.3, laneBox.y + laneBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(laneBox.x + laneBox.width * 0.4, laneBox.y + laneBox.height / 2);
	await page.mouse.up();
	await page.getByTestId("recompose").filter({ hasText: "bar 2" }).waitFor();
	await page.getByTestId("recompose-shared").waitFor();
	await page.getByTestId("recompose-feedback").fill("busier, more playful");
	// The picked track stretches to show its notes a pitch to a row.
	await page.locator("[data-testid=arr-track].expanded").filter({ hasText: "lead" }).getByTestId("arr-range").waitFor();
	await step("23c-music-recompose", page);
	// ⏭ / ⏮ move by bars.
	await page.getByTestId("music-bar-forward").click();
	await page.getByTestId("music-clock").filter({ hasText: "bar 2" }).waitFor();
	await page.getByTestId("music-bar-back").click();
	await page.getByTestId("music-bar-back").click();
	await page.getByTestId("music-clock").filter({ hasText: "bar 1" }).waitFor();
	// The picked bar plays on its own, round and round when looped: still in bar 2 after more than a bar (2.7 s at 90 bpm).
	await page.getByTestId("music-loop-region").check();
	await page.getByTestId("music-play-region").filter({ hasText: "Bar 2" }).click();
	await page.getByTestId("music-clock").filter({ hasText: "bar 2" }).waitFor();
	await page.waitForTimeout(4000);
	if (!(await page.getByTestId("music-clock").textContent())?.includes("bar 2")) throw new Error(`the looped bar played on: ${await page.getByTestId("music-clock").textContent()}`);
	await page.getByTestId("music-play-region").click();
	await page.getByTestId("recompose-go").click();
	/** The first message of the session titled `title` (as JSON), once it exists. */
	const briefOf = async (title: string): Promise<string> => {
		for (const until = Date.now() + 30_000; Date.now() < until; await new Promise((r) => setTimeout(r, 300))) {
			const brief = await page.evaluate(async (t) => {
				const s = ((await window.studio.call("sessions.list")) as { id: string; title: string }[]).find((x) => x.title.startsWith(t));
				if (!s) return null;
				const first = ((await window.studio.call("sessions.messages", s.id)) as { role: string; content: unknown }[]).find((m) => m.role === "user");
				return first ? JSON.stringify(first.content) : null;
			}, title);
			if (brief) return brief;
		}
		throw new Error(`no session "${title}" with a first message`);
	};
	const recompose = await briefOf("Recompose lead (bar 2)");
	if (!recompose.includes('section \\"A\\", its bar 2 of 2') || !recompose.includes("busier, more playful")) throw new Error(`unexpected recompose brief: ${recompose.slice(0, 400)}`);

	// Add an instrument: every General MIDI instrument by family, each previewable; the composer writes its part.
	await page.locator("[data-testid=add-instrument]:not([disabled])").waitFor({ timeout: 30_000 });
	await page.getByTestId("add-instrument").click();
	await page.getByTestId("instrument-search").fill("cello");
	const cello = page.getByTestId("instrument-option").filter({ hasText: /^.cello$/ });
	await cello.getByTestId("instrument-preview").click();
	await cello.getByTestId("instrument-preview").filter({ hasText: /^(■|▶)$/ }).waitFor({ timeout: 30_000 });
	await cello.click();
	await page.getByTestId("instrument-notes").fill("a slow countermelody");
	await step("23d-music-add-instrument", page);
	await page.getByTestId("instrument-compose").click();
	const add = await briefOf("Add cello");
	if (!add.includes("a track `cello` playing cello") || !add.includes("a slow countermelody")) throw new Error(`unexpected add brief: ${add.slice(0, 400)}`);

	// The wheel zooms the lanes, which then scroll sideways; "fit" shows the whole piece again.
	const lanes = (await page.getByTestId("arr-scroll").boundingBox())!;
	await page.mouse.move(lanes.x + lanes.width * 0.5, lanes.y + lanes.height * 0.6);
	await page.mouse.wheel(0, -600);
	await page.getByTestId("arr-zoom-fit").waitFor();
	if (!(await page.getByTestId("arr-scroll").evaluate((el) => el.scrollWidth > el.clientWidth * 1.5))) throw new Error("zooming didn't widen the lanes");
	await step("23e-music-zoomed", page);
	await page.getByTestId("arr-zoom-fit").click();
	await page.getByTestId("arr-zoom-fit").waitFor({ state: "detached" });

	// A theme sketch offers "Arrange this theme…": a Composer brief for the full piece.
	await page.locator(".session-header").first().waitFor();
	await nav.getByRole("button", { name: "Sessions" }).click();
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.locator(".agent-type", { hasText: "Composer" }).first().click();
	await page.getByTestId("new-session-prompt").fill(`write assets/music/e2e-theme-sketch-1/song.json: ${JSON.stringify({ ...theme, title: "E2E Theme sketch 1" })}`);
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await nav.getByRole("button", { name: "Music" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "E2E Theme sketch 1" }).click();
	await page.getByTestId("arrange-sketch").click();
	await page.locator(".agent-type.on", { hasText: "Composer" }).waitFor();
	await page.waitForFunction(() => ((document.querySelector("[data-testid=new-session-prompt]") as HTMLTextAreaElement | null)?.value ?? "").includes("into the full piece assets/music/e2e-theme/"));
	await step("35-arrange-sketch", page);
	await page.getByRole("button", { name: "Cancel" }).click();

	// Scenes, from main: the template's scene opens live and paused; clicking the cube in the view selects it, an
	// inspector edit makes (and selects) a new worktree "Scene: main" with the change, and duplicating adds an entity.
	await selectMain(page);
	await nav.getByRole("button", { name: "Scenes" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "main" }).click();
	const view = page.locator("[data-testid=scene-viewport] img");
	await view.waitFor({ timeout: 60_000 });
	await page.waitForTimeout(500);
	await step("24-scenes", page);
	const box = (await view.boundingBox())!;
	const cubeAt = project(defaultOrbit(JSON.parse(readFileSync(join(projectPath, "assets/scenes/main.json"), "utf8")).entities, false), [0, 1, 0], 1280, 720)!;
	await view.click({ position: { x: (cubeAt.x / 1280) * box.width, y: (cubeAt.y / 720) * box.height } });
	await page.locator("[data-testid=entity-inspector] h3", { hasText: "Cube" }).waitFor();
	const x = page.locator("[data-testid=component-Transform] .vec input").first();
	await x.fill("2");
	await x.press("Enter");
	await page.getByTestId("worktree-current").filter({ hasText: "Scene: main" }).waitFor({ timeout: 30_000 });
	await view.waitFor({ timeout: 60_000 });
	await page.locator("[data-testid=component-Transform] .vec input").first().and(page.locator("[value='2']")).waitFor({ timeout: 30_000 });
	await page.getByRole("button", { name: "Duplicate" }).click();
	await page.getByTestId("outline-row").nth(4).waitFor({ timeout: 30_000 });
	await page.waitForTimeout(800);
	await step("25-scene-edit", page);

	// Manual edits are unsaved, with an undo history: ↶ undoes the duplicate, the app menu's Edit → Undo the move;
	// ↷ redoes; Save commits them (message from the steps) and the unsaved row goes away.
	const sidebar = page.getByTestId("worktree-picker"); // the worktree bar (these lived in the sidebar once)
	await sidebar.getByTestId("unsaved-count").filter({ hasText: "2 unsaved" }).waitFor({ timeout: 10_000 });
	await sidebar.getByTestId("undo").click();
	await page.getByTestId("notice").filter({ hasText: "Undid: Scene main: duplicated an entity" }).waitFor();
	await page.getByTestId("outline-row").nth(4).waitFor({ state: "detached", timeout: 30_000 });
	await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((m) => m.label === "Edit")!.submenu!.items.find((i) => i.label === "Undo")!.click());
	await page.getByTestId("notice").filter({ hasText: "Undid: Scene main: set Transform" }).waitFor();
	await sidebar.getByTestId("redo").click();
	await sidebar.getByTestId("redo").click();
	await page.getByTestId("outline-row").nth(4).waitFor({ timeout: 30_000 });
	await sidebar.getByTestId("unsaved-count").click();
	await sidebar.getByTestId("history-list").filter({ hasText: "Scene main: set Transform" }).waitFor();
	await step("43-unsaved-edits", page);
	await sidebar.getByTestId("worktree-save").click();
	if (!(await page.getByTestId("save-message").inputValue()).startsWith("2 manual edits")) throw new Error("save message not from the steps");
	await page.getByTestId("save-ok").click();
	await sidebar.getByTestId("worktree-unsaved").waitFor({ state: "detached", timeout: 10_000 });

	// A Level Designer looks at the scene with preview_scene.
	await page.getByRole("button", { name: "+ New scene" }).click();
	await page.locator(".agent-type.on", { hasText: "Level Designer" }).waitFor();
	await page.getByTestId("new-session-prompt").fill("look at the scene");
	await page.getByRole("button", { name: "Start session" }).click();
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByTestId("composer").fill('tool preview_scene {"scene": "assets/scenes/main.json", "views": ["top", "game"]}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result: assets\/scenes\/main\.json in the game's engine, views in order: top, game\./).waitFor({ timeout: 60_000 });
	await step("26-preview-scene", page);

	// The same session makes a prefab and places it twice: the tree shows scenes/, then prefabs/ with where each is used.
	const placeCrates = [
		"import json",
		'open("assets/prefabs/crate.json", "w").write(json.dumps({"notes": "A crate.", "entities": [{"id": 1, "Name": "Crate", "Transform": {}, "Mesh_Renderer": {"mesh": "cube"}}]}))',
		'p = "assets/scenes/main.json"; s = json.load(open(p)); n = max(e["id"] for e in s["entities"])',
		's["entities"] += [{"id": n + k, "prefab": "prefabs/crate.json", "Transform": {"position": [-2, 0, 2 * k - 3]}} for k in (1, 2)]',
		'json.dump(s, open(p, "w"), indent=1)',
	].join("; ");
	const placeCmd = `mkdir -p assets/prefabs && python3 -c '${placeCrates}' && git add assets && git commit -qm 'Crate prefab' && echo crate-placed`;
	await page.getByTestId("composer").fill(`tool bash ${JSON.stringify({ command: placeCmd })}`);
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*crate-placed/).waitFor({ timeout: 30_000 });
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await nav.getByRole("button", { name: "Scenes" }).click();
	await page.getByTestId("tree-folder").filter({ hasText: "prefabs" }).waitFor();
	await page.getByTestId("asset-item").filter({ hasText: "used 2× in main" }).waitFor({ timeout: 10_000 });
	if (!/^[▾▸]scenes/.test((await page.getByTestId("tree-folder").first().textContent()) ?? "")) throw new Error("scenes aren't listed first");
	await nav.getByRole("button", { name: "Scenes" }).locator(".change-added").waitFor({ timeout: 10_000 }); // the new prefab, in the sidebar too
	await step("37-scene-groups", page);
	// Folders fold away (remembered); the wheel over the scene zooms it and doesn't scroll the page behind.
	const crateItem = page.getByTestId("asset-item").filter({ has: page.locator(".title", { hasText: /^crate$/ }) });
	await page.getByTestId("tree-folder").filter({ hasText: "prefabs" }).click();
	await crateItem.waitFor({ state: "detached" });
	await page.getByTestId("tree-folder").filter({ hasText: "prefabs" }).click();
	await crateItem.waitFor();
	// Rename from the tree's menu into a new folder: the scene placing it is updated (still "used 2× in main").
	await crateItem.click({ button: "right" });
	await page.getByTestId("tree-menu").getByRole("button", { name: "Rename…" }).click();
	await page.getByTestId("move-path").fill("props/box");
	await page.getByTestId("move-ok").click();
	await page.getByTestId("asset-item").filter({ has: page.locator(".title", { hasText: /^box$/ }) }).filter({ hasText: "used 2× in main" }).waitFor({ timeout: 10_000 });
	await page.getByTestId("tree-folder").filter({ hasText: "props" }).waitFor();
	await page.getByTestId("move-notice").filter({ hasText: "updating 1 file" }).waitFor();
	await step("38-asset-moved", page);
	// Agents move through the same tool (here the faux Level Designer, in the same worktree).
	await nav.getByRole("button", { name: "Sessions" }).click();
	await page.locator(".session-item", { hasText: "look at the scene" }).click();
	await page.getByTestId("composer").fill('tool move_asset {"from": "assets/prefabs/props/box.json", "to": "assets/prefabs/props/crate.json"}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*"to": "assets\/prefabs\/props\/crate\.json"/).waitFor({ timeout: 30_000 });
	await nav.getByRole("button", { name: "Scenes" }).click();
	const boxItem = page.getByTestId("asset-item").filter({ has: page.locator(".title", { hasText: /^crate$/ }) });
	// Dragging it onto prefabs/ moves it back up, keeping its new name.
	await boxItem.filter({ hasText: "used 2× in main" }).waitFor({ timeout: 10_000 });
	await boxItem.dragTo(page.getByTestId("tree-folder").filter({ hasText: /^.prefabs/ }));
	await page.getByTestId("tree-folder").filter({ hasText: "props" }).waitFor({ state: "detached", timeout: 10_000 });
	await boxItem.filter({ hasText: "used 2× in main" }).waitFor();
	// "Used in": the main scene shows the prefab it places (and not itself); nothing here is unused (code loads main).
	await page.getByTestId("filter-used-in").selectOption({ label: "main" });
	await boxItem.waitFor();
	await page.getByTestId("asset-item").filter({ has: page.locator(".title", { hasText: /^main$/ }) }).waitFor({ state: "detached" });
	await step("39-used-in", page);
	await page.getByTestId("filter-used-in").selectOption("none");
	await page.getByText("Nothing matches.").waitFor();
	await page.getByTestId("filter-used-in").selectOption("");
	await page.getByTestId("asset-item").filter({ has: page.locator(".title", { hasText: /^main$/ }) }).click();
	await page.locator("[data-testid=scene-viewport] img").waitFor({ timeout: 60_000 });
	const wheelKept = await page.getByTestId("scene-viewport").evaluate((el) => !el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true })));
	if (!wheelKept) throw new Error("the scene's wheel zoom lets the page scroll");

	// Textures (fake worker): a new texture's candidates; using one makes the texture (tiled, in 3D, in the engine).
	await nav.getByRole("button", { name: "Textures" }).click();
	await page.getByRole("button", { name: "+ New texture" }).click();
	await page.getByTestId("new-texture-prompt").fill("short stylised grass with clover");
	await page.getByTestId("new-texture-name").fill("grass");
	await page.getByTestId("new-texture-create").click();
	await page.getByTestId("texture-candidate").nth(3).waitFor({ timeout: 30_000 });
	await page.getByTestId("candidate-use").first().click();
	await page.getByTestId("texture-tiled").waitFor({ timeout: 30_000 });
	await page.getByTestId("texture-3d").locator("canvas").waitFor();
	await page.getByRole("button", { name: "In the engine" }).click();
	await page.locator(".engine-shots img").nth(1).waitFor({ timeout: 90_000 });
	await step("46-texture", page);
	// Scenes: the Surface texture picker puts it on the ground, tiled for the ground's size.
	await nav.getByRole("button", { name: "Scenes" }).click();
	await page.getByTestId("asset-item").filter({ has: page.locator(".title", { hasText: /^main$/ }) }).click();
	await page.getByTestId("outline-row").filter({ hasText: "Ground" }).click();
	await page.getByTestId("surface-select").selectOption("grass");
	await page.getByTestId("surface-select").and(page.locator(":not([disabled])")).waitFor();
	await page.waitForFunction(async () => {
		const wts = (await window.studio.call("worktrees.list")) as { id: string; label: string; status: string }[];
		const w = wts.find((x) => x.label === "Scene: main" && x.status === "active");
		if (!w) return false;
		const text = (await window.studio.call("assets.read", "assets/scenes/main.json", w.id)) as string;
		return text.includes('"texture": "textures/grass/grass.png"') && text.includes('"uv_scale": [10, 10]');
	}, undefined, { timeout: 30_000 });
	await page.waitForTimeout(1500);
	await step("47-scene-texture", page);

	// UI: a new screen (from main, so in a worktree "UI: hud") opens over the live game. A text added to its panel and
	// bound to {gold} shows the sample value; dragging the panel sets its offset in the file, its corner its size.
	/** A file in the worktree labelled `label`, once `ok` holds (polled from here: the IPC is async). */
	const fileIn = async (label: string, path: string, ok: (t: string) => boolean): Promise<string> => {
		for (const until = Date.now() + 30_000; Date.now() < until; await page.waitForTimeout(300)) {
			const text = (await page.evaluate(
				async ([l, p]) => {
					const w = ((await window.studio.call("worktrees.list")) as { id: string; label: string; status: string }[]).find((x) => x.label === l && x.status === "active");
					return w ? ((await window.studio.call("assets.read", p, w.id).catch(() => "")) as string) : "";
				},
				[label, path],
			)) as string;
			if (ok(text)) return text;
		}
		throw new Error(`${path} in “${label}” never matched; it reads:\n${(await page.evaluate(async ([l, p]) => { const w = ((await window.studio.call("worktrees.list")) as { id: string; label: string; status: string }[]).find((x) => x.label === l && x.status === "active"); return w ? ((await window.studio.call("assets.read", p, w.id).catch(() => "")) as string) : "(no worktree)"; }, [label, path])) as string}`);
	};
	await selectMain(page);
	await nav.getByRole("button", { name: "UI", exact: true }).click();
	await page.getByRole("button", { name: "+ New…" }).click();
	await page.getByTestId("ui-new-choose-screen").click();
	await page.getByTestId("ui-new-screen-name").fill("hud");
	await page.getByTestId("ui-new-screen-create").click();
	await page.getByTestId("ui-viewport").locator("img").waitFor({ timeout: 90_000 });
	await page.getByTestId("ui-outline-item").filter({ hasText: "panel" }).click();
	await page.getByTestId("ui-selected").waitFor({ timeout: 15_000 });
	await page.getByTestId("ui-add").click();
	await page.getByTestId("ui-add-type").filter({ hasText: "text" }).click();
	await page.getByTestId("ui-text").fill("Gold: {gold}");
	await page.getByTestId("ui-text").press("Enter");
	await page.getByTestId("ui-value-gold").fill("250");
	for (let tries = 0; ; tries++) {
		const tree = (await page.evaluate(() => window.studio.call("run.call", "ui_tree"))) as { id: string; text: string }[];
		if (tree.some((n) => n.text === "Gold: 250")) break;
		if (tries > 60) throw new Error(`the bound text never showed: ${JSON.stringify(tree)}`);
		await page.waitForTimeout(300);
	}
	await page.getByTestId("ui-outline-item").filter({ hasText: "panel" }).click();
	const panelBox = (await page.getByTestId("ui-selected").boundingBox())!;
	await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(panelBox.x + panelBox.width / 2 + 40, panelBox.y + panelBox.height / 2 + 20, { steps: 5 });
	await page.mouse.up();
	await fileIn("UI: hud", "assets/ui/hud.json", (t) => /"offset": \[[1-9]\d*, [1-9]\d*\]/.test(t));
	// The live view re-reads the file and lays the panel out where it now is before the next drag.
	for (let tries = 0; ; tries++) {
		const b = (await page.getByTestId("ui-selected").boundingBox())!;
		if (Math.abs(b.x - panelBox.x) > 10) break;
		if (tries > 50) throw new Error("the panel never moved in the live view");
		await page.waitForTimeout(200);
	}
	const handle = (await page.getByTestId("ui-resize").boundingBox())!;
	await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
	await page.mouse.down();
	await page.mouse.move(handle.x + 40, handle.y + 30, { steps: 5 });
	await page.mouse.up();
	await fileIn("UI: hud", "assets/ui/hud.json", (t) => {
		const m = /"size": \[(\d+), (\d+)\]/.exec(t);
		return !!m && Number(m[1]) > 400 && Number(m[2]) > 320;
	});
	await page.waitForTimeout(800);
	await step("52-ui-editor", page);
	// The list folds away to a rail, giving the live view the room; the rail brings it back.
	const narrow = (await page.getByTestId("ui-viewport").boundingBox())!.width;
	await page.getByTestId("asset-list-collapse").click();
	await page.getByTestId("asset-list-rail").waitFor();
	await page.waitForTimeout(300);
	const wide = (await page.getByTestId("ui-viewport").boundingBox())!.width;
	if (wide < narrow + 200) throw new Error(`folding the list didn't widen the view: ${narrow} → ${wide}`);
	await step("52b-ui-list-collapsed", page);
	await page.getByTestId("asset-list-expand").click();
	await page.getByTestId("asset-list-collapse").waitFor();

	// UI art (fake worker): candidates, one used makes the piece, previewed stretched; the panel takes it as its frame.
	await page.getByRole("button", { name: "+ New…" }).click();
	await page.getByTestId("ui-new-choose-art").click();
	await page.getByTestId("ui-new-art-name").fill("wood-frame");
	await page.getByTestId("ui-new-art-prompt").fill("a carved wooden border with gold rivets");
	await page.getByTestId("ui-new-art-create").click();
	await page.getByTestId("ui-candidate").nth(2).waitFor({ timeout: 30_000 });
	await page.getByTestId("ui-candidate-use").first().click();
	await page.getByTestId("ui-nine").waitFor({ timeout: 30_000 });
	await step("53-ui-art", page);
	await page.getByTestId("asset-item").filter({ hasText: "hud" }).click();
	await page.getByTestId("ui-outline-item").filter({ hasText: "panel" }).click();
	await page.getByTestId("ui-frame").selectOption("ui/art/wood-frame/wood-frame.png");
	await fileIn("UI: hud", "assets/ui/hud.json", (t) => t.includes('"frame": "ui/art/wood-frame/wood-frame.png"'));

	// Shaders: a new shader opens beside its live view; a typo shows on its line before anything is saved; the fix
	// saves (Ctrl+S); a parameter tried with its slider reaches the engine; "Make these the defaults" writes it in.
	await selectMain(page);
	await nav.getByRole("button", { name: "Shaders", exact: true }).click();
	await page.getByRole("button", { name: "+ New shader" }).click();
	await page.getByTestId("shader-new-name").fill("glow");
	await page.getByTestId("shader-new-template").selectOption("glow");
	await page.getByTestId("shader-new-create").click();
	await page.getByTestId("shader-viewport").locator("img").waitFor({ timeout: 90_000 });
	const source = page.getByTestId("shader-source");
	const template = await source.inputValue();
	await source.fill(template.replace("s.emission = glow", "s.emission = glo"));
	await page.locator(".code-gutter .bad", { hasText: "7" }).waitFor({ timeout: 20_000 });
	await page.getByTestId("shader-errors").filter({ hasText: "line 7" }).waitFor();
	await step("54-shader-error", page);
	await source.fill(template.replace("0.25 * sin", "0.4 * sin"));
	await page.getByTestId("shader-errors").filter({ hasText: "Compiles." }).waitFor({ timeout: 20_000 });
	await source.press("Control+s");
	await fileIn("Shader: glow", "assets/shaders/glow.glsl", (t) => t.includes("0.4 * sin"));
	await page.getByTestId("shader-param-strength").focus();
	for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
	for (let tries = 0; ; tries++) {
		const e = JSON.stringify(await page.evaluate(() => window.studio.call("run.call", "entity", { entity: "Subject" })));
		if (/"strength":5\b/.test(e)) break;
		if (tries > 50) throw new Error(`the tried value never reached the engine: ${e}`);
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(500);
	await step("55-shader-editor", page);
	await page.getByTestId("shader-make-defaults").click();
	await fileIn("Shader: glow", "assets/shaders/glow.glsl", (t) => t.includes("// @param float strength = 5 [0, 20]"));

	// Post-processing in the Scenes environment: a bloom slider writes the scene's post block.
	await nav.getByRole("button", { name: "Scenes" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "main" }).click();
	await page.getByText("Environment", { exact: true }).click();
	await page.locator("[data-testid=scene-viewport] img").waitFor({ timeout: 60_000 });
	await page.getByTestId("post-panel").waitFor({ timeout: 30_000 });
	await page.getByTestId("post-bloom").focus();
	for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowRight");
	await fileIn("Shader: glow", "assets/scenes/main.json", (t) => /"post": ?\{ ?"bloom": ?0\.[1-9]/.test(t));
	await page.waitForTimeout(800);
	await step("56-scene-post", page);

	// Effects: a new burst plays in its live view (particles counted); raising a colour stop's intensity rewrites the
	// file; a procedural smoke flipbook texture is made and picked for the emitter, bringing its flipbook along.
	await selectMain(page);
	await nav.getByRole("button", { name: "Effects", exact: true }).click();
	await page.getByRole("button", { name: "+ New…" }).click();
	await page.getByTestId("effect-new-name").fill("chest-burst");
	await page.getByTestId("effect-new-create").click();
	await page.getByTestId("effect-viewport").locator("img").waitFor({ timeout: 90_000 });
	for (let tries = 0; ; tries++) {
		const s = (await page.getByTestId("effect-stats").textContent()) ?? "";
		if (/^[1-9]\d* particles/.test(s)) break;
		if (tries > 60) throw new Error(`the effect never played: ${s}`);
		await page.waitForTimeout(250);
	}
	await page.getByTestId("gradient-intensity").fill("9");
	await page.getByTestId("gradient-intensity").blur();
	await fileIn("Effect: chest-burst", "assets/effects/chest-burst.json", (t) => t.includes('[0,"#fff0b0",1,9]'));
	await page.waitForTimeout(600);
	await step("57-effect-editor", page);
	await page.getByTestId("effect-json-tab").click();
	await page.getByTestId("effect-json").waitFor();
	await page.getByRole("button", { name: "+ New…" }).click();
	await page.getByTestId("effect-new-procedural").click();
	await page.getByTestId("effect-new-name").fill("smoke");
	await page.getByTestId("effect-new-create").click();
	await page.getByTestId("particle-texture").waitFor({ timeout: 30_000 });
	await step("58-particle-texture", page);
	await page.getByTestId("asset-item").filter({ hasText: "chest-burst" }).click();
	await page.getByTestId("effect-emitter-tab").first().click();
	await page.getByTestId("effect-texture").selectOption("effects/textures/smoke/smoke.png");
	await fileIn("Effect: chest-burst", "assets/effects/chest-burst.json", (t) => t.includes('"texture": "effects/textures/smoke/smoke.png"') && t.includes('"flipbook": [4,4]'));

	// The menu collapses to an icon rail; its buttons keep their names (as tooltips).
	await page.getByTestId("sidebar-toggle").click();
	await nav.getByRole("button", { name: "Scenes" }).click();
	await page.getByTestId("scene-editor").waitFor();
	await step("27-sidebar-collapsed", page);
	await page.getByTestId("sidebar-toggle").click();
	await nav.getByRole("button", { name: "Source Control" }).waitFor();
	// The menu's groups (Project, Game, Visual, Audio) fold away and come back.
	await page.getByTestId("nav-group-toggle-audio").click();
	await page.getByTestId("nav-group-toggle-visual").click();
	await nav.getByRole("button", { name: "Music" }).waitFor({ state: "hidden" });
	await nav.getByRole("button", { name: "Textures" }).waitFor({ state: "hidden" });
	await step("27c-sidebar-groups-folded", page);
	await page.getByTestId("nav-group-toggle-audio").click();
	await page.getByTestId("nav-group-toggle-visual").click();
	await nav.getByRole("button", { name: "Music" }).waitFor();
	// The worktree bar hides with the button beside Collapse, and comes back.
	await page.getByTestId("worktree-bar-toggle").click();
	await page.getByTestId("worktree-picker").waitFor({ state: "hidden" });
	await step("27b-worktree-bar-hidden", page);
	await page.getByTestId("worktree-bar-toggle").click();
	await page.getByTestId("worktree-current").waitFor();

	// Sound Effects: "New sound" starts a Sound Designer session whose takes (fake worker) make a sound; the section
	// shows it, its takes and where it's used, and using a second take re-renders it with two variants.
	await nav.getByRole("button", { name: "Sound Effects" }).click();
	await page.getByRole("button", { name: "+ New sound" }).click();
	await page.locator(".agent-type.on", { hasText: "Sound Designer" }).waitFor();
	await page.getByTestId("new-session-prompt").fill('tool generate_sound_takes {"name": "e2e-chime", "prompt": "a small bright chime", "seconds": 1, "count": 4, "seed": 7}');
	await page.getByRole("button", { name: "Start session" }).click();
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*brightness_hz/).waitFor({ timeout: 60_000 });
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await page.getByTestId("composer").fill('tool render_sound {"name": "e2e-chime"}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*e2e-chime\.ogg/).waitFor({ timeout: 60_000 });
	await nav.getByRole("button", { name: "Sound Effects" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "e2e-chime" }).click();
	await page.locator("[data-testid=sound-detail] [data-testid=render-status][data-state=current]").waitFor({ timeout: 30_000 });
	await page.getByTestId("take").nth(3).waitFor();
	await page.getByTestId("variant-row").first().waitFor();
	await step("28-sounds", page);
	// Tick two unused takes and make them the variants (one take each).
	await page.locator("[data-testid=take][data-used=false]").nth(0).getByTestId("take-select").check();
	await page.locator("[data-testid=take][data-used=false]").nth(1).getByTestId("take-select").check();
	await page.getByTestId("compose-replace").click();
	await page.getByTestId("variant-row").nth(1).waitFor({ timeout: 30_000 });
	await page.locator("[data-testid=sound-detail] [data-testid=render-status][data-state=current]").waitFor({ timeout: 30_000 });
	await step("29-sound-variants", page);
	// Merging is the worktree's, from the sidebar (saving the section's edits first); the sound then shows as in the game.
	await page.getByTestId("worktree-merge").click();
	await page.getByTestId("merge-confirm").filter({ hasText: "Save and merge" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "e2e-chime" }).getByTestId("change-label").waitFor({ state: "detached", timeout: 30_000 });
	await page.getByTestId("variant-row").nth(1).waitFor();
	await step("30-sound-merged", page);

	// Voice Lines: "New voice" starts a Voice Director session that performs a line (fake worker); the section shows the
	// voice and the line's takes; a second line is added and performed by hand there, and another take of it is chosen.
	await nav.getByRole("button", { name: "Voice Lines" }).click();
	await page.getByRole("button", { name: "+ New voice" }).click();
	await page.locator(".agent-type.on", { hasText: "Voice Director" }).waitFor();
	await page.getByTestId("new-session-prompt").fill('tool generate_voice_takes {"name": "e2e-narrator", "line": "intro", "text": "Long ago, in a forest.", "direction": "Calm.", "voice": "An old storyteller with a deep voice.", "count": 2, "seed": 11}');
	await page.getByRole("button", { name: "Start session" }).click();
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*intro\.ogg/).waitFor({ timeout: 60_000 });
	await page.locator(".session-detail .status-idle").waitFor({ timeout: 30_000 });
	await nav.getByRole("button", { name: "Voice Lines" }).click();
	await page.getByTestId("asset-item").filter({ hasText: "e2e-narrator" }).click();
	const intro = page.locator('[data-testid=voice-line][data-line=intro][data-state=ok]');
	await intro.getByTestId("voice-take").nth(1).waitFor({ timeout: 30_000 });
	await intro.getByTestId("line-play").waitFor();
	await page.getByTestId("new-line-id").fill("warning");
	await page.getByTestId("new-line-text").fill("Run!");
	await page.getByTestId("new-line-direction").fill("Shouting.");
	await page.getByTestId("new-line-perform").click();
	const warning = page.locator("[data-testid=voice-line][data-line=warning]");
	await warning.getByTestId("voice-take").nth(3).waitFor({ timeout: 60_000 });
	await warning.getByTestId("take-match").first().filter({ hasText: /^\d\.\d{3}/ }).waitFor();
	const before = await warning.locator(".voice-take.chosen").getAttribute("data-take");
	await warning.getByTestId("take-use").first().click();
	await page.waitForFunction((was) => { const now = document.querySelector("[data-line=warning] .voice-take.chosen")?.getAttribute("data-take"); return !!now && now !== was; }, before, { timeout: 30_000 });
	await step("52-voice-lines", page);
	await page.getByTestId("worktree-merge").click();
	await page.getByTestId("merge-confirm").click();
	await page.getByTestId("asset-item").filter({ hasText: "e2e-narrator" }).getByTestId("change-label").waitFor({ state: "detached", timeout: 30_000 });

	// Sub-agents: a session delegates a task; the Sessions list shows the child under its parent, and the child
	// links back to it.
	await nav.getByRole("button", { name: "Sessions" }).click();
	await page.getByRole("button", { name: "+ New session" }).click();
	await page.locator(".agent-type.on", { hasText: "Chief Director" }).waitFor();
	await page.getByTestId("new-session-prompt").fill('tool delegate {"agentType": "gameplay-engineer", "task": "a note from the sub-agent", "title": "Sub-agent note"}');
	await page.getByRole("button", { name: "Start session" }).click();
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*Noted: a note from the sub-agent/).waitFor({ timeout: 60_000 });
	// Its report is back, so the sub-agent is done: the filters (In progress, Idle) hide it like any done session,
	// and its parent's row says so; clicking that shows it anyway.
	const parentRow = page.locator("[data-testid=session-item][data-depth='0']").filter({ hasText: "1 sub-agent" }).first();
	await parentRow.waitFor({ timeout: 10_000 });
	if (await page.locator("[data-testid=session-item][data-depth='1']").count()) throw new Error("a done sub-agent should be hidden by the status filters");
	await parentRow.getByTestId("subagents-hidden").filter({ hasText: "1 hidden" }).click();
	await page.locator("[data-testid=session-item][data-depth='1']", { hasText: "Sub-agent note" }).filter({ hasText: "Done" }).waitFor();
	await step("32-session-tree", page);
	// The chat is the conversation only: the agent's work is one folded line, and all of it is in Full transcript.
	const chat = page.getByTestId("chat");
	await chat.getByTestId("work-line").first().waitFor();
	if (await chat.locator(".tool, .thinking").count()) throw new Error("the chat should not show tool calls or thinking");
	await page.getByTestId("context-meter").waitFor();
	// Its sub-agents have a tab of their own: the tree below this session, each with how it stands; Done can be hidden.
	await page.getByTestId("session-tab-subagents").filter({ hasText: "1" }).click();
	await page.locator("[data-testid=subagent-row][data-status=done]").filter({ hasText: "Sub-agent note" }).filter({ hasText: "Done" }).waitFor();
	await page.getByTestId("subagents-summary").filter({ hasText: "1 done" }).waitFor();
	await step("66-session-subagents", page);
	await page.getByTestId("subagents-show-done").uncheck();
	await page.getByTestId("subagent-row").waitFor({ state: "detached" });
	await page.getByTestId("subagents").getByText("1 done sub-agent hidden").waitFor();
	await page.getByTestId("subagents-show-done").check();
	await page.getByTestId("subagent-row").waitFor();
	await page.getByTestId("session-tab-chat").click();
	await step("63-session-chat", page);
	// Scrolled up (here in a pane squeezed to a sliver), the chat stays put and offers "Jump to latest".
	await page.getByTestId("chat-scroll").evaluate((el) => {
		(el as HTMLElement).style.maxHeight = "60px";
		el.scrollTop = 0;
		el.dispatchEvent(new Event("scroll"));
	});
	await page.getByTestId("jump-latest").click();
	await page.getByTestId("jump-latest").waitFor({ state: "detached" });
	if (!(await page.getByTestId("chat-scroll").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 48))) throw new Error("Jump to latest didn't return to the end");
	await page.getByTestId("chat-scroll").evaluate((el) => ((el as HTMLElement).style.maxHeight = ""));
	await chat.getByTestId("work-line").first().click();
	await page.getByTestId("transcript").locator(".tool").first().waitFor();
	await step("64-session-transcript", page);
	await page.getByTestId("session-tab-chat").click();
	// An unsent message is still there after a visit elsewhere.
	await page.getByTestId("composer").fill("an unsent thought");
	await nav.getByRole("button", { name: "Worktrees" }).click();
	await page.getByTestId("worktrees-page").waitFor();
	await nav.getByRole("button", { name: "Sessions" }).click();
	if ((await page.getByTestId("composer").inputValue()) !== "an unsent thought") throw new Error("the unsent message was lost");
	await page.getByTestId("composer").fill("");
	// All worktrees: every session, in a section per worktree.
	await page.getByTestId("sessions-all").click();
	await page.getByTestId("session-section").nth(1).waitFor();
	await step("65-sessions-all-worktrees", page);
	await page.getByTestId("sessions-all").click();
	await page.getByTestId("session-section").first().waitFor({ state: "detached" });
	// A question from the agent: picking a suggestion puts it in the answer box, where it can be reworded; what's in
	// the box is what Send answer sends.
	await page.getByTestId("composer").fill('tool ask_user {"question": "Which colour should the crate be?", "options": ["Red", "Blue with a white stripe"]}');
	await page.getByTestId("composer").press("Enter");
	await page.getByTestId("question").getByText("Which colour should the crate be?").waitFor({ timeout: 30_000 });
	await page.getByTestId("question-option").nth(1).click();
	if ((await page.getByTestId("question-answer").inputValue()) !== "Blue with a white stripe") throw new Error("picking a suggestion should fill the answer box");
	await page.locator(".question-option.picked", { hasText: "Blue with a white stripe" }).waitFor();
	await step("67-question", page);
	await page.getByTestId("question-answer").fill("Blue with a thin white stripe");
	if (await page.locator(".question-option.picked").count()) throw new Error("a reworded answer is no longer the suggestion");
	await page.getByTestId("question-send").click();
	await page.getByTestId("chat").getByText(/^Result:[\s\S]*Blue with a thin white stripe/).waitFor({ timeout: 30_000 });
	await page.getByTestId("question").waitFor({ state: "detached" });
	await parentRow.getByTestId("subagents-hidden").click(); // shown again: leaving the page forgot it
	await page.locator("[data-testid=session-item][data-depth='1']", { hasText: "Sub-agent note" }).click();
	await page.getByTestId("session-family").getByText("↑ Sub-agent of").waitFor();

	// Source control and accounts render.
	await page.getByRole("button", { name: "Source Control" }).click();
	await page.locator(".list-row", { hasText: "studio: worktree" }).first().waitFor();
	await page.locator("code", { hasText: "⎇ main" }).waitFor();
	await step("06-source-control", page);
	// A project only on this machine: no Push/Pull, a Publish form instead.
	if (await page.getByRole("button", { name: "Push", exact: true }).count()) throw new Error("Push shown for a project with no remote");
	await page.getByTestId("local-only").waitFor();
	await page.getByTestId("publish-open").click();
	await page.getByTestId("publish-url").fill("git@github.com:someone/e2e-game.git");
	await step("06b-publish-form", page);
	await page.getByTestId("publish-form").getByRole("button", { name: "Cancel" }).click();
	await page.getByTestId("publish-open").waitFor();
	await nav.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Accounts", exact: true }).click();
	await page.getByText("Available models").waitFor();
	await step("07-accounts", page);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await page.getByTestId("agent-type-card").filter({ hasText: "Delegates to: Game Designer, Art Director, UI Designer, Shader Author, VFX Artist, Audio Director" }).waitFor();
	await step("33-agent-types", page);
	// Picking a type opens its models; the graph view shows who delegates to whom. A change is kept in Settings and can be reset.
	await page.getByTestId("agent-type-card").filter({ has: page.locator("strong", { hasText: /^Gameplay Engineer$/ }) }).click();
	await page.getByTestId("agent-panel").locator("strong", { hasText: "Gameplay Engineer" }).waitFor();
	await page.getByTestId("agent-panel").getByText("Default model").waitFor();
	await page.getByTestId("agents-layout-graph").click();
	await page.getByTestId("agent-node").filter({ hasText: "Chief Director" }).waitFor();
	const allowOpus = page.getByTestId("agent-allow-model").and(page.locator("[data-model='anthropic/claude-opus-5-5']"));
	if (!(await allowOpus.isChecked())) throw new Error("a parent should be allowed to start the Gameplay Engineer on Opus by default");
	await step("33a-agent-graph", page);
	await allowOpus.click(); // saved through Settings, so the box changes a moment later (not `uncheck`, which expects it at once)
	await page.getByTestId("agent-models-reset").waitFor();
	if (await allowOpus.isChecked()) throw new Error("unticking a model should stop parents choosing it");
	await step("33b-agent-models-changed", page);
	await page.getByTestId("agent-models-reset").click();
	await page.getByTestId("agent-models-reset").waitFor({ state: "detached" });
	if (!(await allowOpus.isChecked())) throw new Error("Reset should bring back what AGENT.md says");
	await page.getByTestId("agents-layout-list").click();

	// Engine (and studio) worktrees are in the selector too, under their repo: selecting one shows its sessions,
	// leaves the sections on the game's main, and merges into that repo's main.
	await selectMain(page);
	const engineSession = (await page.evaluate(() =>
		window.studio.call("sessions.create", { agentType: "engine-engineer", target: "engine", model: "faux/echo", prompt: "an engine note" }),
	)) as { id: string; worktreeId: string };
	await page.waitForFunction(async (id) => ((await window.studio.call("sessions.list")) as { id: string; status: string }[]).some((s) => s.id === id && s.status === "idle"), engineSession.id, { timeout: 30_000 });
	await page.getByTestId("worktree-current").click();
	const engineGroup = page.getByTestId("worktree-group-engine");
	await engineGroup.getByTestId("worktree-option").filter({ hasText: "an engine note" }).waitFor({ timeout: 15_000 });
	await step("51-worktrees-by-repo", page);
	await engineGroup.getByTestId("worktree-option").filter({ hasText: "an engine note" }).click();
	await page.getByTestId("worktree-repo").filter({ hasText: "engine" }).waitFor();
	await page.getByTestId("worktree-repo-note").waitFor();
	await nav.getByRole("button", { name: "Sessions" }).click();
	await page.getByTestId("sessions-scope").filter({ hasText: "(engine)" }).waitFor();
	await page.getByTestId("session-item").filter({ hasText: "an engine note" }).waitFor();
	await page.getByTestId("worktree-merge").click();
	await page.getByTestId("merge-confirm").click();
	await page.getByTestId("worktree-current").filter({ hasText: "main" }).waitFor({ timeout: 30_000 });
	if (readFileSync(join(engineRepo, "faux-notes.md"), "utf8") !== "an engine note\n") throw new Error("the engine worktree's merge didn't reach the engine's main");
	await nav.getByRole("button", { name: "Settings" }).click(); // where the steps after this expect to be

	// The Worktrees page (also reached from the bar's menu): every open worktree with its size; a clean, idle one's
	// folder can go, and switching to it brings it back with its committed work. Main is one click away too.
	await selectMain(page);
	await page.getByTestId("worktree-current").click();
	await page.getByTestId("worktree-manage").click();
	await page.getByTestId("worktrees-page").waitFor();
	await page.getByTestId("worktrees-main").getByText("current").waitFor();
	await nav.getByTestId("worktrees-count").waitFor();
	const noteRow = page.getByTestId("worktrees-row").filter({ hasText: "add a note" });
	await noteRow.getByTestId("worktrees-size").filter({ hasText: "MB" }).waitFor({ timeout: 15_000 });
	await page.getByTestId("worktrees-space-total").waitFor();
	await step("50-worktrees-page", page);
	// View changes: a worktree's files by section, images and models marked as not text.
	await page.getByTestId("worktrees-row").filter({ hasText: "generate_concept_images" }).getByTestId("worktrees-changes").click();
	await page.getByTestId("changes-files").getByText("3D Models").waitFor();
	await page.getByTestId("changes-file").filter({ hasText: "barrel-1.png" }).filter({ hasText: /\d (B|KB|MB)$/ }).waitFor();
	await step("50a-worktree-changes", page);
	await page.getByTestId("changes-file").filter({ hasText: /\+\d/ }).first().click();
	await page.locator(".diff-line.add").first().waitFor();
	await step("50a2-worktree-changes-file", page);
	await page.getByTestId("changes-back").click();
	await page.getByTestId("worktrees-page").waitFor();
	await noteRow.getByTestId("worktrees-unload").click();
	await noteRow.getByTestId("worktrees-size").filter({ hasText: "no folder" }).waitFor({ timeout: 15_000 });
	await noteRow.getByTestId("worktrees-switch").click();
	await noteRow.getByTestId("worktrees-current").waitFor({ timeout: 30_000 });
	await page.getByTestId("worktrees-switch-main").click();
	await page.getByTestId("worktree-current").filter({ hasText: "main" }).waitFor();
	await noteRow.getByTestId("worktrees-switch").click();
	await step("50b-worktrees-page-current", page);
	// Update all: every worktree behind main is updated, one by one; those that don't conflict stop offering Update.
	const behindBefore = await page.getByTestId("worktrees-update").count();
	await page.getByTestId("worktrees-update-all").click();
	await page.getByTestId("notice").filter({ hasText: /Updated \d+ worktrees? from main/ }).waitFor({ timeout: 120_000 });
	await page.waitForTimeout(1500);
	const behindAfter = await page.getByTestId("worktrees-update").count();
	if (!(behindBefore > 0 && behindAfter < behindBefore)) throw new Error(`Update all left ${behindAfter} of ${behindBefore} worktrees behind main`);
	await step("50c-worktrees-updated", page);
	// Update engine: the engine's main moved on (the engine worktree merged above), so main and each game worktree
	// offer to pin its latest; taking it in a worktree commits the new pin on that worktree's branch only.
	await page.getByTestId("worktrees-main").getByTestId("worktrees-update-engine").waitFor({ timeout: 15_000 });
	await noteRow.getByTestId("worktrees-update-engine").click();
	await page.getByTestId("notice").filter({ hasText: "Updated the engine in" }).waitFor({ timeout: 60_000 });
	await noteRow.getByTestId("worktrees-update-engine").waitFor({ state: "hidden", timeout: 15_000 });
	const pins = (await page.evaluate(async () => {
		const id = ((await window.studio.call("worktrees.list")) as { id: string; label: string; status: string }[]).find((w) => w.label === "add a note" && w.status === "active")!.id;
		return [await window.studio.call("git.engineInfo", id), await window.studio.call("git.engineInfo", null)];
	})) as { pinned: string; latest: string; behind: number }[];
	if (pins[0].pinned !== pins[0].latest || pins[1].behind < 1) throw new Error(`Update engine: the worktree pins ${pins[0].pinned} (latest ${pins[0].latest}); main is ${pins[1].behind} behind`);
	await step("50d-worktrees-engine", page);
	await nav.getByRole("button", { name: "Settings" }).click(); // where the steps after this expect to be
	await page.getByTestId("worktree-current").filter({ hasText: "add a note" }).waitFor({ timeout: 30_000 });
	const notePath = await page.evaluate(async () => ((await window.studio.call("worktrees.list")) as { label: string; path: string; status: string }[]).find((w) => w.label === "add a note" && w.status === "active")!.path);
	await page.waitForFunction(async (p) => ((await window.studio.call("worktrees.list")) as { path: string; checkout: string }[]).some((w) => w.path === p && w.checkout === "active"), notePath, { timeout: 30_000 });
	if (readFileSync(join(notePath, "faux-notes.md"), "utf8") !== "add a note\nsecond note\n") throw new Error("the reloaded worktree lost its work");

	// Release: an itch.io key, the release settings (a manual edit in a worktree), what ships, a Linux build checked from
	// its own folder and against the game's tests, then publishing it (to the stand-in butler: nothing is uploaded).
	await page.getByRole("button", { name: "Accounts", exact: true }).click();
	await page.getByTestId("itch-key").fill("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
	await page.getByTestId("itch-account").getByRole("button", { name: "Save" }).click();
	await page.getByTestId("itch-account").getByText("API key saved").waitFor();
	await selectMain(page);
	await nav.getByRole("button", { name: "Release" }).click();
	await page.getByTestId("release").getByText("No releases yet.").waitFor();
	await step("59-release-empty", page);
	// A new release is only its settings (no platforms): it lands in the list, with a tab per platform and nothing built.
	await page.getByTestId("release-new").click();
	await page.getByTestId("release-version").fill("1.0.0");
	await page.getByTestId("release-itch").fill("e2e/e2e-game");
	await step("59a-release-new", page);
	await page.getByTestId("release-save").click();
	await page.getByTestId("release-item").filter({ hasText: "E2E Game 1.0.0" }).waitFor({ timeout: 30_000 });
	await page.getByTestId("release-none").getByText("No Linux build of 1.0.0 yet").waitFor();
	await page.getByTestId("release-tab-files").click();
	await page.getByTestId("release-files").getByText("scenes/main.json").waitFor();
	await page.getByTestId("release-tab-linux").click();
	await step("59b-release-not-built", page);
	await page.getByTestId("release-build").click();
	// While it builds, the tab says so: the step it's on and for how long (and it survives leaving the page).
	await page.getByTestId("release-building").getByText("Building 1.0.0 for Linux").waitFor({ timeout: 30_000 });
	await nav.getByRole("button", { name: "Scenes" }).click();
	await nav.getByRole("button", { name: "Release" }).click();
	await page.getByTestId("release-building").getByTestId("release-elapsed").waitFor({ timeout: 10_000 });
	await step("60a-release-building", page);
	await page.locator("[data-testid=release-built][data-standing=ok]").waitFor({ timeout: 240_000 });
	await page.getByTestId("release-status").getByText("Linux build: every check passed").waitFor();
	await page.getByTestId("release-run").waitFor();
	await page.getByTestId("release-rebuild").waitFor();
	await step("60-release-built", page);
	await page.getByTestId("release-publish").click();
	await page.getByTestId("release-log").getByText("Uploaded").waitFor({ timeout: 30_000 });
	const pushed = readFileSync(join(root, "butler-args"), "utf8");
	if (!/^push \S+\/builds\/1\.0\.0\/linux\/e2e-game e2e\/e2e-game:linux --userversion 1\.0\.0 -i /.test(pushed)) throw new Error(`butler was called with: ${pushed}`);
	await step("61-release-published", page);
	// A build that fails outright (here: game code that doesn't compile) says so, and a session is started to look into it.
	const releasePath = await page.evaluate(async () => ((await window.studio.call("worktrees.list")) as { label: string; path: string; status: string }[]).find((w) => w.label === "Release 1.0.0" && w.status === "active")!.path);
	writeFileSync(join(releasePath, "game/zz_broken.odin"), "package game\n\nthis is not odin\n");
	await page.getByTestId("release-tab-windows").click();
	await page.getByTestId("release-none").getByText("No Windows build of 1.0.0 yet").waitFor();
	await page.getByTestId("release-build").click();
	await page.locator("[data-testid=release-built][data-standing=failed]").waitFor({ timeout: 120_000 });
	rmSync(join(releasePath, "game/zz_broken.odin"));
	await page.getByTestId("release-status").getByText("The Windows build failed").waitFor();
	await page.getByTestId("release-error").waitFor();
	if (await page.getByTestId("release-run").count()) throw new Error("a failed build has nothing to run");
	await step("62a-release-failed", page);
	await page.getByTestId("release-session").click();
	await page.getByTestId("chat").getByText("the build failed: no package was made").waitFor({ timeout: 30_000 });
	await step("62b-release-investigation", page);
	await nav.getByRole("button", { name: "Release" }).click();
	// The web build: built on demand like the others (Emscripten), checked in a hidden browser window.
	if (existsSync(join(realEngine, "third_party/lib/web/libraylib.a"))) {
		await page.getByTestId("release-tab-web").click();
		await page.getByTestId("release-build").click();
		await page.locator("[data-testid=release-built]").waitFor({ timeout: 240_000 });
		await step("62-release-web", page);
		await page.getByTestId("release-status").getByText("Web build: every check passed").waitFor({ timeout: 5_000 });
		await page.getByTestId("release-built").getByText("e2e-game-1.0.0-web.zip").waitFor();
	}
	// Deleting the release takes its builds with it (the confirm dialog is accepted by the test).
	await page.getByTestId("release-delete").click();
	await page.getByTestId("release").getByText("No releases yet.").waitFor({ timeout: 30_000 });
	if (existsSync(join(releasePath, "builds/1.0.0"))) throw new Error("deleting a release should remove its builds");
	await nav.getByRole("button", { name: "Settings" }).click();

	// Appearance: a theme and fonts apply at once (the page's variables), survive a reload, and Simple Dark comes back.
	await page.getByRole("button", { name: "Appearance", exact: true }).click();
	await page.locator("[data-testid=theme-card][data-theme-id=catppuccin-mocha]").waitFor();
	await step("40-appearance", page);
	await page.locator("[data-testid=theme-card][data-theme-id=catppuccin-latte]").click();
	await page.getByTestId("font-option").filter({ hasText: "Inter" }).first().click();
	const look = () => page.evaluate(() => ({ bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), font: getComputedStyle(document.body).fontFamily }));
	if ((await look()).bg !== "#eff1f5" || !(await look()).font.includes("Inter")) throw new Error(`appearance not applied: ${JSON.stringify(await look())}`);
	await page.reload();
	await nav.getByRole("button", { name: "Scenes" }).waitFor();
	if ((await look()).bg !== "#eff1f5") throw new Error("the theme didn't survive a reload");
	await nav.getByRole("button", { name: "Scenes" }).click();
	await page.getByTestId("asset-item").first().waitFor();
	await page.waitForTimeout(500);
	await step("41-theme-latte", page);
	await nav.getByRole("button", { name: "Code", exact: true }).click();
	await page.locator(".code-line").first().waitFor();
	await step("42-theme-latte-code", page);
	await nav.getByRole("button", { name: "Settings" }).click();
	await page.getByRole("button", { name: "Appearance", exact: true }).click();
	await page.locator("[data-testid=theme-card][data-theme-id=simple-dark]").click();
	await page.getByTestId("font-option").filter({ hasText: "System" }).first().click();
	console.log(`passed; screenshots in ${shots}`);
	passed = true;
} catch (err) {
	const page = await app.firstWindow();
	await page.screenshot({ path: join(shots, "failed.png") });
	console.error(`failed; see ${join(shots, "failed.png")}`);
	console.error(err); // before closing: a close that hangs would hide it
	throw err;
} finally {
	// A running game (the Scenes live view) makes app.close() hang: stop it first.
	await (await app.firstWindow()).evaluate(() => window.studio.call("run.stop")).catch(() => {});
	// Never hang the run on a close that doesn't finish: kill the app after a while.
	const closed = await Promise.race([app.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15_000))]);
	if (!closed) {
		console.error("app.close() hung; killing the app");
		app.process().kill("SIGKILL");
	}
	// The temp project, worktrees and engine clone (~150 MB in /tmp, which is RAM): kept only to debug a failure.
	if (passed) rmSync(root, { recursive: true, force: true });
	else console.error(`kept ${root} for debugging`);
}
