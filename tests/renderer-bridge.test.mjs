import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["apps/desktop/renderer/bridge.ts"], bundle: true, platform: "node", format: "esm", write: false, target: "node24" });
const { applyDesktopUpdate, request } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

test("desktop requests expose readable errors to every renderer caller", async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const wrapped = new Error("Error invoking remote method 'core:request': Error: Choose a project folder.");
  globalThis.window = { nexiom: { request: async () => { throw wrapped; } } };
  await assert.rejects(request({ type: "snapshot" }), error => {
    assert.equal(error.message, "Choose a project folder.");
    assert.equal(error.cause, wrapped);
    return true;
  });

  const original = new Error("Project unavailable.");
  globalThis.window.nexiom.request = async () => { throw original; };
  await assert.rejects(request({ type: "snapshot" }), error => error === original);

  const result = { snapshot: { projects: [] } };
  globalThis.window.nexiom.request = async () => result;
  assert.equal(await request({ type: "snapshot" }), result);
});

test("desktop update requests preserve readable errors and browser previews reload", async t => {
  const previous = globalThis.window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });

  const result = { targetVersion: "0.6.18" };
  globalThis.window = { nexiom: { applyUpdate: async () => result } };
  assert.equal(await applyDesktopUpdate(), result);

  globalThis.window.nexiom.applyUpdate = async () => {
    throw new Error("Error invoking remote method 'desktop:apply-update': Error: 当前已经是最新版本。");
  };
  await assert.rejects(applyDesktopUpdate(), /当前已经是最新版本/);

  let reloads = 0;
  globalThis.window = { location: { reload: () => { reloads += 1; } } };
  assert.deepEqual(await applyDesktopUpdate(), { targetVersion: null });
  assert.equal(reloads, 1);
});
