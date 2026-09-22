import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import service from "../.build/service.cjs";

async function load(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { createAttachmentTools } = await load("../packages/runtime/attachment-tools.ts");
const { buildAttachmentTaskPrompt, buildAttachmentCorrectionPrompt, ATTACHMENT_PHASES } = await load("../packages/contracts/attachment-workflow.ts");
const { attachmentAnalysis, parseAttachmentReports } = await load("../apps/desktop/renderer/attachment-progress.ts");
const files = [1, 2, 3].map(n => ({ path: `inputs/附件${n}.xlsx` }));
const target = { id: "A01", path: files[0].path, name: "附件1.xlsx" };
const usage = { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1 };
const stateOf = snapshot => attachmentAnalysis(snapshot.messages, snapshot.items, snapshot.runs);

test("attachment phases enforce one target, serial work and publication before output completion", async () => {
  const abort = new AbortController();
  const tools = createAttachmentTools({ stageId: "attachments", attachmentTarget: target, signal: abort.signal });
  const stage = (phase, status, attachmentId = target.id) => tools.call("nexiom_attachments", "set_attachment_stage", { attachmentId, phase, status });
  const publish = body => tools.call("nexiom_attachments", "publish_attachment_report", { attachmentId: target.id, body });
  assert.equal(createAttachmentTools({ stageId: "reading" }), undefined);
  assert.equal((await stage("reading", "running", "A02")).success, false);
  assert.equal((await stage("analyzing", "running")).success, false);
  assert.equal((await stage("reading", "completed")).success, false);
  assert.equal((await publish("report")).success, false);
  for (const phase of ATTACHMENT_PHASES) {
    assert.equal((await stage(phase, "running")).success, true);
    if (phase === "writing") {
      assert.equal((await stage(phase, "completed")).success, false);
      assert.equal((await publish("  ")).success, false);
      assert.equal((await publish("### 文件概况\n当前文件的完整报告")).success, true);
    }
    assert.equal((await stage(phase, "completed")).success, true);
  }
  assert.equal((await stage("reading", "running")).success, false);
  abort.abort();
  assert.equal((await publish("late report")).success, false);
});

test("legacy reports without brackets are recovered and a global conclusion does not leak into the last file", () => {
  const body = "# 附件分析报告\n## A01 附件1.xlsx\n### 文件概况\n已读取。\n## [A02] 附件2.xlsx\n### 内容与结构\n两个工作表。\n## 全局结论\n共同结果";
  assert.deepEqual(parseAttachmentReports(body).map(report => [report.id, report.body]), [
    ["A01", "### 文件概况\n已读取。"], ["A02", "### 内容与结构\n两个工作表。"],
  ]);
  assert.deepEqual(parseAttachmentReports("任务失败，请重试。"), []);
  assert.deepEqual(parseAttachmentReports("## A01 附件1.xlsx\n"), []);
});

async function* report(input, hook) {
  const tools = createAttachmentTools(input);
  let n = 0;
  async function call(tool, args) {
    const reply = await tools.call("nexiom_attachments", tool, args);
    assert.equal(reply.success, true, JSON.stringify(reply));
    return { type: "item.completed", item: { id: `call-${++n}`, type: "native_tool_call", namespace: "nexiom_attachments", tool, arguments: args, status: "completed", result: JSON.parse(reply.contentItems[0].text) } };
  }
  try {
    yield { type: "thread.started", thread_id: `engine-${input.attachmentTarget.id}` };
    for (const phase of ATTACHMENT_PHASES) {
      const args = { attachmentId: input.attachmentTarget.id, phase };
      yield await call("set_attachment_stage", { ...args, status: "running" });
      await hook?.(phase, input);
      for (let i = 0; i < 8; i++) yield { type: "item.completed", item: { id: `command-${phase}-${i}`, type: "command_execution", command: "python inspect.py", aggregated_output: "rows=42", status: "completed", exit_code: 0 } };
      if (phase === "writing") yield await call("publish_attachment_report", { attachmentId: input.attachmentTarget.id, body: `### 文件概况\n${input.attachmentTarget.name} 的独立报告。` });
      yield await call("set_attachment_stage", { ...args, status: "completed" });
    }
    yield { type: "turn.completed", usage };
  } finally { tools.close(); }
}

async function setup(t, behavior) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-attachment-workflow-"));
  const runtime = {
    calls: [],
    async probe() { return { connected: true, available: true, authenticated: true, label: "fixture", version: "fixture", hasApiKey: false, activeProviderId: "nexiom-default", activeModel: "fixture", activeModelProvider: "nexiom" }; },
    async listModels() { return ["fixture"]; },
    async *run(input) { this.calls.push(input); yield* behavior(input); },
  };
  let core = new service.CoreService(dir, () => {}, { runner: runtime });
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.request({ type: "provider.upsert", provider: { id: "nexiom-default", name: "fixture", kind: "responses", endpoint: "http://127.0.0.1:1234/v1", model: "fixture", auth: "none" } });
  await core.request({ type: "runtime.check" });
  const { project } = await core.request({ type: "project.create", name: "附件隔离验证" });
  const { thread } = await core.request({ type: "thread.ensure", projectId: project.id, stageId: "attachments" });
  return {
    get core() { return core; }, runtime,
    async submit(text = buildAttachmentTaskPrompt(files)) { return core.request({ type: "agent.submit", threadId: thread.id, text, clientRequestId: randomUUID() }); },
    async reopen() { await core.close(); core = new service.CoreService(dir, () => {}, { runner: runtime }); },
  };
}
async function waitFor(core, condition) {
  for (let i = 0; i < 200; i++) {
    const snapshot = core.snapshot().snapshot;
    if (condition(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Fixture did not reach expected state");
}
const settled = (core, id) => waitFor(core, snapshot => snapshot.runs.find(run => run.id === id)?.status !== "running");

test("each attachment waits for the previous report, has a fresh context and exactly four phases across restart", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = await setup(t, input => report(input, async phase => { if (input.attachmentTarget.id === "A01" && phase === "writing") await gate; }));
  const { runId } = await fixture.submit();
  const during = await waitFor(fixture.core, snapshot => stateOf(snapshot)[0]?.steps[3].status === "running");
  assert.equal(fixture.runtime.calls.length, 1);
  assert.deepEqual(stateOf(during).map(state => state.status), ["running", "pending", "pending"]);
  assert.equal(stateOf(during)[0].report, undefined);
  assert.equal(stateOf(during)[0].steps.length, 4, "internal commands do not add phases");
  release();
  const snapshot = await settled(fixture.core, runId);
  assert.equal(snapshot.runs.find(run => run.id === runId).status, "succeeded");
  assert.deepEqual(fixture.runtime.calls.map(input => input.attachmentTarget.id), ["A01", "A02", "A03"]);
  assert.ok(fixture.runtime.calls.every(input => input.threadId === undefined));
  assert.ok(!fixture.runtime.calls[0].prompt.includes(files[1].path));
  assert.deepEqual(stateOf(snapshot).map(state => state.status), ["completed", "completed", "completed"]);
  assert.deepEqual(stateOf(snapshot).map(state => state.steps.length), [4, 4, 4]);
  assert.equal(JSON.parse(snapshot.runs.find(run => run.id === runId).usage).input_tokens, 30);
  assert.equal(new Set(snapshot.items.map(item => item.id)).size, snapshot.items.length);
  await fixture.reopen();
  assert.deepEqual(stateOf(fixture.core.snapshot().snapshot).map(state => state.report.body), stateOf(snapshot).map(state => state.report.body));
});

test("a writing failure keeps completed reports and a retry only runs unfinished attachments", async t => {
  let fail = true;
  const fixture = await setup(t, input => report(input, phase => { if (fail && input.attachmentTarget.id === "A02" && phase === "writing") throw new Error("fixture output disconnected"); }));
  const { runId } = await fixture.submit();
  const snapshot = await settled(fixture.core, runId);
  const states = stateOf(snapshot);
  assert.deepEqual(states.map(state => state.status), ["completed", "failed", "pending"]);
  assert.equal(states[1].steps.at(-1).status, "failed");
  assert.ok(states[0].report);
  assert.equal(states[1].report, undefined);
  assert.equal(fixture.runtime.calls.length, 2);
  fail = false;
  const retry = await fixture.submit(buildAttachmentTaskPrompt([], states.filter(state => state.status !== "completed").map(state => state.target)));
  const recovered = await settled(fixture.core, retry.runId);
  assert.deepEqual(fixture.runtime.calls.map(input => input.attachmentTarget.id), ["A01", "A02", "A02", "A03"]);
  assert.deepEqual(stateOf(recovered).map(state => state.status), ["completed", "completed", "completed"]);
  assert.equal(stateOf(recovered)[0].report.body, states[0].report.body);
});

test("cancellation stops the queue and does not mark unfinished phases completed", async t => {
  const fixture = await setup(t, input => report(input, phase => {
    if (input.attachmentTarget.id === "A02" && phase === "analyzing") return new Promise((resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  }));
  const { runId } = await fixture.submit();
  await waitFor(fixture.core, snapshot => stateOf(snapshot)[1]?.steps[1].status === "running");
  await fixture.core.request({ type: "run.cancel", runId });
  const snapshot = await settled(fixture.core, runId);
  assert.equal(snapshot.runs.find(run => run.id === runId).status, "cancelled");
  assert.deepEqual(stateOf(snapshot).map(state => state.status), ["completed", "cancelled", "pending"]);
  assert.equal(fixture.runtime.calls.length, 2);
});

test("a correction reads only its attachment and retains that attachment's saved report as context", async t => {
  const fixture = await setup(t, input => report(input));
  const first = await fixture.submit();
  const original = stateOf(await settled(fixture.core, first.runId));
  const corrected = await fixture.submit(buildAttachmentCorrectionPrompt("单位应为 kWh，请核对。", original[1].target));
  const snapshot = await settled(fixture.core, corrected.runId);
  const last = fixture.runtime.calls.at(-1);
  assert.equal(last.attachmentTarget.id, "A02");
  assert.ok(last.prompt.includes(original[1].report.body));
  assert.ok(last.prompt.includes("单位应为 kWh"));
  assert.ok(!last.prompt.includes(original[0].report.body));
  assert.equal(fixture.runtime.calls.length, 4);
  assert.equal(stateOf(snapshot)[0].report.body, original[0].report.body);
});

test("unstructured final output is preserved without declaring a structured attachment report complete", async t => {
  const fixture = await setup(t, async function* () {
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "## A01 附件1.xlsx\n这份报告还没有保存。" } };
    yield { type: "turn.completed", usage };
  });
  const { runId } = await fixture.submit();
  const snapshot = await settled(fixture.core, runId);
  assert.equal(snapshot.runs.find(run => run.id === runId).status, "failed");
  assert.equal(fixture.runtime.calls.length, 1);
  assert.equal(stateOf(snapshot)[0].report, undefined);
  assert.ok(snapshot.items.some(record => record.item.type === "agent_message" && record.item.text.includes("还没有保存")));
});
