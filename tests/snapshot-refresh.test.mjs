import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["apps/desktop/renderer/snapshot-refresh.ts"],
  bundle: true, platform: "node", format: "esm", write: false, target: "node24",
});
const { createSnapshotRefresh } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function fixture(t) {
  const timers = new Map();
  let nextTimer = 0;
  let active = 0;
  let maximumActive = 0;
  const calls = [];
  const snapshots = [];
  const errors = [];
  const state = { snapshot: { status: "running" }, refreshError: null, settled: 0 };
  const controller = createSnapshotRefresh({
    load() {
      const call = deferred();
      calls.push(call);
      active++;
      maximumActive = Math.max(maximumActive, active);
      return call.promise.finally(() => { active--; });
    },
    onSnapshot(snapshot) { snapshots.push(snapshot); state.snapshot = snapshot; },
    onFailure(failure) { errors.push(failure); state.refreshError = failure; },
    onRecovered() { state.refreshError = null; },
    onSettled() { state.settled++; },
    schedule(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    cancel(id) { timers.delete(id); },
  });
  t.after(() => controller.dispose());
  return {
    controller, calls, snapshots, errors, state, timers,
    get maximumActive() { return maximumActive; },
    tick(expectedDelay) {
      assert.equal(timers.size, 1, "only one timer may be scheduled");
      const [id, timer] = [...timers][0];
      assert.equal(timer.delay, expectedDelay);
      timers.delete(id);
      timer.callback();
    },
  };
}

test("a final notification timeout retries without more events and recovers without losing visible data", async t => {
  const f = fixture(t);
  f.controller.changed();
  f.tick(32);
  f.calls[0].reject(new Error("本地核心响应超时。"));
  await flush();
  assert.equal(f.state.snapshot.status, "running");
  assert.equal(f.state.refreshError.retrying, true);
  assert.equal(f.state.settled, 1);
  f.tick(1000);
  f.calls[1].resolve({ status: "completed", text: "verified result" });
  await flush();
  assert.equal(f.state.refreshError, null);
  assert.deepEqual(f.state.snapshot, { status: "completed", text: "verified result" });
  assert.equal(f.timers.size, 0);
});

test("an explicit failed refresh settles promptly while recovery continues independently", async t => {
  const f = fixture(t);
  let completed = false;
  const request = f.controller.refresh().then(() => { completed = true; });
  f.calls[0].reject(new Error("temporary read failure"));
  await request;
  assert.equal(completed, true, "settings/action callers must release busy after one attempt");
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 1);
});

test("a command snapshot invalidates an older failure and its finally callback", async t => {
  const f = fixture(t);
  const request = f.controller.refresh();
  f.controller.accept({ status: "completed" });
  f.calls[0].reject(new Error("late old timeout"));
  await request;
  assert.deepEqual(f.snapshots, [{ status: "completed" }]);
  assert.deepEqual(f.errors, []);
  assert.equal(f.state.settled, 0);
  assert.equal(f.timers.size, 0);
});

test("an older success cannot overwrite a command snapshot, and later fresh reads still apply", async t => {
  const f = fixture(t);
  const request = f.controller.refresh();
  f.controller.accept({ status: "completed" });
  f.calls[0].resolve({ status: "running" });
  await request;
  assert.deepEqual(f.snapshots, [{ status: "completed" }]);
  const latest = f.controller.refresh();
  f.calls[1].resolve({ status: "completed", text: "latest" });
  await latest;
  assert.equal(f.state.snapshot.text, "latest");
});

test("only successful reads clear transient errors, not command snapshots", async t => {
  const f = fixture(t);
  const first = f.controller.refresh();
  f.calls[0].reject(new Error("read timed out"));
  await first;
  f.controller.accept({ status: "completed" });
  assert.equal(f.state.refreshError.error.message, "read timed out");
  const recovering = f.controller.refresh();
  f.calls[1].resolve({ status: "completed" });
  await recovering;
  assert.equal(f.state.refreshError, null);
  assert.equal(f.timers.size, 0);
});

test("notification bursts and explicit callers share one flight and one follow-up", async t => {
  const f = fixture(t);
  const first = f.controller.refresh();
  for (let i = 0; i < 100; i++) f.controller.changed();
  const second = f.controller.refresh();
  const third = f.controller.refresh();
  assert.equal(second, third, "queued callers share the same completion");
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ status: "running" });
  await first;
  f.tick(32);
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve({ status: "completed" });
  await second;
  assert.equal(f.maximumActive, 1);
  assert.equal(f.timers.size, 0);
});

test("pending notifications survive acceptance of a command snapshot", async t => {
  const f = fixture(t);
  const first = f.controller.refresh();
  f.controller.changed();
  f.controller.accept({ status: "running" });
  f.calls[0].resolve({ status: "old" });
  await first;
  f.tick(32);
  f.calls[1].resolve({ status: "completed" });
  await flush();
  assert.equal(f.state.snapshot.status, "completed");
  assert.equal(f.maximumActive, 1);
});

test("failures use capped backoff even with pending notifications, and successful reads reset it", async t => {
  const f = fixture(t);
  void f.controller.refresh();
  for (const [index, delay] of [1000, 2000, 4000, 8000, 10000, 10000].entries()) {
    for (let n = 0; n < 10; n++) f.controller.changed();
    f.calls[index].reject(new Error("still blocked"));
    await flush();
    f.tick(delay);
  }
  f.calls[6].resolve({ status: "completed" });
  await flush();
  assert.equal(f.timers.size, 0);
  const again = f.controller.refresh();
  f.calls[7].reject(new Error("new outage"));
  await again;
  f.tick(1000);
});

test("notification bursts preserve backoff while an explicit refresh can recover immediately", async t => {
  const f = fixture(t);
  const first = f.controller.refresh();
  f.calls[0].reject(new Error("timeout"));
  await first;
  for (let n = 0; n < 100; n++) f.controller.changed();
  assert.equal([...f.timers.values()][0].delay, 1000);
  const manual = f.controller.refresh();
  f.calls[1].resolve({ status: "completed" });
  await manual;
  assert.equal(f.calls.length, 2);
  assert.equal(f.maximumActive, 1);
  assert.equal(f.timers.size, 0);
});

test("known dead-core failures remain visible without a retry loop", async t => {
  const f = fixture(t);
  const first = f.controller.refresh();
  const queued = f.controller.refresh();
  f.controller.changed();
  f.calls[0].reject(new Error("本地核心已退出。"));
  await Promise.all([first, queued]);
  assert.equal(f.state.refreshError.retrying, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 1);
});

test("dispose releases callers and ignores late success and failure across a StrictMode-style remount", async t => {
  for (const fails of [false, true]) {
    const f = fixture(t);
    const first = f.controller.refresh();
    const queued = f.controller.refresh();
    f.controller.changed();
    f.controller.dispose();
    await Promise.all([first, queued]);
    if (fails) f.calls[0].reject(new Error("late failure"));
    else f.calls[0].resolve({ status: "stale" });
    await flush();
    f.controller.changed();
    f.controller.accept({ status: "stale command" });
    await f.controller.refresh();
    assert.deepEqual(f.snapshots, []);
    assert.deepEqual(f.errors, []);
    assert.equal(f.state.settled, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.calls.length, 1);
  }
  const fresh = fixture(t);
  const first = fresh.controller.refresh();
  fresh.calls[0].resolve({ status: "fresh mount" });
  await first;
  assert.equal(fresh.state.snapshot.status, "fresh mount");
});

test("dispose cancels a pending retry", async t => {
  const f = fixture(t);
  const first = f.controller.refresh();
  f.calls[0].reject(new Error("timeout"));
  await first;
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});
