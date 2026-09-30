import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";
import vm from "node:vm";

const require = createRequire(import.meta.url);

// Exercise the real parser, notification queue and runAppServer adapter with an
// in-memory native protocol peer. No model call or subprocess is needed.
function nativeFixture(notifications, { clock } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.exitCode = null;
  let stopped = false;
  const close = () => {
    if (stopped) return;
    stopped = true;
    child.exitCode = 0;
    child.stdout.end();
    child.emit("close", 0);
  };
  child.kill = close;
  const requests = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      requests.push(request);
      if (request.id !== undefined) {
        const result = request.method === "thread/start" ? { thread: { id: "thread" } }
          : request.method === "turn/start" ? { turn: { id: "turn" } } : {};
        const frames = [{ id: request.id, result }];
        if (request.method === "turn/start") frames.push(...notifications);
        child.stdout.write(frames.map(frame => JSON.stringify(frame) + "\n").join(""));
      }
      callback();
    },
  });
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, process: { ...process, platform: "win32" },
    Buffer, setTimeout, clearTimeout, console,
    require(name) {
      if (name === "node:child_process") return {
        spawn: () => child,
        execFile(_executable, _args, _options, callback) { close(); callback(); },
      };
      if (name === "node:perf_hooks" && clock) return { performance: { now: clock } };
      return require(name);
    },
  };
  vm.runInNewContext(readFileSync(new URL("../.build/runtime.cjs", import.meta.url), "utf8"), context);
  const abort = new AbortController();
  const events = module.exports.runAppServer({
    executable: "fixture-native", env: {}, runtimeHome: "C:/fixture/runtime", config: {},
    baseInstructions: "Fixture",
    input: {
      cwd: "C:/fixture/project", prompt: "Fixture",
      provider: { model: "fixture" }, settings: { network: false, effort: "default" },
      signal: abort.signal,
    },
  });
  return { events, abort, requests, close };
}

const event = (method, params) => ({ method, params: { threadId: "thread", turnId: "turn", ...params } });
const completed = () => event("turn/completed", { turn: { id: "turn", status: "completed" } });
const ignored = count => Array.from({ length: count }, (_, index) =>
  event("item/reasoning/textDelta", { itemId: "hidden", delta: String(index) }));

test("a buffered flood of filtered native events yields to the event loop before completion", async t => {
  const fixture = nativeFixture([...ignored(4096), completed()]);
  t.after(fixture.close);
  let otherWorkRan = false;
  let completedAfterOtherWork = false;
  for await (const value of fixture.events) {
    if (value.type === "turn.started") setImmediate(() => { otherWorkRan = true; });
    if (value.type === "turn.completed") completedAfterOtherWork = otherWorkRan;
  }
  assert.equal(completedAfterOtherWork, true, "filtered notifications must not monopolize microtasks");
  assert.deepEqual(fixture.requests.filter(value => value.id !== undefined).map(value => value.method),
    ["initialize", "thread/start", "turn/start"]);
  assert.deepEqual(
    fixture.requests.find(value => value.method === "turn/start").params.sandboxPolicy,
    {
      type: "dangerFullAccess",
    },
  );
});

test("cancellation can interrupt a buffered flood even when notifications produce no UI events", async t => {
  const fixture = nativeFixture([...ignored(4096), completed()]);
  t.after(fixture.close);
  let completedTurn = false;
  await assert.rejects(async () => {
    for await (const value of fixture.events) {
      if (value.type === "turn.started") setImmediate(() => fixture.abort.abort());
      if (value.type === "turn.completed") completedTurn = true;
    }
  }, { name: "AbortError" });
  assert.equal(completedTurn, false);
});

test("notification fairness preserves all text updates and terminal ordering", async t => {
  const count = 512;
  const fixture = nativeFixture([
    event("item/started", { item: { id: "answer", type: "agentMessage", text: "" } }),
    ...Array.from({ length: count }, () => event("item/agentMessage/delta", { itemId: "answer", delta: "x" })),
    event("item/completed", { item: { id: "answer", type: "agentMessage", text: "x".repeat(count) } }),
    completed(),
  ]);
  t.after(fixture.close);
  const values = [];
  for await (const value of fixture.events) values.push(value);
  const updates = values.filter(value => value.type === "item.updated");
  assert.equal(updates.length, count);
  for (let index = 0; index < count; index++) assert.equal(updates[index].item.text, "x".repeat(index + 1));
  assert.equal(values.at(-2).type, "item.completed");
  assert.equal(values.at(-2).item.text, "x".repeat(count));
  assert.equal(values.at(-1).type, "turn.completed");
});

test("elapsed processing budget yields before the count limit", async t => {
  let now = 0;
  const fixture = nativeFixture([...ignored(4), completed()], { clock: () => { now += 9; return now; } });
  t.after(fixture.close);
  let otherWorkRan = false;
  for await (const value of fixture.events) {
    if (value.type === "turn.started") setImmediate(() => { otherWorkRan = true; });
    if (value.type === "turn.completed") assert.equal(otherWorkRan, true);
  }
});
