import { contextBridge, ipcRenderer } from "electron";
import type { StudioBridge, StudioEvent } from "../shared/ipc";

const bridge: StudioBridge = {
	call: ((method: string, ...args: unknown[]) => ipcRenderer.invoke("studio:call", method, args)) as StudioBridge["call"],
	onEvent(listener) {
		const handler = (_e: unknown, event: StudioEvent) => listener(event);
		ipcRenderer.on("studio:event", handler);
		return () => ipcRenderer.off("studio:event", handler);
	},
};

contextBridge.exposeInMainWorld("studio", bridge);
