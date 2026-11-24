import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: {
			rollupOptions: {
				input: {
					index: resolve("src/main/index.ts"),
					"session-host": resolve("src/session-host/index.ts"),
					"audio-worker": resolve("src/main/audio-worker.ts"),
				},
			},
		},
	},
	preload: {
		build: {
			rollupOptions: { input: { index: resolve("src/preload/index.ts") } },
		},
	},
	renderer: {
		root: "src/renderer",
		build: {
			// Local desktop app: readable stack traces beat a smaller bundle.
			minify: false,
			// remote.html: the page remote access serves to a browser on Pat's tailnet (src/main/remote-server.ts).
			rollupOptions: { input: { index: resolve("src/renderer/index.html"), remote: resolve("src/renderer/remote.html") } },
		},
		plugins: [react()],
	},
});
