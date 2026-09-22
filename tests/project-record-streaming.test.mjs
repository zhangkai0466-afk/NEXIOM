import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import service from "../.build/service.cjs";

test("continuous output checkpoints its portable record without rewriting it on every UI update", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-stream-record-"));
  let finish = false;
  const runner = {
    async probe(provider) {
      return {
        connected: true, available: true, authenticated: true,
        label: "Local fixture", version: "fixture", hasApiKey: false,
        activeProviderId: provider.id, activeProviderName: provider.name,
        activeModel: provider.model, activeModelProvider: "nexiom",
      };
    },
    async listModels() { return ["fixture"]; },
    async *run({ signal }) {
      yield { type: "thread.started", thread_id: "record-fixture" };
      let text = "";
      while (!finish && !signal.aborted) {
        text += "文字";
        yield { type: "item.updated", item: { id: "answer", type: "agent_message", text } };
        await delay(10);
      }
      yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: text + "完成" } };
      yield { type: "turn.completed", usage: null };
    },
  };
  const core = new service.CoreService(dir, () => {}, { runner });
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  await core.request({ type: "provider.upsert", provider: {
    id: "nexiom-default", name: "Fixture", kind: "responses",
    endpoint: "http://127.0.0.1:1/v1", model: "fixture", auth: "none",
  } });
  await core.request({ type: "runtime.check" });
  const { project, thread } = await core.request({ type: "project.create", name: "Streaming checkpoint" });
  const { runId } = await core.request({ type: "agent.submit", threadId: thread.id,
    text: "Local fixture", clientRequestId: randomUUID() });
  const recordPath = path.join(project.root, ".nexiom", "project.json");
  const readRecord = async () => JSON.parse(await readFile(recordPath, "utf8"));
  const textInRecord = record => {
    const item = record.records.agentItems.find(item => item.id === `${runId}:answer`);
    return item ? JSON.parse(item.payload).text : "";
  };
  const recordedTexts = new Set();
  let liveAheadOfMirror = false;
  const deadline = performance.now() + 1600;
  while (performance.now() < deadline) {
    const recorded = textInRecord(await readRecord());
    recordedTexts.add(recorded);
    const live = core.snapshot().snapshot.items.find(item => item.id === `${runId}:answer`);
    if (live && JSON.stringify(live).includes("文字") && recorded === "") liveAheadOfMirror = true;
    await delay(20);
  }
  assert.ok(liveAheadOfMirror, "live snapshots must progress independently of full project export");
  assert.ok([...recordedTexts].some(text => text.length > 0), "continuous output must not postpone its checkpoint until completion");
  assert.ok(recordedTexts.size <= 5, `project mirror rewritten too often: ${recordedTexts.size} observed versions`);
  finish = true;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (core.snapshot().snapshot.runs.find(run => run.id === runId).status !== "running") break;
    await delay(10);
  }
  const record = await readRecord();
  assert.equal(record.records.runs.find(run => run.id === runId).status, "succeeded");
  assert.ok(textInRecord(record).endsWith("完成"), "completion must flush the last text without waiting for the mirror timer");
});
