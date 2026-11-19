import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { join, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { StudioApi, StudioEvent, StudioMethod } from "../shared/ipc";
import type { ProjectInfo, Target } from "../shared/types";
import { loadAgentTypes } from "./agent-types";
import { AssetService, MODULES } from "./assets";
import * as g from "./git";
import { utilityHostLink } from "./host-link";
import { createProject, readProject } from "./project";
import { GenService } from "./gen";
import { generationRequests, ModelPipeline } from "./models";
import { RunService } from "./runner";
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
	const host = await utilityHostLink(piDir, process.env.GAME_STUDIO_FAUX === "1" ? { GAME_STUDIO_FAUX: "1" } : {});
	const agentTypes = () => loadAgentTypes(join(appRoot, "agent-types"), project?.path);
	const gen = new GenService({
		root: process.env.GAME_STUDIO_GEN ?? join(app.getPath("home"), ".local/share/game-studio/gen"),
		codeDir: join(appRoot, "gen"),
		emit,
		fake: process.env.GAME_STUDIO_GEN_FAKE === "1",
	});
	const pipeline = new ModelPipeline(gen);
	const genRequests = generationRequests(pipeline, gen);
	const sessions = new SessionService({
		host,
		settings: () => settings.get(),
		projectPath: () => project?.path ?? null,
		agentTypes,
		skillsDir: join(appRoot, "skills"),
		emit,
		idleTimeoutMs: 10 * 60_000,
		...genRequests,
	});

	const assets = new AssetService(() => project?.path ?? null, sessions);
	const runner = new RunService({ projectPath: () => project?.path ?? null, sessions, emit });
	/** The main checkout (null or "main") or a session's worktree. */
	const checkoutRoot = (checkout: string | null): string => {
		if (!checkout || checkout === "main") {
			if (!project) throw new Error("No project is open");
			return project.path;
		}
		const s = sessions.get(checkout);
		if (s.worktree !== "active") throw new Error(`Session "${s.title}" has no worktree; resume it first`);
		return s.worktreePath;
	};
	serveStudioFiles(checkoutRoot);
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
	const engineInfo = async () => {
		if (!project || !existsSync(join(project.path, "engine/.git"))) return null;
		const pinned = await g.revParse(join(project.path, "engine"), "HEAD");
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

		"git.status": (target) => g.status(repo(target)),
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
		"git.engineInfo": engineInfo,
		"git.updateEngine": async () => {
			const info = await engineInfo();
			if (!project || !info) throw new Error("This project has no engine submodule");
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
		"assets.list": (moduleId) => assets.list(moduleId),
		"assets.read": async (path, sessionId) => assets.read(path, sessionId),
		"assets.search": async (moduleId, query) => assets.search(moduleId, query),

		"run.checkouts": async () => runner.checkouts(),
		"run.current": async () => runner.current(),
		"run.build": (sessionId) => runner.build(sessionId),
		"run.start": (sessionId, mode) => runner.start(sessionId, mode),
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
		"models3d.workspace": (name, linkedAsset) => {
			const type = agentTypes().find((t) => t.id === "3d-modeller");
			if (!type) throw new Error("The 3D Modeller agent type is missing");
			return sessions.create({
				agentType: type.id,
				target: "project",
				model: type.defaultModel ?? "anthropic/claude-sonnet-5-5",
				prompt: "",
				title: `Model: ${name}`,
				linkedAsset,
			});
		},
		"models3d.run": (sessionId, method, params) =>
			genRequests.studioRequest({ sessionId, requestId: `ui-${Date.now()}`, cwd: checkoutRoot(sessionId), method, params, progress: () => {} }),
		"models3d.concepts": async (checkout, name) => pipeline.conceptImages({ cwd: checkoutRoot(checkout) }, name),
		"models3d.preview": async (checkout, name) => {
			const manifest = pipeline.manifest({ cwd: checkoutRoot(checkout) }, name);
			if (!manifest?.stats) throw new Error(`"${name}" has no 3D model yet`);
			return runner.preview(checkout, `assets/models/${name}/${name}.glb`, manifest.height ?? 1);
		},

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
		"sessions.raw": async (id) => sessions.raw(id),
		"sessions.merge": (id) => sessions.merge(id),
		"sessions.discard": (id) => sessions.discard(id),
		"sessions.markDone": (id) => sessions.markDone(id),
		"sessions.resume": (id) => sessions.resume(id),
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
	createWindow();

	app.on("window-all-closed", () => {
		runner.dispose();
		void gen.dispose();
		sessions.dispose();
		host.kill();
		app.quit();
	});
}

async function pickFolder(title: string): Promise<string | null> {
	const result = await dialog.showOpenDialog(win!, { title, properties: ["openDirectory", "createDirectory"] });
	return result.canceled ? null : result.filePaths[0];
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

