import path from "node:path";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import service from "../.build/service.cjs";
import { configureLiveProvider } from "./live-provider.mjs";

const data = path.resolve(".local", `app-server-smoke-${Date.now()}`);
const streamedLengths = new Set();
let core;
core = new service.CoreService(data, () => {
  if (!core) return;
  for (const item of core.snapshot().snapshot.items)
    if (
      item.status === "running" &&
      item.item.type === "agent_message" &&
      item.item.text
    )
      streamedLengths.add(`${item.id}:${item.item.text.length}`);
});

async function wait(runId) {
  for (let count = 0; count < 240; count++) {
    const snapshot = core.snapshot().snapshot;
    const run = snapshot.runs.find((item) => item.id === runId);
    if (run.status !== "running") {
      assert.equal(run.status, "succeeded", snapshot.messages.at(-1)?.text);
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await core.request({ type: "run.cancel", runId });
  throw new Error("Live agent timed out");
}

try {
  await configureLiveProvider(core);
  assert.equal(
    (await core.request({ type: "runtime.check" })).snapshot.runtime.connected,
    true,
  );
  const { project, thread } = await core.request({
    type: "project.create",
    name: "原生流式与项目记忆验证",
  });
  const { memory } = await core.request({
    type: "memory.read",
    projectId: project.id,
  });
  await core.request({
    type: "memory.write",
    projectId: project.id,
    expectedRevision: memory.revision,
    text: "团队核验口令：NEXIOM-MEM-7291。结果报告使用中文。",
  });
  const first = await core.request({
    type: "agent.submit",
    threadId: thread.id,
    text: "在当前目录创建 solve.py，使用 Python 标准库对 x=[1,2,3,4]、y=[3,5,7,9] 做最小二乘直线拟合，实际运行并生成 result.json，字段为 slope、intercept、rmse。不要联网或安装依赖。最后用三句话报告方法、结果和验证口令。",
    mode: "execute",
    executionConfirmed: true,
    clientRequestId: randomUUID(),
  });
  const firstState = await wait(first.runId);
  const firstUsage = JSON.parse(
    firstState.runs.find((run) => run.id === first.runId).usage,
  );
  assert.ok(
    firstUsage.input_tokens > firstState.contexts[0].lastInputTokens,
    "Multi-call execution must account for more than the final response",
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(project.root, "result.json"), "utf8")),
    { slope: 2, intercept: 1, rmse: 0 },
  );
  const engineThread = firstState.contexts[0].engineThreadId;
  await core.close();
  core = new service.CoreService(data);
  await configureLiveProvider(core);
  await core.request({ type: "runtime.check" });
  const next = await core.request({
    type: "agent.submit",
    threadId: thread.id,
    text: "不要调用工具，直接根据上一轮上下文回复 slope、intercept、rmse 结果，以及项目记忆中的核验口令。只需一句话。",
    mode: "plan",
    executionConfirmed: false,
    clientRequestId: randomUUID(),
  });
  const nextState = await wait(next.runId);
  const answer = nextState.items
    .filter(
      (item) => item.runId === next.runId && item.item.type === "agent_message",
    )
    .map((item) => item.item.text)
    .join("\n");
  assert.match(answer, /NEXIOM-MEM-7291/);
  assert.equal(nextState.contexts[0].engineThreadId, engineThread);
  assert.ok(
    streamedLengths.size >= 2,
    "Expected multiple real partial message notifications",
  );
  assert.ok(nextState.contexts[0].lastInputTokens > 0);
  console.log(
    JSON.stringify(
      {
        passed: true,
        data,
        projectRoot: project.root,
        streamedUpdates: streamedLengths.size,
        answer,
        context: nextState.contexts[0],
        firstTurnUsage: firstUsage,
      },
      null,
      2,
    ),
  );
} finally {
  await core.close();
}
