import path from "node:path";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import service from "../.build/service.cjs";
import { configureLiveProvider } from "./live-provider.mjs";

const data = path.resolve(".local", `app-server-cancel-${Date.now()}`);
const core = new service.CoreService(data);
try {
  await configureLiveProvider(core);
  await core.request({ type: "runtime.check" });
  const { project, thread } = await core.request({
    type: "project.create",
    name: "停止任务进程验证",
  });
  const { runId } = await core.request({
    type: "agent.submit",
    threadId: thread.id,
    text: "这是本地取消任务测试。仅运行一条 Python 命令：import os,pathlib,time; pathlib.Path('cancel-pid.txt').write_text(str(os.getpid())); time.sleep(90)。不要运行其他命令，不要联网、安装依赖或创建其他文件。等待这条命令完成。",
    mode: "execute",
    executionConfirmed: true,
    clientRequestId: randomUUID(),
  });
  let pid;
  for (let count = 0; count < 360; count++) {
    try {
      pid = Number(
        await readFile(path.join(project.root, "cancel-pid.txt"), "utf8"),
      );
    } catch {}
    if (pid) break;
    const run = core.snapshot().snapshot.runs.find((item) => item.id === runId);
    assert.equal(
      run.status,
      "running",
      core.snapshot().snapshot.messages.at(-1)?.text,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(pid, "Expected actual Python child PID");
  await core.request({ type: "run.cancel", runId });
  for (let count = 0; count < 100; count++) {
    if (
      core.snapshot().snapshot.runs.find((item) => item.id === runId).status !==
      "running"
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    core.snapshot().snapshot.runs.find((item) => item.id === runId).status,
    "cancelled",
  );
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  console.log(
    JSON.stringify({
      passed: true,
      pythonPid: pid,
      processTerminated: true,
      data,
    }),
  );
} finally {
  await core.close();
}
