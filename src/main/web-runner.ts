// Web builds in a browser: a static server for a package folder, and the release checks' runner, which opens the page
// in a hidden window of the studio's own Chromium and waits for the game to exit.
import { BrowserWindow, session } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import type { BrowserRun } from "./release";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".wasm": "application/wasm",
	".png": "image/png",
	".txt": "text/plain; charset=utf-8",
};

/** Serves `dir` on a free port of this machine only. `page` rewrites index.html on its way out. */
export function serveFolder(dir: string, page?: (html: string) => string): Promise<{ url: string; server: Server }> {
	const server = createServer((req, res) => {
		const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
		const file = join(dir, path === "/" ? "index.html" : path);
		if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
		res.end(page && file.endsWith("index.html") ? page(readFileSync(file, "utf8")) : readFileSync(file));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }));
	});
}

/** The release checks' browser: the package served as it is, the extra files handed to the page as window.gameFiles. */
export const runInBrowser: BrowserRun = async ({ dir, args, files, timeoutMs }) => {
	const inject = `<script>window.gameFiles = Object.fromEntries(Object.entries(${JSON.stringify(
		Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b.toString("base64")])),
	)}).map(([p, b]) => [p, Uint8Array.from(atob(b), (c) => c.charCodeAt(0))]));</script>`;
	const { url, server } = await serveFolder(dir, (html) => html.replace("<script", () => `${inject}<script`));
	// Each run in a storage of its own, in memory: checks run side by side, and a game that keeps something in the
	// page's storage (a map editor's maps) mustn't see another run's, nor what an earlier build on the same port left.
	const partition = `gs-check-${randomUUID()}`;
	const win = new BrowserWindow({ width: 1280, height: 720, useContentSize: true, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, partition } });
	// A check, not a play: the page runs the game with its sound on (a web build has no hidden mode), so mute the window.
	win.webContents.setAudioMuted(true);
	const lines: string[] = [];
	let stopped: string | undefined;
	win.webContents.on("console-message", (e: unknown, _level?: unknown, legacy?: unknown) => {
		const text = typeof legacy === "string" ? legacy : String((e as { message?: string }).message ?? "");
		lines.push(text);
		if (text.startsWith("game stopped:")) stopped = text;
	});
	win.webContents.on("render-process-gone", (_e, d) => (stopped = `the page crashed (${d.reason})`));
	try {
		await win.loadURL(`${url}?${args.map(encodeURIComponent).join("&").replace(/%3D/g, "=").replace(/%2F/g, "/")}`);
		const end = Date.now() + timeoutMs;
		for (;;) {
			if (stopped) return { code: -1, output: lines.join("\n") };
			const code = (await win.webContents.executeJavaScript("window.gameExit === undefined ? null : window.gameExit").catch(() => null)) as number | null;
			if (code !== null) return { code, output: lines.join("\n") };
			if (Date.now() > end) return { code: -1, output: `${lines.join("\n")}\ntimed out after ${Math.round(timeoutMs / 1000)} s` };
			await new Promise((r) => setTimeout(r, 100));
		}
	} finally {
		win.destroy();
		server.close();
		await session.fromPartition(partition).clearStorageData().catch(() => {});
	}
};
