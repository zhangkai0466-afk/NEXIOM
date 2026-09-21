import { contextBridge, ipcRenderer } from "electron";
import type { Command, DesktopBridge } from "../../packages/contracts";
type ThemeSource = "system" | "light" | "dark";
type ThemeState = { source: ThemeSource; resolved: "light" | "dark" };
const startupTheme = ipcRenderer.sendSync("appearance:startup-theme") as unknown;
const isThemeSource = (value: unknown): value is ThemeSource =>
  value === "system" || value === "light" || value === "dark";
const isThemeState = (value: unknown): value is ThemeState => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ThemeState>;
  return (
    isThemeSource(candidate.source) &&
    (candidate.resolved === "light" || candidate.resolved === "dark")
  );
};
const applyStartupTheme = () => {
  if (!document.documentElement || !isThemeState(startupTheme)) return;
  document.documentElement.dataset.startupTheme = startupTheme.resolved;
  document.documentElement.dataset.startupThemeSource = startupTheme.source;
  document.documentElement.style.colorScheme = startupTheme.resolved;
};
if (document.documentElement) applyStartupTheme();
else {
  const documentObserver = new MutationObserver(() => {
    if (!document.documentElement) return;
    documentObserver.disconnect();
    applyStartupTheme();
  });
  documentObserver.observe(document, { childList: true });
}
const bridge: DesktopBridge & {
  getTheme(): Promise<ThemeState>;
  setTheme(source: ThemeSource): Promise<ThemeState>;
  onThemeChanged(listener: (theme: ThemeState) => void): () => void;
} = {
  request: (command: Command) => ipcRenderer.invoke("core:request", command),
  openProject: () => ipcRenderer.invoke("project:open"),
  chooseProjectFolder: () => ipcRenderer.invoke("project:choose-folder"),
  openSelectedProject: (root, name) => ipcRenderer.invoke("project:open-selected", root, name),
  openThreadWindow: (threadId) => ipcRenderer.invoke("thread:open-window", threadId),
  reportReady: () => ipcRenderer.send("desktop:ready"),
  whenWindowShown: () => ipcRenderer.invoke("desktop:when-window-shown"),
  reportStartupComplete: () => ipcRenderer.send("desktop:startup-complete"),
  reportFailure: (kind) => ipcRenderer.send("desktop:failure", kind),
  setWindowModalState: (open) => ipcRenderer.send("desktop:modal-state", open),
  openStartupLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  applyUpdate: () => ipcRenderer.invoke("desktop:apply-update"),
  getTheme: () => ipcRenderer.invoke("appearance:get"),
  setTheme: (source) => ipcRenderer.invoke("appearance:set", source),
  onThemeChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, theme: ThemeState) =>
      listener(theme);
    ipcRenderer.on("appearance:changed", handler);
    return () => ipcRenderer.removeListener("appearance:changed", handler);
  },
  subscribe: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("core:changed", handler);
    return () => ipcRenderer.removeListener("core:changed", handler);
  },
};
contextBridge.exposeInMainWorld("nexiom", bridge);
window.addEventListener("error", () => bridge.reportFailure?.("script-error"));
window.addEventListener("unhandledrejection", () => bridge.reportFailure?.("unhandled-rejection"));
