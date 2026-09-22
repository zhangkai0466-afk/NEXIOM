import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

const { default: service } = await import(process.env.NEXIOM_TEST_SERVICE ?? "../.build/service.cjs");
const built = await build({ entryPoints: ["packages/core/stream-checkpoint.ts"], bundle: true, platform: "node", format: "esm", write: false });
const { StreamCheckpoint } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const update = (id, text) => ({ type: "item.updated", item: { id, type: "agent_message", text } });

test("checkpoints coalesce cumulative snapshots, preserve boundaries and reject late updates after completion", () => {
  const events = [];
  const checkpoint = new StreamCheckpoint(batch => events.push(...batch), () => assert.fail("unexpected asynchronous failure"));
  checkpoint.push(update("answer", "a"));
  checkpoint.push(update("answer", "ab"));
  checkpoint.push({ type: "context.compacted", itemId: "compact-1" });
  checkpoint.push(update("answer", "abc"));
  checkpoint.push(update("other", "x"));
  checkpoint.push({ type: "item.completed", item: { id: "other", type: "agent_message", text: "xyz" } });
  checkpoint.push(update("other", "stale"));
  checkpoint.push({ type: "turn.completed", usage: null });
  checkpoint.close();
  assert.deepEqual(events.map(event => [event.type, event.item?.id, event.item?.text]), [
    ["item.updated", "answer", "ab"],
    ["context.compacted", undefined, undefined],
    ["item.updated", "answer", "abc"],
    ["item.updated", "other", "x"],
    ["item.completed", "other", "xyz"],
    ["turn.completed", undefined, undefined],
  ]);
});

test("checkpoints flush without another source event and timer failures abort without uncaught exceptions", async () => {
  const events = [];
  const checkpoint = new StreamCheckpoint(batch => events.push(...batch), () => assert.fail("unexpected failure"));
  checkpoint.push(update("answer", "partial"));
  await delay(85);
  assert.equal(events[0].item.text, "partial");
  checkpoint.close();
  const failure = new Error("synthetic persistence failure");
  let aborted = false;
  const failed = new StreamCheckpoint(() => { throw failure; }, () => { aborted = true; });
  failed.push(update("answer", "partial"));
  await delay(85);
  assert.equal(aborted, true);
  assert.throws(() => failed.close(), error => error === failure);
});

test("mutable command snapshots retain received output and do not merge command or status transitions", () => {
  const events = [];
  const checkpoint = new StreamCheckpoint(batch => events.push(...structuredClone(batch)), () => assert.fail("unexpected failure"));
  const item = { id: "command", type: "command_execution", command: "first", aggregated_output: "a", status: "in_progress" };
  const packet = { type: "item.updated", item };
  checkpoint.push(packet);
  item.aggregated_output = "ab";
  checkpoint.push(packet);
  item.command = "second";
  item.aggregated_output = "abc";
  checkpoint.push(packet);
  item.status = "completed";
  item.aggregated_output = "abcd";
  checkpoint.push(packet);
  item.aggregated_output = "mutated without an event";
  checkpoint.close();
  assert.deepEqual(events.map(event => [event.item.command, event.item.status, event.item.aggregated_output]), [
    ["first", "in_progress", "ab"],
    ["second", "in_progress", "abc"],
    ["second", "completed", "abcd"],
  ]);
});

async function setup(t, behavior) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-streaming-"));
  let notifications = 0;
  const runner = {
    async probe(provider) {
      return { connected: true, available: true, authenticated: true, label: "fixture", version: "fixture",
        hasApiKey: false, activeProviderId: provider.id, activeProviderName: provider.name,
        activeModel: provider.model, activeModelProvider: "nexiom" };
    },
    async listModels() { return ["fixture"]; },
    run: behavior,
  };
  const core = new service.CoreService(dir, () => notifications++, { runner });
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.request({ type: "provider.upsert", provider: { id: "nexiom-default", name: "fixture", kind: "responses", endpoint: "http://127.0.0.1:1/v1", model: "fixture", auth: "none" } });
  await core.request({ type: "runtime.check" });
  const { thread } = await core.request({ type: "project.create", name: "Streaming fixture" });
  const submit = () => core.request({ type: "agent.submit", threadId: thread.id, text: "Synthetic stream", clientRequestId: randomUUID() });
  return { core, submit, notifications: () => notifications };
}

async function settled(core, runId) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    const state = core.snapshot().snapshot;
    if (state.runs.find(run => run.id === runId).status !== "running") return state;
    await delay(5);
  }
  assert.fail("synthetic stream did not settle promptly");
}

test("a 12000-event burst remains responsive and commits the exact final answer with bounded notifications", async t => {
  let produced = 0;
  const { core, submit, notifications } = await setup(t, async function* () {
    let text = "";
    for (let n = 0; n < 12000; n++) {
      produced++;
      text += "text";
      yield update("answer", text);
    }
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text } };
    yield update("answer", "obsolete");
    yield { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 12000 } };
  });
  const before = notifications();
  const { runId } = await submit();
  await tick();
  assert.ok(produced < 12000, "buffered events must yield before exhausting the entire stream");
  assert.equal((await core.request({ type: "snapshot" })).snapshot.runs.find(run => run.id === runId).status, "running");
  const state = await settled(core, runId);
  assert.equal(state.runs.find(run => run.id === runId).status, "succeeded");
  assert.equal(state.items[0].item.text, "text".repeat(12000));
  assert.equal(state.items[0].status, "completed");
  assert.ok(notifications() - before < 100, "stream deltas must not notify once per token");
});

test("cancelling a buffered stream yields promptly and persists the received partial output", async t => {
  let produced = 0;
  const { core, submit } = await setup(t, async function* ({ signal }) {
    while (produced < 12000 && !signal.aborted) {
      produced++;
      yield update("answer", "x".repeat(produced));
    }
    if (!signal.aborted) yield { type: "turn.completed", usage: null };
  });
  const { runId } = await submit();
  await tick();
  await core.request({ type: "run.cancel", runId });
  const state = await settled(core, runId);
  assert.ok(produced < 12000);
  assert.equal(state.runs.find(run => run.id === runId).status, "cancelled");
  assert.equal(state.items[0].item.text, "x".repeat(produced));
  assert.equal(state.items[0].status, "interrupted");
});

for (const ending of ["turn.failed", "throw", "eof"]) {
  test(`partial output survives ${ending} without a completed event`, async t => {
    const { core, submit } = await setup(t, async function* () {
      yield update("answer", "received partial");
      if (ending === "turn.failed") yield { type: "turn.failed", error: { message: "synthetic failure" } };
      if (ending === "throw") throw new Error("synthetic failure");
    });
    const { runId } = await submit();
    const state = await settled(core, runId);
    assert.equal(state.runs.find(run => run.id === runId).status, "failed");
    assert.equal(state.items[0].item.text, "received partial");
    assert.equal(state.items[0].status, "interrupted");
  });
}

test("a silent source exposes its partial text before the next event arrives", async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { core, submit } = await setup(t, async function* ({ signal }) {
    yield update("answer", "partial before silence");
    await Promise.race([waiting, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
    if (!signal.aborted) yield { type: "turn.completed", usage: null };
  });
  const { runId } = await submit();
  await delay(90);
  const state = core.snapshot().snapshot;
  assert.equal(state.runs.find(run => run.id === runId).status, "running");
  assert.equal(state.items[0].item.text, "partial before silence");
  release();
  await settled(core, runId);
});

test("an asynchronous checkpoint database failure remains failed when it aborts the source", async t => {
  let observedAbort = false;
  const { core, submit } = await setup(t, async function* ({ signal }) {
    yield update("faulty-output", "received partial");
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(new DOMException("Source aborted", "AbortError"));
    }, { once: true }));
  });
  core.db.exec(`CREATE TRIGGER synthetic_checkpoint_failure BEFORE INSERT ON agent_items
    WHEN NEW.id LIKE '%:faulty-output' BEGIN SELECT RAISE(FAIL, 'synthetic checkpoint write failure'); END`);
  const { runId } = await submit();
  const state = await settled(core, runId);
  assert.equal(observedAbort, true);
  assert.equal(state.runs.find(run => run.id === runId).status, "failed");
  assert.match(state.messages.at(-1).text, /synthetic checkpoint write failure/);
  assert.doesNotMatch(state.messages.at(-1).text, /任务已停止/);
});
