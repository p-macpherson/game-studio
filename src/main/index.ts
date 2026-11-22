import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { leafName } from "../shared/asset-names";
import { EditHistory } from "./edit-history";
import type { StudioApi, StudioEvent, StudioMethod } from "../shared/ipc";
import type { ProjectInfo, Target } from "../shared/types";
import { agentTypeCache } from "./agent-types";
import { AssetService, MODULES } from "./assets";
import * as g from "./git";
import { utilityHostLink } from "./host-link";
import { createProject, readProject, publishProject } from "./project";
import { GenService, soundfontPath } from "./gen";
import { assetRequests, moveStep } from "./asset-move";
import { designDocRequests } from "./design-docs";
import { workerAudio } from "./audio-runner";
import { modelRequests, ModelPipeline } from "./models";
import { MusicPipeline, musicRequests } from "./music";
import { sceneRequests } from "./scenes";
import { SoundPipeline, soundRequests, soundUsages } from "./sounds";
import { VoicePipeline, voiceRequests } from "./voices";
import { studioRequests } from "./studio-requests";
import { TexturePipeline, textureRequests } from "./textures";
import { effectRequests, ParticleTexturePipeline } from "./effects";
import { ReleaseService, releaseRequests } from "./release-service";
import { runInBrowser, serveFolder } from "./web-runner";
import { shaderRequests } from "./shaders";
import { UiArtPipeline, uiRequests } from "./ui";
import { texturePaths } from "../modules/textures/info";
import { RunService, type SceneView } from "./runner";
import { SessionService } from "./sessions";
import { SettingsStore } from "./settings";
import { registerStudioFileScheme, serveStudioFiles } from "./studio-files";
import { openTerminal } from "./terminal";

// A separate user-data dir lets a second studio instance (tests, studio-engineer sessions) run alongside.
if (process.env.GAME_STUDIO_USER_DATA) app.setPath("userData", process.env.GAME_STUDIO_USER_DATA);

registerStudioFileScheme();

const appRoot = app.getAppPath();
const piDir = join(app.getPath("userData"), "pi");
const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
let project: ProjectInfo | null = null;
let win: BrowserWindow | null = null;

function emit(event: StudioEvent): void {
	win?.webContents.send("studio:event", event);
	// Assets change when an agent's tool writes files in a worktree, or a session is merged/discarded.
	if ((event.type === "session_event" && (event.event.type === "tool_execution_end" || event.event.type === "agent_settled")) || event.type === "sessions_changed") {
		assetsChanged();
	}
}

let assetsTimer: NodeJS.Timeout | undefined;
function assetsChanged(): void {
	clearTimeout(assetsTimer);
	assetsTimer = setTimeout(() => win?.webContents.send("studio:event", { type: "assets_changed" } satisfies StudioEvent), 250);
}

/** Watches every module's asset folders in the open project's main checkout. */
let watchers: FSWatcher[] = [];
function watchProject(path: string | undefined): void {
	for (const w of watchers) w.close();
	watchers = [];
	if (!path) return;
	for (const root of MODULES.flatMap((m) => m.info.roots)) {
		const dir = join(path, root);
		if (existsSync(dir)) watchers.push(watch(dir, { recursive: true }, assetsChanged));
	}
}

async function main(): Promise<void> {
	await app.whenReady();
	// Sub-agents run side by side in the one session host, each maybe with a codemode script (Pi's default is 2 workers).
	const host = await utilityHostLink(piDir, { PI_CODEMODE_MAX_WORKERS: "8", ...(process.env.GAME_STUDIO_FAUX === "1" ? { GAME_STUDIO_FAUX: "1" } : {}) });
	const cachedAgentTypes = agentTypeCache(join(appRoot, "agent-types"));
	const agentTypes = () => cachedAgentTypes(project?.path);
	const genRoot = process.env.GAME_STUDIO_GEN ?? join(app.getPath("home"), ".local/share/game-studio/gen");
	const gen = new GenService({
		root: genRoot,
		codeDir: join(appRoot, "gen"),
		emit,
		fake: process.env.GAME_STUDIO_GEN_FAKE === "1",
	});
	const pipeline = new ModelPipeline(gen);
	// Decoding, mixing and encoding whole pieces happens in a worker thread, not on this one (the UI's and the game view's).
	const audio = workerAudio(join(import.meta.dirname, "audio-worker.js"));
	const music = new MusicPipeline({ soundfont: () => soundfontPath(genRoot), audio });
	const sounds = new SoundPipeline({ gen, audio });
	const voices = new VoicePipeline({ gen, audio });
	const textures = new TexturePipeline(gen);
	const uiArt = new UiArtPipeline(gen);
	// Every part of the studio brings its own requests: a new section adds a line here.
	const moduleInfos = MODULES.map((m) => m.info);
	const particles = new ParticleTexturePipeline(gen);
	const requests = studioRequests(
		gen,
		modelRequests(pipeline, (sessionId, name) => previewModel(sessionId, name)),
		musicRequests(music),
		soundRequests(sounds),
		voiceRequests(voices),
		textureRequests(textures),
		sceneRequests((sessionId, p) => runner.previewScene(sessionId, String(p.scene), p.views as SceneView[] | undefined)),
		uiRequests(uiArt, (sessionId, p) => runner.previewUi(sessionId, p.screen, p.values)),
		shaderRequests({ check: (sessionId, name) => runner.checkShader(sessionId, name), preview: (sessionId, p) => runner.previewShader(sessionId, p) }),
		effectRequests(particles, (sessionId, p) => runner.previewEffect(sessionId, p)),
		assetRequests(moduleInfos),
		designDocRequests(),
		releaseRequests(() => release),
	);
	const sessions = new SessionService({
		host,
		settings: () => settings.get(),
		projectPath: () => project?.path ?? null,
		agentTypes,
		skillsDir: join(appRoot, "skills"),
		emit,
		idleTimeoutMs: 10 * 60_000,
		studioRequest: requests.studioRequest,
		cancelStudioRequest: requests.cancelStudioRequest,
	});

	const runner = new RunService({ projectPath: () => project?.path ?? null, sessions, emit });
	/** The main checkout (null or "main"), a worktree (by id), or a session's worktree (by session id). */
	const checkoutRoot = (checkout: string | null): string => {
		if (!checkout || checkout === "main") {
			if (!project) throw new Error("No project is open");
			return project.path;
		}
		return sessions.checkoutPath(checkout);
	};
	serveStudioFiles(checkoutRoot);
	/** Web builds a person has opened: each package folder stays served until the studio quits. */
	const webServers = new Map<string, string>();
	const release = new ReleaseService({
		browser: runInBrowser,
		openWeb: async (dir) => {
			if (!webServers.has(dir)) webServers.set(dir, (await serveFolder(dir)).url);
			await shell.openExternal(webServers.get(dir)!);
		},
		checkoutRoot,
		projectName: () => project?.name ?? "Game",
		engineRepo: () => settings.get().engineRepo,
		dataDir: app.getPath("userData"),
		emit,
		butler: process.env.GAME_STUDIO_BUTLER,
		appimagetool: process.env.GAME_STUDIO_APPIMAGETOOL,
	});
	const assets = new AssetService(checkoutRoot, sessions);
	/** A generation job queued or running for a worktree (a section's step, or one of its sessions' tools). */
	const generating = (w: { id: string; sessionIds: string[] }) =>
		gen.list().some((j) => (j.status === "queued" || j.status === "running") && !!j.sessionId && (j.sessionId === w.id || w.sessionIds.includes(j.sessionId)));
	// Undo/redo of people's manual edits, per worktree, in memory (snapshots under userData, cleared at each launch).
	const history = new EditHistory(join(app.getPath("userData"), "edit-history"));
	/** A model rendered by the game's engine (for the In engine tab and the agents' preview_model tool). */
	async function previewModel(checkout: string | null, name: string) {
		const manifest = pipeline.manifest({ cwd: checkoutRoot(checkout) }, name);
		if (!manifest?.stats) throw new Error(`"${name}" has no 3D model yet`);
		return runner.preview(checkout, `assets/models/${name}/${leafName(name)}.glb`, manifest.height ?? 1);
	}
	const repo = (target: Target) => sessions.repoFor(target);
	const setProject = (info: ProjectInfo | null) => {
		void runner.stop();
		project = info;
		if (info) settings.rememberProject(info.path);
		else settings.update({ lastProject: undefined });
		sessions.load();
		watchProject(info?.path);
		emit({ type: "project_changed" });
		return info;
	};
	/** The engine a checkout of the game pins (main's, or an open game worktree's branch) against the engine's latest. */
	const engineInfo = async (checkout?: string | null) => {
		if (!project) return null;
		const dir = checkout ? checkoutRoot(checkout) : project.path;
		if (!existsSync(join(dir, "engine/.git"))) return null;
		// A worktree: what its branch records (its folder may lag an update from main until it's next looked at).
		const pinned = checkout ? (await g.git(dir, ["rev-parse", "HEAD:engine"])).trim() : await g.revParse(join(dir, "engine"), "HEAD");
		const engineRepo = settings.get().engineRepo;
		const latest = await g.revParse(engineRepo, "main");
		const behind = Number((await g.git(engineRepo, ["rev-list", "--count", `${pinned}..${latest}`]).catch(() => "0")).trim());
		return { pinned, latest, behind };
	};

	const handlers: StudioApi = {
		"host.info": () => host.call("info"),

		"settings.get": async () => settings.get(),
		"settings.update": async (patch) => {
			const next = settings.update(patch);
			sessions.load();
			return next;
		},

		"project.current": async () => project,
		"project.open": async (path) => {
			const dir = path ?? (await pickFolder("Open game project"));
			return dir ? setProject(readProject(dir)) : null;
		},
		"project.create": async (path, name) => {
			const info = await createProject({ path, name, templateDir: join(appRoot, "templates/game"), engineRepo: settings.get().engineRepo });
			setProject(info);
			return info;
		},
		"project.close": async () => {
			setProject(null);
		},
		"dialog.pickFolder": (title) => pickFolder(title),

		// hasRemote only here (Source Control): status() runs for every worktree, often, and one more git call each
		// isn't free (and races a worktree being removed).
		"git.status": async (target) => ({ ...(await g.status(repo(target))), hasRemote: !!(await g.git(repo(target), ["remote"])).trim() }),
		"git.diff": async (target, path, staged) => {
			const args = staged ? ["diff", "--cached", "--", path] : ["diff", "--", path];
			const out = await g.git(repo(target), args);
			if (out || staged) return out;
			return g.git(repo(target), ["diff", "--no-index", "/dev/null", path]).catch((err: Error) => err.message.replace(/^git diff: /, ""));
		},
		"git.stage": async (target, paths) => {
			await g.git(repo(target), ["add", "-A", "--", ...paths]);
		},
		"git.unstage": async (target, paths) => {
			await g.git(repo(target), ["restore", "--staged", "--", ...paths]);
		},
		"git.discardFile": async (target, path) => {
			const st = await g.status(repo(target));
			const file = st.files.find((f) => f.path === path);
			if (file?.index === "?") await g.git(repo(target), ["clean", "-f", "--", path]);
			else await g.git(repo(target), ["restore", "--", path]);
		},
		"git.commit": async (target, message) => {
			await g.git(repo(target), ["commit", "-q", "-m", message]);
		},
		"git.log": (target, limit) => g.log(repo(target), limit),
		"git.push": (target) => g.git(repo(target), ["push"]),
		"git.pull": (target) => g.git(repo(target), ["pull", "--ff-only"]),
		"git.publish": (url) => publishProject(repo("project"), url),
		"git.engineInfo": engineInfo,
		"git.updateEngine": async (checkout) => {
			const info = await engineInfo(checkout);
			if (!project || !info) throw new Error("This project has no engine submodule");
			if (checkout) {
				await sessions.updateWorktreeEngine(checkout, info.latest);
				history.clear(checkout);
				return;
			}
			const engine = join(project.path, "engine");
			await g.git(engine, ["-c", "protocol.file.allow=always", "fetch", "-q", settings.get().engineRepo, "main"]);
			await g.git(engine, ["checkout", "-q", info.latest]);
			await g.commitPaths(project.path, ["engine"], `Update engine to ${info.latest.slice(0, 7)}`);
		},

		"accounts.providers": async () => host.call("providers"),
		"accounts.login": (loginId, provider, type) => host.call("login", loginId, provider, type),
		"accounts.answer": async (loginId, value) => host.call("loginAnswer", loginId, value),
		"accounts.logout": (provider) => host.call("logout", provider),
		"models.available": () => host.call("models"),

		"agentTypes.list": async () => agentTypes(),

		"modules.list": async () => MODULES.map((m) => m.info),
		"assets.list": (moduleId, checkout) => assets.list(moduleId, checkout ?? null),
		"assets.read": async (path, checkout) => assets.read(path, checkout ?? null),
		"assets.search": async (moduleId, query, checkout) => assets.search(moduleId, query, checkout ?? null),
		"assets.links": async (checkout) => assets.links(checkout ?? null),
		"assets.move": async (moduleId, checkout, from, to) => {
			const step = moveStep(moduleInfos, from, to);
			return history.record(checkout, checkoutRoot(checkout), step.label, step.scopes, async () => assets.move(moduleId, checkout, from, to));
		},

		"run.checkouts": async () => runner.checkouts(),
		"run.current": async () => runner.current(),
		"run.build": (sessionId) => runner.build(sessionId),
		"run.start": (sessionId, mode, options) => runner.start(sessionId, mode, options),
		"run.stop": () => runner.stop(),
		"run.call": (cmd, args) => runner.call(cmd, args),
		"run.stream": async (on) => runner.setStreaming(on),
		"run.tests": async (sessionId) => runner.tests(sessionId),
		"run.test": (sessionId, script) => runner.test(sessionId, script),
		"run.image": async (sessionId, path) => runner.image(sessionId, path),

		"gen.status": async () => gen.status(),
		"gen.jobs": async () => gen.list(),
		"gen.cancel": async (jobId) => gen.cancel(jobId),
		"gen.install": async () => gen.install(),
		// A section's step: a person's manual edit, recorded for undo (previews change nothing and aren't).
		"worktrees.run": (worktreeId, method, params) => {
			const cwd = checkoutRoot(worktreeId);
			const run = () => requests.studioRequest({ sessionId: worktreeId, requestId: `ui-${Date.now()}`, cwd, method, params, progress: () => {} });
			const step = requests.step(method, params);
			return step ? history.record(worktreeId, cwd, step.label, step.scopes, run) : run();
		},
		"worktrees.commits": (id) => sessions.worktreeCommits(id),
		"release.info": async (checkout) => release.info(checkout),
		"release.build": (checkout, target) => release.build(checkout, target),
		"release.run": async (checkout, version, target) => release.run(checkout, version, target),
		"release.reveal": async (checkout, version, target) => void (await shell.openPath(release.folder(checkout, version, target))),
		"release.publish": (checkout, version, target) => release.publish(checkout, version, target),
		"release.itchStatus": (checkout) => release.itchStatus(checkout),
		"itch.hasKey": async () => release.hasItchKey(),
		"itch.setKey": async (key) => release.setItchKey(key),
		"worktrees.status": (id) => sessions.worktreeStatus(id),
		"worktrees.space": async () => {
			const open = sessions.listWorktrees().filter((w) => w.status === "active");
			return Promise.all(open.map(async (w) => ({ id: w.id, bytes: await sessions.worktreeBytes(w.id), blocker: await sessions.worktreeUnloadBlocker(w.id, generating(w)) })));
		},
		"worktrees.unload": async (id) => {
			const w = sessions.listWorktrees().find((x) => x.id === id);
			await sessions.unloadWorktree(id, !!w && generating(w));
			history.clear(id);
		},
		"worktrees.load": (id) => sessions.loadWorktree(id),
		"music.stems": async (checkout, name) =>
			Promise.all(
				(await music.stems({ cwd: checkoutRoot(checkout) }, name, join(app.getPath("userData"), "music-stems"))).map(async (s) => ({ track: s.track, ogg: new Uint8Array(readFileSync(s.file)) })),
			),
		"music.previewInstrument": async (instrument) => new Uint8Array(await music.preview(instrument, join(app.getPath("userData"), "music-previews"))),
		"worktrees.update": async (id) => {
			const r = await sessions.updateWorktree(id);
			history.clear(id); // the merge changed files under the manual-edit history
			return r;
		},
		"worktrees.abortUpdate": (id) => sessions.abortWorktreeUpdate(id),
		"worktrees.resolveConflicts": (id, model) => sessions.resolveWorktreeConflicts(id, model),
		"history.get": async (worktreeId) => ({ steps: history.steps(worktreeId), unsaved: await sessions.worktreeUnsaved(worktreeId) }),
		"history.undo": async (worktreeId) => history.undo(worktreeId, checkoutRoot(worktreeId)),
		"history.redo": async (worktreeId) => history.redo(worktreeId, checkoutRoot(worktreeId)),
		"worktrees.save": async (id, message) => {
			await sessions.saveWorktree(id, message);
			history.clear(id);
		},
		"worktrees.revert": async (id) => {
			await sessions.revertWorktree(id);
			history.clear(id);
		},
		"models3d.concepts": async (checkout, name) => pipeline.conceptImages({ cwd: checkoutRoot(checkout) }, name),
		"models3d.preview": (checkout, name) => previewModel(checkout, name),
		"textures.candidates": async (checkout, name) => {
			const dir = join(checkoutRoot(checkout), "assets/textures", name, "candidates");
			return Object.entries(textures.candidateRecords(checkoutRoot(checkout), name))
				.filter(([f]) => existsSync(join(dir, f)))
				.map(([f, r]) => ({ source: `candidates/${f}`, ...r }))
				.sort((a, b) => b.at.localeCompare(a.at) || a.source.localeCompare(b.source));
		},
		"effects.textureCandidates": async (checkout, name) =>
			Object.entries(particles.candidateRecords(checkoutRoot(checkout), name) as Record<string, { seed?: number }>).map(([file, r]) => ({ source: `candidates/${file}`, seed: r.seed })),
		"ui.artCandidates": async (checkout, name) =>
			Object.entries(uiArt.candidateRecords(checkoutRoot(checkout), name) as Record<string, { slice?: number[] }>).map(([file, r]) => ({ source: `candidates/${file}`, slice: r.slice ?? [] })),
		"textures.preview": async (checkout, name) => {
			const t = textures.read(checkoutRoot(checkout), name);
			return runner.previewTexture(checkout, texturePaths(name), t?.tile ?? 2);
		},
		"sounds.usages": async (checkout, name) => soundUsages(checkoutRoot(checkout), name),
		"voices.takes": async (checkout, name) => voices.takes(checkoutRoot(checkout), name),

		"gen.image": async (path) => {
			// Only images from generation outputs, the open project or session worktrees.
			const full = resolve(path);
			const allowed = [gen.status().root, project?.path, settings.get().worktreeRoot].filter((r): r is string => !!r).map((r) => resolve(r) + sep);
			if (!/\.(png|jpe?g|webp)$/i.test(full) || !allowed.some((r) => full.startsWith(r))) throw new Error(`Not a studio image: ${path}`);
			const mime = full.endsWith(".png") ? "image/png" : full.endsWith(".webp") ? "image/webp" : "image/jpeg";
			return `data:${mime};base64,${readFileSync(full).toString("base64")}`;
		},

		"sessions.list": async () => sessions.list(),
		"sessions.create": (req) => sessions.create(req),
		"sessions.messages": (id) => sessions.messages(id),
		"sessions.send": (id, text, mode) => sessions.send(id, text, mode),
		"sessions.abort": (id) => sessions.abort(id),
		"sessions.setModel": (id, model) => sessions.setModel(id, model),
		"sessions.answer": (id, questionId, answer) => sessions.answer(id, questionId, answer),
		"sessions.diff": (id) => sessions.diff(id),
		"sessions.changedFiles": (id) => sessions.changedFiles(id),
		"worktrees.list": async () => sessions.listWorktrees(),
		"worktrees.create": (label) => sessions.createWorktree("project", label),
		"worktrees.rename": async (id, label) => sessions.renameWorktree(id, label),
		"worktrees.merge": async (id) => {
			await sessions.mergeWorktree(id);
			history.clear(id);
		},
		"worktrees.discard": async (id) => {
			await sessions.discardWorktree(id);
			history.clear(id);
		},
		"worktrees.changedFiles": (id) => sessions.worktreeChangedFiles(id),
		"sessions.raw": async (id) => sessions.raw(id),
		"sessions.merge": async (id) => {
			const worktree = sessions.get(id).worktreeId;
			await sessions.merge(id);
			history.clear(worktree);
		},
		"sessions.discard": async (id) => {
			const worktree = sessions.get(id).worktreeId;
			await sessions.discard(id);
			history.clear(worktree);
		},
		"sessions.markDone": (id) => sessions.markDone(id),
		"sessions.resume": (id) => sessions.resume(id),
		"sessions.archived": async () => sessions.listArchived(),
		"sessions.restore": (id) => sessions.restore(id),
		"sessions.openTerminal": async (id) => {
			const { cwd, sessionFile } = await sessions.releaseForTerminal(id);
			// Like the studio's own sessions, the CLI gets the codemode tool.
			openTerminal(cwd, [join(appRoot, "node_modules/.bin/pi"), "--session", sessionFile, "--tools", "+codemode"], { PI_CODING_AGENT_DIR: piDir });
		},
	};

	ipcMain.handle("studio:call", (_e, method: StudioMethod, args: unknown[]) =>
		(handlers[method] as (...a: unknown[]) => unknown)(...args),
	);

	const last = settings.get().lastProject;
	if (last && existsSync(join(last, ".studio/project.json"))) project = readProject(last);
	sessions.load();
	watchProject(project?.path);
	setMenu();
	createWindow();

	app.on("window-all-closed", () => {
		runner.dispose();
		sessions.dispose();
		audio.dispose();
		host.kill();
		// Model workers hold the GPU: wait (a few seconds at most) until they have really gone before quitting.
		void Promise.race([gen.dispose(), new Promise((r) => setTimeout(r, 6000))]).finally(() => app.quit());
	});
}

async function pickFolder(title: string): Promise<string | null> {
	const result = await dialog.showOpenDialog(win!, { title, properties: ["openDirectory", "createDirectory"] });
	return result.canceled ? null : result.filePaths[0];
}

/** Electron's default menu, except Undo/Redo: the page decides between text undo and the manual-edit history. */
function setMenu(): void {
	const send = (command: "undo" | "redo") => () => win?.webContents.send("studio:event", { type: "edit_command", command } satisfies StudioEvent);
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: "fileMenu" },
			{
				label: "Edit",
				submenu: [
					{ label: "Undo", accelerator: "CmdOrCtrl+Z", click: send("undo") },
					{ label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: send("redo") },
					{ label: "Redo", accelerator: "CmdOrCtrl+Y", click: send("redo"), visible: false, acceleratorWorksWhenHidden: true },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				],
			},
			{ role: "viewMenu" },
			{ role: "windowMenu" },
		]),
	);
}

function createWindow(): void {
	win = new BrowserWindow({
		width: 1440,
		height: 900,
		title: project ? `${project.name} — Game Studio` : "Game Studio",
		backgroundColor: "#16181d",
		webPreferences: { preload: join(import.meta.dirname, "../preload/index.mjs"), sandbox: false },
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: "deny" };
	});
	if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
	else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.on("browser-window-created", (_e, w) => w.on("page-title-updated", (ev) => ev.preventDefault()));
void main().catch((err) => {
	console.error(err);
	app.exit(1);
});

