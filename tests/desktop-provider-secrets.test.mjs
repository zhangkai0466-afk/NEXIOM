import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const previousSecrets = { "existing-provider": "existing-secret" };
const upsertCommand = {
  type: "provider.upsert",
  provider: {
    id: "new-provider",
    name: "New provider",
    kind: "responses",
    endpoint: "https://models.example.test/v1",
    model: "fixture-model",
    auth: "bearer",
  },
  apiKey: "new-secret",
};

async function desktopHarness(t, options) {
  const root = await mkdtemp(path.join(tmpdir(), "nexiom-provider-secrets-"));
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "provider-secrets.enc"),
    JSON.stringify(previousSecrets),
  );

  const handlers = new Map();
  const startupErrors = [];
  let resolveCoreHandler;
  const coreHandlerRegistered = new Promise((resolve) => {
    resolveCoreHandler = resolve;
  });
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
    if (channel === "core:request") resolveCoreHandler();
  };

  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.webContents.executeJavaScript = async () => ({});
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    focus() {}
    hide() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    loadFile() { return Promise.resolve(); }
    restore() {}
    setBackgroundColor() {}
    setOpacity() {}
    setTitleBarOverlay() {}
    show() {}
    showInactive() {}
  }

  const app = new EventEmitter();
  app.commandLine = { appendSwitch() {} };
  app.getPath = () => root;
  app.getVersion = () => "test";
  app.quit = () => {};
  app.requestSingleInstanceLock = () => true;
  app.setAppUserModelId = () => {};
  app.setPath = () => {};
  app.whenReady = () => Promise.resolve();

  const worker = new EventEmitter();
  const packets = [];
  const events = [];
  let runtimePackets = 0;
  let killCalls = 0;
  worker.kill = () => {
    killCalls += 1;
    events.push("core:kill");
    return true;
  };
  worker.postMessage = (packet) => {
    packets.push(packet);
    if (packet.runtimeSecrets) {
      runtimePackets += 1;
      if (runtimePackets === 1) {
        events.push("core:initial-secrets");
        queueMicrotask(() => worker.emit("message", { id: packet.id, result: {} }));
      } else {
        events.push("core:rollback");
        if (options.coreRollback === "success")
          queueMicrotask(() => worker.emit("message", { id: packet.id, result: {} }));
        else if (options.coreRollback === "error")
          queueMicrotask(() =>
            worker.emit("message", {
              id: packet.id,
              error: "core rollback IPC failed",
            }),
          );
      }
      return;
    }
    if (packet.command?.type === "provider.upsert") {
      events.push("core:upsert");
      queueMicrotask(() =>
        worker.emit("message", {
          id: packet.id,
          error: "core provider update failed",
        }),
      );
      return;
    }
    queueMicrotask(() => worker.emit("message", { id: packet.id, result: {} }));
  };

  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.themeSource = "dark";
  class Tray extends EventEmitter {
    destroy() {}
    setContextMenu() {}
    setToolTip() {}
  }
  const electron = {
    app,
    BrowserWindow,
    dialog: {
      showErrorBox(title, message) {
        startupErrors.push(`${title}: ${message}`);
      },
      showMessageBox: async () => ({ response: 2 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    ipcMain,
    Menu: { buildFromTemplate: () => ({}) },
    nativeTheme,
    safeStorage: {
      decryptString: (value) => value.toString("utf8"),
      encryptString: (value) => Buffer.from(value),
      isEncryptionAvailable: () => true,
    },
    shell: {
      openExternal: async () => {},
      openPath: async () => {},
    },
    Tray,
    utilityProcess: { fork: () => {
      queueMicrotask(() => worker.emit("message", { type: "ready" }));
      return worker;
    } },
  };

  const fsPromises = require("node:fs/promises");
  let renameCalls = 0;
  const mockedFsPromises = new Proxy(fsPromises, {
    get(target, property, receiver) {
      if (property !== "rename") return Reflect.get(target, property, receiver);
      return async (...args) => {
        renameCalls += 1;
        events.push(renameCalls === 1 ? "vault:commit" : "vault:rollback");
        if (renameCalls === 2 && options.vaultRollbackFails)
          throw new Error("vault rollback write failed");
        return target.rename(...args);
      };
    },
  });

  const Module = require("node:module");
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (request === "node:fs/promises") return mockedFsPromises;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const desktopPath = require.resolve("../.build/desktop.cjs");
    delete require.cache[desktopPath];
    require(desktopPath);
  } finally {
    Module._load = originalLoad;
  }

  let registrationTimer;
  try {
    await Promise.race([
      coreHandlerRegistered,
      new Promise((_, reject) => {
        registrationTimer = setTimeout(
          () => reject(new Error("desktop core handler registration timed out")),
          10000,
        );
      }),
    ]);
  } catch (error) {
    assert.fail(
      `${error instanceof Error ? error.message : String(error)}${
        startupErrors.length ? `; startup errors: ${startupErrors.join(" | ")}` : ""
      }`,
    );
  } finally {
    clearTimeout(registrationTimer);
  }
  assert.ok(handlers.has("core:request"), "desktop core handler was registered");
  const targetWindow = windows[0];
  assert.ok(targetWindow, "desktop window was created");
  t.after(async () => {
    targetWindow.emit("closed");
    await rm(root, { recursive: true, force: true });
  });

  const event = {
    sender: targetWindow.webContents,
    senderFrame: {
      url: pathToFileURL(path.join(process.cwd(), "dist/index.html")).href,
    },
  };
  return {
    event,
    events,
    packets,
    requestCore: handlers.get("core:request"),
    root,
    renameCalls: () => renameCalls,
    killCalls: () => killCalls,
  };
}

async function runUpsert(harness, fastTimeout = false) {
  const originalSetTimeout = globalThis.setTimeout;
  if (fastTimeout) {
    globalThis.setTimeout = (callback, delay, ...args) =>
      originalSetTimeout(callback, delay === 30000 ? 0 : delay, ...args);
  }
  try {
    return await harness.requestCore(harness.event, upsertCommand);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("desktop restores memory and Core before reporting a vault rollback failure", async (t) => {
  const harness = await desktopHarness(t, {
    coreRollback: "success",
    vaultRollbackFails: true,
  });
  const error = await runUpsert(harness).then(
    () => assert.fail("provider upsert should fail"),
    (failure) => failure,
  );

  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /模型供应商变更原始失败：core provider update failed/);
  assert.match(error.message, /API Key 密钥库回滚失败：vault rollback write failed/);
  assert.doesNotMatch(error.message, /Core API Key 回滚失败/);
  assert.deepEqual(
    harness.packets.filter((packet) => packet.runtimeSecrets).at(-1).runtimeSecrets,
    previousSecrets,
  );
  assert.ok(
    harness.events.indexOf("core:rollback") < harness.events.indexOf("vault:rollback"),
    "Core must be rolled back before the vault",
  );
  assert.equal(harness.killCalls(), 0);

  await harness.requestCore(harness.event, {
    type: "provider.delete",
    providerId: "new-provider",
  });
  assert.equal(
    harness.renameCalls(),
    2,
    "the failed provider was removed from the in-memory secret map first",
  );
});

test("desktop stops Core when the secret rollback IPC fails", async (t) => {
  const harness = await desktopHarness(t, {
    coreRollback: "error",
    vaultRollbackFails: false,
  });
  const error = await runUpsert(harness).then(
    () => assert.fail("provider upsert should fail"),
    (failure) => failure,
  );

  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /模型供应商变更原始失败：core provider update failed/);
  assert.match(error.message, /Core API Key 回滚失败：core rollback IPC failed/);
  assert.match(error.message, /本地核心已停止，请重启应用/);
  assert.doesNotMatch(error.message, /密钥库回滚失败/);
  assert.equal(harness.killCalls(), 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(harness.root, "provider-secrets.enc"), "utf8")),
    previousSecrets,
  );
  await assert.rejects(
    harness.requestCore(harness.event, { type: "snapshot" }),
    /本地核心不可用，请重启应用/,
  );
});

test("desktop fails closed when Core rollback times out and vault rollback also fails", async (t) => {
  const harness = await desktopHarness(t, {
    coreRollback: "timeout",
    vaultRollbackFails: true,
  });
  const error = await runUpsert(harness, true).then(
    () => assert.fail("provider upsert should fail"),
    (failure) => failure,
  );

  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 3);
  assert.match(error.message, /模型供应商变更原始失败：core provider update failed/);
  assert.match(error.message, /Core API Key 回滚失败：本地核心响应超时/);
  assert.match(error.message, /API Key 密钥库回滚失败：vault rollback write failed/);
  assert.ok(
    harness.events.indexOf("core:rollback") < harness.events.indexOf("vault:rollback"),
    "the vault rollback must still be attempted after Core is stopped",
  );
  assert.equal(harness.killCalls(), 1);
  await assert.rejects(
    harness.requestCore(harness.event, { type: "snapshot" }),
    /本地核心不可用，请重启应用/,
  );
});
