import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import service from "../.build/service.cjs";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-record-recovery-"));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
  const controls = new Map();
  const runner = {
    async probe(provider) {
      return { connected: true, available: true, authenticated: true, label: "Fixture", version: "fixture",
        hasApiKey: false, activeProviderId: provider.id, activeProviderName: provider.name,
        activeModel: provider.model, activeModelProvider: "nexiom" };
    },
    async listModels() { return ["fixture"]; },
    async *run({ cwd, signal }) {
      const control = controls.get(cwd);
      assert.ok(control);
      yield { type: "thread.started", thread_id: randomUUID() };
      yield { type: "item.updated", item: { id: "answer", type: "agent_message", text: control.partial } };
      control.ready.resolve();
      const onAbort = () => control.finish.resolve("cancel");
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        const result = await control.finish.promise;
        if (signal.aborted) throw new DOMException("Fixture cancelled", "AbortError");
        if (result === "throw") throw new Error("Fixture stream failed");
        yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: control.partial + " complete" } };
        yield { type: "turn.completed", usage: null };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
  const core = new service.CoreService(dir, () => {}, { runner });
  t.after(async () => {
    await core.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith("nexiom-record-recovery-"));
    await rm(dir, { recursive: true, force: true });
  });
  await core.request({ type: "provider.upsert", provider: {
    id: "nexiom-default", name: "Fixture", kind: "responses", endpoint: "http://127.0.0.1:1/v1",
    model: "fixture", auth: "none",
  } });
  await core.request({ type: "runtime.check" });
  const project = async name => {
    const result = await core.request({ type: "project.create", name });
    const control = { partial: `${name} partial`, ready: deferred(), finish: deferred() };
    controls.set(result.project.root, control);
    const recordPath = path.resolve(result.project.root, ".nexiom", "project.json");
    const relative = path.relative(path.resolve(dir), recordPath);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    return { ...result, control, recordPath };
  };
  const submit = async fixture => {
    const { runId } = await core.request({ type: "agent.submit", threadId: fixture.thread.id,
      text: "Fixture", clientRequestId: randomUUID() });
    await fixture.control.ready.promise;
    return runId;
  };
  return { core, project, submit };
}

async function until(predicate, message) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

const record = async fixture => JSON.parse(await readFile(fixture.recordPath, "utf8"));
const run = (value, id) => value.records.runs.find(row => row.id === id);
const item = (value, id) => value.records.agentItems.find(row => row.id === `${id}:answer`);

test("cancel, stream failure and normal core close export received partial text with terminal state", async t => {
  for (const outcome of ["cancel", "throw", "close"]) {
    await t.test(outcome, async t => {
      const { core, project, submit } = await setup(t);
      const fixture = await project(`Terminal ${outcome}`);
      const runId = await submit(fixture);
      // The source is paused after its partial; no new event is needed to flush it.
      if (outcome === "close") await core.close();
      else {
        if (outcome === "cancel") await core.request({ type: "run.cancel", runId });
        else fixture.control.finish.resolve("throw");
        await until(() => core.snapshot().snapshot.runs.find(row => row.id === runId)?.status !== "running",
          "Fixture did not reach a terminal state");
      }
      // Read immediately after finalization, without waiting for the 1s mirror timer.
      const saved = await record(fixture);
      assert.equal(run(saved, runId).status, outcome === "throw" ? "failed" : "cancelled");
      assert.equal(JSON.parse(item(saved, runId).payload).text, fixture.control.partial);
      assert.equal(item(saved, runId).status, "interrupted");
    });
  }
});

test("one project mirror failure retains dirty output while another project saves and the next notification retries", async t => {
  const { core, project, submit } = await setup(t);
  const broken = await project("Unavailable mirror");
  const healthy = await project("Healthy mirror");
  const brokenRun = await submit(broken);
  const healthyRun = await submit(healthy);
  t.mock.method(console, "error", () => {});
  // Only a previously verified path inside this test's mkdtemp is changed.
  // An empty directory at the expected regular-file path makes export fail.
  await rm(broken.recordPath);
  await mkdir(broken.recordPath);
  await until(() => core.snapshot().snapshot.events.some(event =>
    event.projectId === broken.project.id && event.type === "project.record_failed"),
  "The deferred export did not report the intentionally unavailable mirror");
  const healthyCheckpoint = await record(healthy);
  assert.equal(run(healthyCheckpoint, healthyRun).status, "running");
  assert.equal(JSON.parse(item(healthyCheckpoint, healthyRun).payload).text, healthy.control.partial);
  const livePartial = core.snapshot().snapshot.items.find(row => row.id === `${brokenRun}:answer`);
  assert.equal(livePartial.item.text, broken.control.partial);

  // Neither source emits another delta. A later notification alone must retry
  // the failed project's retained dirty record, without rewriting its content.
  await rmdir(broken.recordPath);
  await core.request({ type: "runtime.check" });
  const recovered = await record(broken);
  assert.equal(run(recovered, brokenRun).status, "running");
  assert.equal(JSON.parse(item(recovered, brokenRun).payload).text, broken.control.partial);
  assert.equal(recovered.records.events.filter(event => event.type === "project.record_failed").length, 1);

  broken.control.finish.resolve("success");
  healthy.control.finish.resolve("success");
  await until(() => core.snapshot().snapshot.runs.filter(row => [brokenRun, healthyRun].includes(row.id))
    .every(row => row.status === "succeeded"), "Both fixture runs must complete");
  for (const [fixture, runId] of [[broken, brokenRun], [healthy, healthyRun]]) {
    const saved = await record(fixture);
    assert.equal(run(saved, runId).status, "succeeded");
    assert.equal(JSON.parse(item(saved, runId).payload).text, fixture.control.partial + " complete");
  }
});
