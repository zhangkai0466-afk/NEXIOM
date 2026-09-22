import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import runtime from "../.build/provider-runtime.cjs";

const sse = (...events) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
test("native attachment tools publish a report with accepted stage events through the real engine", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "nexiom-native-attachment-"));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const actions = ["reading", "analyzing", "thinking", "writing"].flatMap(phase => [
    { name: "set_attachment_stage", args: { attachmentId: "A01", phase, status: "running" } },
    ...(phase === "writing" ? [{ name: "publish_attachment_report", args: { attachmentId: "A01", body: "### 文件概况\n这是本地模拟供应商的隔离验证报告。" } }] : []),
    { name: "set_attachment_stage", args: { attachmentId: "A01", phase, status: "completed" } },
  ]);
  const requests = [];
  let index = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const action = actions[index++];
    const id = `attachment-${index}`;
    response.end(sse(
      { type: "response.created", response: { id } },
      action
        ? { type: "response.output_item.done", item: { type: "function_call", id, call_id: id, namespace: "nexiom_attachments", name: action.name, arguments: JSON.stringify(action.args) } }
        : { type: "response.output_item.done", item: { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "当前附件已完成。", annotations: [] }] } },
      { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 45000);
  t.after(async () => { clearTimeout(timer); abort.abort(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const provider = { id: "fixture", name: "fixture", kind: "responses", endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture", auth: "none", revision: 1, hasApiKey: false, createdAt: "", updatedAt: "" };
  const runner = new runtime.CodexRuntime({ runtimeHome: path.join(root, "runtime") });
  const events = [];
  for await (const event of runner.run({ prompt: "分析当前唯一附件", cwd, stageId: "attachments", attachmentTarget: { id: "A01", path: "inputs/a.xlsx", name: "a.xlsx" }, settings: { activeProviderId: "fixture", network: false, effort: "default" }, provider, signal: abort.signal })) events.push(event);
  assert.ok(events.some(event => event.type === "turn.completed"));
  const calls = events.filter(event => event.type === "item.completed" && event.item.type === "native_tool_call");
  assert.equal(calls.length, actions.length);
  assert.ok(calls.every(event => event.item.status === "completed" && event.item.result?.accepted === true && !event.item.error), JSON.stringify(calls));
  assert.match(JSON.stringify(requests[0].tools), /publish_attachment_report/);
  assert.match(JSON.stringify(requests[0]), /本轮只处理指定附件/);
  assert.equal(calls.find(event => event.item.tool === "publish_attachment_report").item.arguments.attachmentId, "A01");
});
