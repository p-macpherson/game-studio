import { contextBridge, ipcRenderer } from "electron";
import type { StudioApi } from "../shared/ipc";

const api: StudioApi = {
	hostInfo: () => ipcRenderer.invoke("hostInfo"),
};

contextBridge.exposeInMainWorld("studio", api);
