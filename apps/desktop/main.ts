import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Tray,
  utilityProcess,
  safeStorage,
  nativeTheme,
  shell,
} from "electron";
import {
  access,
  lstat,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  rename,
  unlink,
} from "node:fs/promises";
import { commandSchema } from "../../packages/contracts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { startupLogger } from "./startup-log";
import { obsoleteReleaseDirectoryNames } from "./update";

app.setName("NEXIOM");

let window: BrowserWindow | null = null;
const threadWindows = new Set<BrowserWindow>();
const modalWindowIds = new Set<number>();
let tray: Tray | null = null;
let worker: ReturnType<typeof utilityProcess.fork>;
let alive = false;
let resolveCoreReady = () => {};
let rejectCoreReady = (_error: Error) => {};
const coreReady = new Promise<void>((resolve, reject) => {
  resolveCoreReady = resolve;
  rejectCoreReady = reject;
});
let coreSecretRollback = false;
let quitting = false;
let updateRestartScheduled = false;
let releaseCleanupStarted = false;
let rendererReady = false;
let startupAnimationActive = true;
let startupTimer: NodeJS.Timeout | undefined;
let windowShowTimer: NodeJS.Timeout | undefined;
let windowShowDeadline = 0;
let windowShown = false;
let windowRevealing = false;
let resolveWindowShown = () => {};
const whenWindowShown = new Promise<void>((resolve) => { resolveWindowShown = resolve; });
let recoveryOpen = false;
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
const pagePath = path.join(__dirname, "../dist/index.html");
const pageUrl = pathToFileURL(pagePath).href;
const appIconPath = path.join(__dirname, "../assets/brand/nexiom-desktop-icon.ico");
type ThemeSource = "system" | "light" | "dark";
let themeSource: ThemeSource = "dark";
let themeWrite = Promise.resolve();
if (process.env.NEXIOM_USER_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.NEXIOM_USER_DATA_DIR));
const appearancePath = path.join(app.getPath("userData"), "appearance.json");
const startup = startupLogger(app.getPath("userData"));
startup.log("process-start", { version: app.getVersion(), electron: process.versions.electron });
async function cleanupObsoleteReleases() {
  // Isolated development/QA profiles may run beside the user's real instance.
  // Never let those auxiliary processes clean shared packaged releases.
  if (process.env.NEXIOM_USER_DATA_DIR) return;
  const currentDirectory = path.dirname(process.execPath);
  const releaseRoot = path.dirname(currentDirectory);
  const currentName = path.basename(currentDirectory);
  let entries;
  try {
    entries = await readdir(releaseRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const obsolete = new Set(
    obsoleteReleaseDirectoryNames(
      entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      currentName,
    ),
  );
  for (const entry of entries) {
    if (!obsolete.has(entry.name) || !entry.isDirectory()) continue;
    const target = path.resolve(releaseRoot, entry.name);
    if (path.dirname(target) !== path.resolve(releaseRoot)) continue;
    try {
      const stats = await lstat(target);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      await rm(target, { recursive: true, force: false });
      startup.log("release-cleaned", { version: entry.name });
    } catch (error) {
      startup.log("release-cleanup-failed", {
        version: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
function scheduleReleaseCleanup() {
  if (releaseCleanupStarted) return;
  releaseCleanupStarted = true;
  setTimeout(() => void cleanupObsoleteReleases(), 800);
}
async function findUpdateSourceRoot() {
  const executableRoot = path.resolve(path.dirname(process.execPath), "../..");
  const candidates = [
    process.env.NEXIOM_SOURCE_DIR,
    executableRoot,
    process.cwd(),
    path.resolve(process.cwd(), "../.."),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    const key = root.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      if (manifest.name !== "nexiom") continue;
      await access(path.join(root, "scripts/build-live-update.ps1"));
      await access(path.join(root, "scripts/package-windows.mjs"));
      return root;
    } catch {
      // Try the next constrained candidate.
    }
  }
  throw new Error(
    "没有找到 NEXIOM 源码目录。请确认桌面版仍位于源码目录的 release 文件夹中。",
  );
}
function runPowerShellScript(script: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-16_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        const detail = output.trim().split(/\r?\n/).slice(-12).join("\n");
        reject(new Error(detail || `更新构建进程退出，代码 ${code ?? "未知"}。`));
      }
    });
  });
}
async function buildAndScheduleUpdate() {
  const sourceRoot = await findUpdateSourceRoot();
  const releaseRoot = path.join(sourceRoot, "release");
  const staging = path.join(releaseRoot, `.nexiom-update-${randomUUID()}`);
  const buildScript = path.join(sourceRoot, "scripts/build-live-update.ps1");
  try {
    await runPowerShellScript(
      buildScript,
      ["-SourceRoot", sourceRoot, "-StagingDirectory", staging],
      sourceRoot,
    );
    await access(path.join(staging, "NEXIOM.exe"));
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`构建最新 NEXIOM 失败：${detail}`);
  }

  const executable = path.join(staging, "NEXIOM.exe");
  const shortcutPath = path.join(app.getPath("desktop"), "NEXIOM.lnk");
  let previousShortcut: ReturnType<typeof shell.readShortcutLink> | null = null;
  try {
    previousShortcut = shell.readShortcutLink(shortcutPath);
  } catch {
    // A missing shortcut is created below.
  }
  const shortcutWritten = shell.writeShortcutLink(shortcutPath, "replace", {
    target: executable,
    cwd: staging,
    icon: path.join(staging, "resources/app/assets/brand/nexiom-desktop-icon.ico"),
    iconIndex: 0,
    description: "NEXIOM",
  });
  if (!shortcutWritten) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new Error("无法更新桌面快捷方式，当前 NEXIOM 已保留运行。");
  }
  try {
    app.relaunch({ execPath: executable, args: [] });
  } catch (error) {
    if (previousShortcut)
      shell.writeShortcutLink(shortcutPath, "replace", previousShortcut);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  startup.log("source-update-ready", { sourceRoot });
  setTimeout(() => app.quit(), 250);
  return { targetVersion: app.getVersion() };
}
function showStartupWindow(reason: string) {
  if (windowShown || windowRevealing || !window || window.isDestroyed()) return;
  windowRevealing = true;
  clearTimeout(windowShowTimer);
  window.show();
  // Chromium's first-paint notification precedes the Windows compositor commit.
  // Activate while still transparent, then expose the completed native frame.
  windowShowTimer = setTimeout(() => {
    if (!window || window.isDestroyed()) return;
    window.setOpacity(1);
    windowShown = true;
    resolveWindowShown();
    startup.log("window-shown", { reason });
  }, 120);
}
function showMainWindow(reason: string) {
  const target = window;
  if (!target || target.isDestroyed()) return;
  if (!windowShown) {
    showStartupWindow(reason);
    void whenWindowShown.then(() => {
      if (!target.isDestroyed()) target.focus();
    });
    return;
  }
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  startup.log("window-restored", { reason });
}
function armStartupWatchdog() {
  if (!window || window.isDestroyed()) return;
  rendererReady = false;
  startupAnimationActive = true;
  syncWindowChrome();
  clearTimeout(startupTimer);
  startupTimer = setTimeout(() => {
    if (!rendererReady) void recoverWindow("界面启动超时");
  }, 15000);
}
function loadApplication() {
  if (!window || window.isDestroyed()) return;
  armStartupWatchdog();
  void window.loadFile(pagePath).catch(() => {
    startup.log("load-file-rejected");
    void recoverWindow("无法加载界面文件");
  });
}
async function recoverWindow(reason: string) {
  if (recoveryOpen || quitting || !window || window.isDestroyed()) return;
  recoveryOpen = true;
  clearTimeout(startupTimer);
  finishStartupAnimation();
  startup.log("recovery-presented", { reason });
  showStartupWindow("recovery");
  window.show();
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: "error",
      title: "NEXIOM 启动恢复",
      message: reason,
      detail: "可以重新载入界面。项目文件和已保存的会话不会被清除。启动日志位于：\n" + startup.file,
      buttons: ["重新载入", "打开日志", "退出应用"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) loadApplication();
    else if (response === 1) {
      await shell.openPath(startup.directory);
      loadApplication();
    } else app.quit();
  } finally { recoveryOpen = false; }
}
function isThemeSource(value: unknown): value is ThemeSource {
  return value === "system" || value === "light" || value === "dark";
}
function themeState() {
  return {
    source: themeSource,
    resolved: nativeTheme.shouldUseDarkColors ? "dark" : "light",
  };
}
function themeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { background: "#181818", titlebar: "#1c2325", symbol: "#d4d6d6" }
    : { background: "#fafafa", titlebar: "#ecf6f9", symbol: "#4a4c4d" };
}
function startupThemeColors() {
  return themeState().resolved === "dark"
    ? { background: "#000000", titlebar: "#000000", symbol: "#ffffff" }
    : { background: "#fafafa", titlebar: "#fafafa", symbol: "#202020" };
}
function windowThemeColors() {
  return startupAnimationActive ? startupThemeColors() : themeColors();
}
function dimChromeColor(color: string) {
  const channels = color.slice(1).match(/.{2}/g);
  if (!channels || channels.length !== 3) return color;
  return `#${channels
    .map((channel) => Math.round(Number.parseInt(channel, 16) * (7 / 15)).toString(16).padStart(2, "0"))
    .join("")}`;
}
function syncBrowserWindowChrome(target: BrowserWindow, colors: ReturnType<typeof themeColors>) {
  target.setBackgroundColor(colors.background);
  if (process.platform !== "win32") return;
  const modalOpen = modalWindowIds.has(target.id);
  target.setTitleBarOverlay({
    color: modalOpen ? dimChromeColor(colors.titlebar) : colors.titlebar,
    symbolColor: modalOpen ? dimChromeColor(colors.symbol) : colors.symbol,
    height: 36,
  });
}
function finishStartupAnimation() {
  if (!startupAnimationActive) return;
  startupAnimationActive = false;
  syncWindowChrome();
}
function syncWindowChrome() {
  if (!window || window.isDestroyed()) return;
  syncBrowserWindowChrome(window, windowThemeColors());
}
function syncWindowTheme() {
  if (!window || window.isDestroyed()) return;
  syncWindowChrome();
  window?.webContents.send("appearance:changed", themeState());
  const colors = themeColors();
  for (const child of threadWindows) {
    if (child.isDestroyed()) continue;
    syncBrowserWindowChrome(child, colors);
    child.webContents.send("appearance:changed", themeState());
  }
}
function broadcastCoreChanged() {
  window?.webContents.send("core:changed");
  for (const child of threadWindows)
    if (!child.isDestroyed()) child.webContents.send("core:changed");
}
function externalWebUrl(input: string): string | null {
  if (input.length > 8192 || /[\u0000-\u0020\u007f]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function request(
  packet: Record<string, unknown>,
  allowDuringSecretRollback = false,
): Promise<unknown> {
  if (!alive) return Promise.reject(new Error("本地核心不可用，请重启应用。"));
  if (coreSecretRollback && !allowDuringSecretRollback)
    return Promise.reject(new Error("本地核心正在安全回滚 API Key，请稍后重试。"));
  return coreReady.then(() => {
    if (!alive) throw new Error("本地核心不可用，请重启应用。");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("本地核心响应超时。"));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, ...packet });
    });
  });
}
function stopCoreAfterSecretRollbackFailure() {
  coreSecretRollback = true;
  if (!alive) return;
  alive = false;
  startup.log("core-stopped-after-secret-rollback-failure");
  const unavailable = new Error(
    "本地核心的 API Key 状态无法确认，已停止核心。请重启应用。",
  );
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(unavailable);
  }
  pending.clear();
  try {
    worker.kill();
  } catch {
    // The host remains fail-closed even if the child has already exited.
  }
  broadcastCoreChanged();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    startup.log("second-instance");
    showMainWindow("second-instance");
  });
  app.on("activate", () => showMainWindow("activate"));
  void app.whenReady().then(async () => {
    startup.log("app-ready");
    app.setAppUserModelId("NEXIOM.Desktop");
    try {
      const appearance = JSON.parse(await readFile(appearancePath, "utf8"));
      if (isThemeSource(appearance.theme)) themeSource = appearance.theme;
    } catch {
      // A missing or corrupt appearance preference uses the default dark theme.
    }
    nativeTheme.themeSource = themeSource;
    nativeTheme.on("updated", syncWindowTheme);
    worker = utilityProcess.fork(
      path.join(__dirname, "core.cjs"),
      [path.join(app.getPath("userData"), "workspace")],
      { serviceName: "NEXIOM Core" },
    );
    alive = true;
    worker.on("message", (packet) => {
      if (packet.type === "ready") {
        startup.log("core-ready");
        resolveCoreReady();
        return;
      }
      if (packet.type === "changed") {
        broadcastCoreChanged();
        return;
      }
      const item = pending.get(packet.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(packet.id);
      if (packet.error) item.reject(new Error(packet.error));
      else item.resolve(packet.result);
    });
    worker.on("exit", () => {
      startup.log("core-exit");
      alive = false;
      rejectCoreReady(new Error("本地核心启动失败。"));
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("本地核心已退出。"));
      }
      pending.clear();
      broadcastCoreChanged();
    });
    const assertSender = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
      const trustedContents = event.sender === window?.webContents || [...threadWindows].some((child) => !child.isDestroyed() && event.sender === child.webContents);
      if (
        !trustedContents ||
        event.senderFrame?.url.split("?")[0] !== pageUrl
      )
        throw new Error("不受信任的页面请求。");
    };
    ipcMain.on("desktop:ready", (event) => {
      try { assertSender(event); } catch { return; }
      if (!rendererReady) startup.log("renderer-ready");
      rendererReady = true;
      clearTimeout(startupTimer);
      // React mounting is not a painted frame. Give Chromium a short head start,
      // but never depend exclusively on ready-to-show (which can stall on Windows).
      if (!windowShown && !windowRevealing) {
        clearTimeout(windowShowTimer);
        const delay = Math.min(600, Math.max(0, windowShowDeadline - Date.now()));
        windowShowTimer = setTimeout(() => showStartupWindow("renderer-ready-fallback"), delay);
      }
    });
    ipcMain.handle("desktop:when-window-shown", async (event) => {
      assertSender(event);
      await whenWindowShown;
    });
    ipcMain.on("desktop:startup-complete", (event) => {
      try { assertSender(event); } catch { return; }
      if (startupAnimationActive) startup.log("startup-animation-complete");
      finishStartupAnimation();
      scheduleReleaseCleanup();
    });
    ipcMain.on("desktop:failure", (event, kind: unknown) => {
      try { assertSender(event); } catch { return; }
      if (!["react-render", "script-error", "unhandled-rejection"].includes(String(kind))) return;
      startup.log("renderer-error", { kind });
      finishStartupAnimation();
      if (kind === "react-render") {
        clearTimeout(startupTimer);
        showStartupWindow("render-error");
      }
    });
    ipcMain.on("desktop:modal-state", (event, open: unknown) => {
      try { assertSender(event); } catch { return; }
      if (typeof open !== "boolean") return;
      const target = BrowserWindow.fromWebContents(event.sender);
      if (!target || target.isDestroyed()) return;
      if (open) modalWindowIds.add(target.id);
      else modalWindowIds.delete(target.id);
      syncBrowserWindowChrome(target, target === window ? windowThemeColors() : themeColors());
    });
    ipcMain.handle("desktop:open-logs", async (event) => {
      assertSender(event);
      await shell.openPath(startup.directory);
    });
    ipcMain.handle("desktop:apply-update", async (event) => {
      assertSender(event);
      if (updateRestartScheduled) return { targetVersion: app.getVersion() };
      updateRestartScheduled = true;
      try {
        startup.log("source-update-started");
        return await buildAndScheduleUpdate();
      } catch (error) {
        updateRestartScheduled = false;
        throw error;
      }
    });
    ipcMain.handle("appearance:get", (event) => {
      assertSender(event);
      return themeState();
    });
    ipcMain.on("appearance:startup-theme", (event) => {
      event.returnValue = event.sender === window?.webContents || [...threadWindows].some((child) => !child.isDestroyed() && event.sender === child.webContents)
        ? themeState()
        : { source: "dark", resolved: "dark" };
    });
    ipcMain.handle("appearance:set", (event, source: unknown) => {
      assertSender(event);
      if (!isThemeSource(source)) throw new Error("无效的外观设置。");
      const change = themeWrite.then(async () => {
        await mkdir(app.getPath("userData"), { recursive: true });
        await writeFile(appearancePath, JSON.stringify({ theme: source }));
        themeSource = source;
        nativeTheme.themeSource = source;
        syncWindowTheme();
        return themeState();
      });
      themeWrite = change.then(
        () => {},
        () => {},
      );
      return change;
    });
    const legacySecretPath = path.join(
      app.getPath("userData"),
      "provider-key.enc",
    );
    const secretPath = path.join(
      app.getPath("userData"),
      "provider-secrets.enc",
    );
    let providerSecrets: Record<string, string> = {};
    const persistSecrets = async (secrets: Record<string, string>) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("系统密钥加密不可用，未保存 API Key。");
      await mkdir(app.getPath("userData"), { recursive: true });
      const temporaryPath = `${secretPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryPath,
          safeStorage.encryptString(JSON.stringify(secrets)),
          { mode: 0o600 },
        );
        await rename(temporaryPath, secretPath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
    };
    const restoreSecrets = (async () => {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          try {
            const encrypted = await readFile(secretPath);
            const parsed = JSON.parse(safeStorage.decryptString(encrypted));
            if (parsed && typeof parsed === "object")
              providerSecrets = Object.fromEntries(
                Object.entries(parsed).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string" && Boolean(entry[1]),
                ),
              );
          } catch {
            try {
              const encrypted = await readFile(legacySecretPath);
              const legacy = safeStorage.decryptString(encrypted);
              if (legacy) providerSecrets["legacy-custom"] = legacy;
            } catch {
              // No provider credentials have been saved on this device.
            }
          }
          await request({ runtimeSecrets: providerSecrets });
        }
      } catch {
        /* The settings UI remains available so the user can repair the vault. */
      }
    })();
    let secretMutation = Promise.resolve();
    ipcMain.handle("core:request", async (event, input) => {
      assertSender(event);
      await restoreSecrets;
      const command = commandSchema.parse(input);
      const changesSecret =
        command.type === "provider.upsert" &&
        (command.apiKey !== undefined || command.clearApiKey);
      if (command.type === "provider.upsert" || command.type === "provider.delete") {
        const mutation = secretMutation.then(async () => {
          const removesSecret =
            command.type === "provider.delete" &&
            Object.hasOwn(providerSecrets, command.providerId);
          if (!changesSecret && !removesSecret)
            return request({ command });
          if (!safeStorage.isEncryptionAvailable())
            throw new Error("系统密钥加密不可用，未保存 API Key。");
          const previousSecrets = { ...providerSecrets };
          const nextSecrets = { ...providerSecrets };
          const providerId =
            command.type === "provider.upsert"
              ? command.provider.id ?? randomUUID()
              : command.providerId;
          const coreCommand =
            command.type === "provider.upsert"
              ? {
                  ...command,
                  provider: { ...command.provider, id: providerId },
                }
              : command;
          if (command.type === "provider.upsert") {
            if (command.clearApiKey) delete nextSecrets[providerId];
            else if (command.apiKey) nextSecrets[providerId] = command.apiKey;
          } else delete nextSecrets[providerId];
          let secretsPersisted = false;
          try {
            await persistSecrets(nextSecrets);
            secretsPersisted = true;
            providerSecrets = nextSecrets;
            return await request({ command: coreCommand });
          } catch (error) {
            providerSecrets = previousSecrets;
            if (!secretsPersisted) throw error;

            coreSecretRollback = true;
            const failures: unknown[] = [error];
            const messages = [
              `模型供应商变更原始失败：${error instanceof Error ? error.message : String(error)}`,
            ];
            let coreRollbackFailed = false;
            try {
              await request(
                { runtimeSecrets: previousSecrets },
                true,
              );
            } catch (rollbackError) {
              coreRollbackFailed = true;
              failures.push(rollbackError);
              messages.push(
                `Core API Key 回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}；为防止继续使用状态未知的 API Key，本地核心已停止，请重启应用`,
              );
              stopCoreAfterSecretRollbackFailure();
            }
            try {
              await persistSecrets(previousSecrets);
            } catch (rollbackError) {
              failures.push(rollbackError);
              messages.push(
                `API Key 密钥库回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              );
            }
            if (!coreRollbackFailed) coreSecretRollback = false;
            throw new AggregateError(failures, messages.join("；"));
          }
        });
        secretMutation = mutation.then(
          () => {},
          () => {},
        );
        return mutation;
      }
      return request({ command });
    });
    ipcMain.handle("project:open", async (event) => {
      assertSender(event);
      await restoreSecrets;
      const selection = await dialog.showOpenDialog(window!, {
        properties: ["openDirectory"],
        title: "选择赛题工作文件夹",
        buttonLabel: "选择此文件夹",
      });
      return selection.canceled
        ? null
        : request({ openPath: selection.filePaths[0] });
    });
    ipcMain.handle("project:choose-folder", async (event) => {
      assertSender(event);
      const selection = await dialog.showOpenDialog(window!, {
        properties: ["openDirectory"],
        title: "添加项目文件夹",
        buttonLabel: "添加",
      });
      return selection.canceled ? null : selection.filePaths[0];
    });
    ipcMain.handle("project:open-selected", async (event, root: unknown, name: unknown) => {
      assertSender(event);
      await restoreSecrets;
      if (typeof root !== "string" || !root.trim())
        throw new Error("请选择源文件夹。");
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80)
        throw new Error("请输入有效的项目名称。");
      return request({ openPath: root, openName: name.trim() });
    });
    ipcMain.handle("thread:open-window", async (event, threadId: unknown) => {
      assertSender(event);
      if (typeof threadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(threadId))
        throw new Error("无效的对话标识。");
      const existing = [...threadWindows].find((child) => !child.isDestroyed() && child.webContents.getURL().includes(`thread=${threadId}`));
      if (existing) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return;
      }
      const colors = themeColors();
      const child = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 760,
        minHeight: 600,
        title: "NEXIOM",
        titleBarStyle: "hidden",
        titleBarOverlay: { color: colors.titlebar, symbolColor: colors.symbol, height: 36 },
        backgroundColor: colors.background,
        icon: appIconPath,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      threadWindows.add(child);
      child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      child.webContents.on("will-navigate", (navigationEvent, url) => {
        if (url.split("?")[0] !== pageUrl) navigationEvent.preventDefault();
      });
      child.webContents.on("will-frame-navigate", (navigationEvent) => {
        if (navigationEvent.url.split("?")[0] !== pageUrl) navigationEvent.preventDefault();
      });
      child.on("closed", () => {
        modalWindowIds.delete(child.id);
        threadWindows.delete(child);
      });
      await child.loadFile(pagePath, { query: { thread: threadId } });
    });
    const colors = windowThemeColors();
    window = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 760,
      minHeight: 600,
      // Warm up a transparent native window so Windows can composite its first
      // theme-colored frame without exposing the unpainted native surface.
      show: false,
      paintWhenInitiallyHidden: true,
      opacity: 0,
      title: "NEXIOM",
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: colors.titlebar,
        symbolColor: colors.symbol,
        height: 36,
      },
      backgroundColor: colors.background,
      icon: path.join(__dirname, "../assets/brand/nexiom-desktop-icon.ico"),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    try {
      tray = new Tray(appIconPath);
      tray.setToolTip("NEXIOM");
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "打开 NEXIOM", click: () => showMainWindow("tray-menu") },
        { type: "separator" },
        { label: "退出 NEXIOM", click: () => app.quit() },
      ]));
      tray.on("click", () => showMainWindow("tray-click"));
      tray.on("double-click", () => showMainWindow("tray-double-click"));
      startup.log("tray-ready");
    } catch {
      tray = null;
      startup.log("tray-failed");
    }
    startup.log("window-created");
    windowShowDeadline = Date.now() + 1500;
    windowShowTimer = setTimeout(() => showStartupWindow("show-timeout"), 1500);
    window.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) armStartupWatchdog();
    });
    window.webContents.on("did-start-loading", () => startup.log("page-loading"));
    window.webContents.on("dom-ready", () => startup.log("dom-ready"));
    window.webContents.on("did-finish-load", () => {
      startup.log("page-loaded");
      void window?.webContents.executeJavaScript("({ rootChildren: document.getElementById('root')?.childElementCount ?? 0, visibility: document.visibilityState })")
        .then((state) => startup.log("page-state", state)).catch(() => {});
    });
    window.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      startup.log("page-load-failed", { code, description, mainFrame });
      if (mainFrame && code !== -3) void recoverWindow("无法加载界面文件");
    });
    window.webContents.on("render-process-gone", (_event, detail) => {
      startup.log("renderer-gone", { reason: detail.reason, exitCode: detail.exitCode });
      if (!quitting && detail.reason !== "clean-exit") void recoverWindow("界面进程已退出");
    });
    window.webContents.on("preload-error", () => { startup.log("preload-failed"); void recoverWindow("桌面连接初始化失败"); });
    window.on("unresponsive", () => { startup.log("window-unresponsive"); void recoverWindow("界面暂时没有响应"); });
    window.on("session-end", () => {
      quitting = true;
      clearTimeout(startupTimer);
      clearTimeout(windowShowTimer);
      tray?.destroy();
      tray = null;
      if (alive) worker?.kill();
    });
    window.on("close", (event) => {
      if (quitting || !tray) return;
      event.preventDefault();
      window?.hide();
      startup.log("window-hidden-to-tray");
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      const external = externalWebUrl(url);
      if (external)
        void shell.openExternal(external).catch((error: unknown) => {
          console.warn("Unable to open external web link:", String(error));
        });
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== pageUrl) event.preventDefault();
    });
    window.webContents.on("will-frame-navigate", (event) => {
      if (event.url !== pageUrl) event.preventDefault();
    });
    window.once("ready-to-show", () => {
      startup.log("ready-to-show");
      showStartupWindow("first-paint");
    });
    // A fully hidden HWND can stall first paint on Windows. It can render here
    // without stealing focus or becoming visible until showStartupWindow runs.
    window.showInactive();
    loadApplication();
    window.on("closed", () => {
      if (window) modalWindowIds.delete(window.id);
      window = null;
      clearTimeout(startupTimer);
      clearTimeout(windowShowTimer);
    });
  }).catch(() => {
    startup.log("host-startup-failed");
    dialog.showErrorBox("NEXIOM 无法启动", "桌面初始化失败。请重新启动应用。项目数据仍保留在本机。\n启动日志：" + startup.file);
    app.quit();
  });
  app.on("child-process-gone", (_event, detail) => startup.log("child-process-gone", { type: detail.type, reason: detail.reason, exitCode: detail.exitCode }));
  app.on("window-all-closed", () => { if (!tray) app.quit(); });
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    clearTimeout(startupTimer);
    clearTimeout(windowShowTimer);
    tray?.destroy();
    tray = null;
    if (!alive) return;
    event.preventDefault();
    void request({ shutdown: true })
      .catch(() => {})
      .finally(() => {
        worker?.kill();
        app.quit();
      });
  });
}
