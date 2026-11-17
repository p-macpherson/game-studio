import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { SessionHostClient } from "./session-host-client";

// A separate user-data dir lets a second studio instance (tests, studio-engineer sessions) run alongside.
if (process.env.GAME_STUDIO_USER_DATA) app.setPath("userData", process.env.GAME_STUDIO_USER_DATA);

let host: SessionHostClient;

function createWindow(): void {
	const win = new BrowserWindow({
		width: 1400,
		height: 900,
		title: "Game Studio",
		webPreferences: { preload: join(import.meta.dirname, "../preload/index.mjs"), sandbox: false },
	});
	if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
	else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
	host = new SessionHostClient(join(app.getPath("userData"), "pi"));
	ipcMain.handle("hostInfo", () => host.request({ type: "info" }));
	createWindow();
});

app.on("window-all-closed", () => {
	host?.kill();
	app.quit();
});
