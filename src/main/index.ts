import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { StudioApi, StudioEvent, StudioMethod } from "../shared/ipc";
import type { ProjectInfo, Target } from "../shared/types";
import { loadAgentTypes } from "./agent-types";
import * as g from "./git";
import { utilityHostLink } from "./host-link";
import { createProject, readProject } from "./project";
import { SessionService } from "./sessions";
import { SettingsStore } from "./settings";
import { openTerminal } from "./terminal";

// A separate user-data dir lets a second studio instance (tests, studio-engineer sessions) run alongside.
if (process.env.GAME_STUDIO_USER_DATA) app.setPath("userData", process.env.GAME_STUDIO_USER_DATA);

const appRoot = app.getAppPath();
const piDir = join(app.getPath("userData"), "pi");
const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
let project: ProjectInfo | null = null;
let win: BrowserWindow | null = null;

function emit(event: StudioEvent): void {
	win?.webContents.send("studio:event", event);
}

async function main(): Promise<void> {
	await app.whenReady();
	const host = await utilityHostLink(piDir, process.env.GAME_STUDIO_FAUX === "1" ? { GAME_STUDIO_FAUX: "1" } : {});
	const agentTypes = () => loadAgentTypes(join(appRoot, "agent-types"), project?.path);
	const sessions = new SessionService({
		host,
		settings: () => settings.get(),
		projectPath: () => project?.path ?? null,
		agentTypes,
		skillsDir: join(appRoot, "skills"),
		emit,
		idleTimeoutMs: 10 * 60_000,
	});

	const repo = (target: Target) => sessions.repoFor(target);
	const setProject = (info: ProjectInfo | null) => {
		project = info;
		if (info) settings.rememberProject(info.path);
		else settings.update({ lastProject: undefined });
		sessions.load();
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
			openTerminal(cwd, [join(appRoot, "node_modules/.bin/pi"), "--session", sessionFile], { PI_CODING_AGENT_DIR: piDir });
		},
	};

	ipcMain.handle("studio:call", (_e, method: StudioMethod, args: unknown[]) =>
		(handlers[method] as (...a: unknown[]) => unknown)(...args),
	);

	const last = settings.get().lastProject;
	if (last && existsSync(join(last, ".studio/project.json"))) project = readProject(last);
	sessions.load();
	createWindow();

	app.on("window-all-closed", () => {
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

