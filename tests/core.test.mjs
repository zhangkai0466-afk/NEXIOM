import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, realpath, mkdir, symlink, link, rename, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import service from "../.build/service.cjs";
const { CoreService, projectNameFromRoot } = service;

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-test-"));
  const core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { project, thread } = await core.request({
    type: "project.create",
    name: "中文 测试项目",
  });
  return { core, dir, project, thread };
}
test("filesystem roots always produce a visible project name", () => {
  const root = path.parse(tmpdir()).root;
  assert.equal(
    projectNameFromRoot(root),
    root.replace(/[\\/]+$/, "") || root,
  );
  assert.equal(projectNameFromRoot(path.join(root, "赛题", "工作区")), "工作区");
});

test("a filesystem root cannot be selected as a competition workspace", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-root-guard-"));
  const core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    core.openProject(path.parse(dir).root),
    error => {
      assert.ok(error.message.includes(path.parse(dir).root));
      assert.match(error.message, /具体的赛题工作文件夹/);
      return true;
    },
  );
  assert.equal(core.snapshot().snapshot.projects.length, 0);
});

test("workspace access revalidates roots that disappear, become files, or resolve to a filesystem root", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-root-revalidate-"));
  const core = new CoreService(path.join(dir, "app-data"));
  const missingRoot = path.join(dir, "missing-workspace");
  const fileRoot = path.join(dir, "file-workspace");
  const linkedRoot = path.join(dir, "linked-workspace");
  await Promise.all([mkdir(missingRoot), mkdir(fileRoot), mkdir(linkedRoot)]);
  t.after(async () => {
    await core.close();
    await rm(linkedRoot, { force: true });
    await rm(dir, { recursive: true, force: true });
  });

  const missing = await core.openProject(missingRoot);
  const file = await core.openProject(fileRoot);
  const linked = await core.openProject(linkedRoot);
  await rm(missingRoot, { recursive: true });
  await rm(fileRoot, { recursive: true });
  await writeFile(fileRoot, "not a directory");
  await rm(linkedRoot, { recursive: true });
  await symlink(
    path.parse(dir).root,
    linkedRoot,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    core.request({ type: "project.files", projectId: missing.project.id }),
    /工作文件夹不存在/,
  );
  await assert.rejects(
    core.request({ type: "memory.read", projectId: file.project.id }),
    /不是文件夹/,
  );
  await assert.rejects(
    core.request({ type: "memory.read", projectId: linked.project.id }),
    /磁盘或文件系统根目录/,
  );
});

test("workspace access rejects a saved root replaced by a link to another directory", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-root-redirect-"));
  const workspace = path.join(dir, "selected-workspace");
  const outside = path.join(dir, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  const core = new CoreService(path.join(dir, "app-data"));
  t.after(async () => {
    await core.close();
    await rm(workspace, { force: true });
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await core.openProject(workspace);
  await rm(workspace, { recursive: true });
  await symlink(outside, workspace, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    core.request({
      type: "file.import",
      projectId: opened.project.id,
      name: "不得越界.txt",
      base64: Buffer.from("blocked").toString("base64"),
    }),
    /工作文件夹已被链接到其他位置/,
  );
  await assert.rejects(readFile(path.join(outside, "inputs", "不得越界.txt"), "utf8"), /ENOENT/);
});

test("legacy root projects cannot read, import, or run against the whole disk", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-legacy-root-"));
  let core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  await core.close();
  const projectId = randomUUID();
  const threadId = randomUUID();
  const createdAt = new Date().toISOString();
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)")
    .run(projectId, "旧根目录项目", path.parse(dir).root, createdAt);
  db.prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId) VALUES (?, ?, ?, ?, 'model', NULL)")
    .run(threadId, projectId, "研究笔记", createdAt);
  db.close();
  core = new CoreService(dir);
  for (const command of [
    { type: "project.files", projectId },
    { type: "memory.read", projectId },
    { type: "file.import", projectId, name: "unsafe.txt", base64: Buffer.from("x").toString("base64") },
    { type: "agent.submit", threadId, text: "执行", clientRequestId: randomUUID() },
  ]) await assert.rejects(core.request(command), error => {
    assert.match(error.message, /磁盘或文件系统根目录/);
    assert.ok(error.message.includes(path.parse(dir).root));
    assert.match(error.message, /所有赛题.*选择赛题工作文件夹/);
    return true;
  });
  assert.ok(core.snapshot().snapshot.projects.some((item) => item.id === projectId));
});

test("an external competition workspace can be renamed without moving its files", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-project-rename-"));
  const workspace = path.join(dir, "2026国赛C题");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "题目说明.txt"), "keep me");
  let core = new CoreService(path.join(dir, "app-data"));
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await core.openProject(workspace);
  const projectId = opened.project.id;
  const threadId = opened.thread.id;
  assert.equal(opened.project.name, "2026国赛C题");
  const renamed = await core.request({
    type: "project.rename",
    projectId,
    name: "  国赛 C 题建模  ",
  });
  assert.equal(renamed.project.name, "国赛 C 题建模");
  assert.equal(renamed.project.root, await realpath(workspace));
  assert.equal(renamed.snapshot.threads.find((item) => item.projectId === projectId).id, threadId);
  assert.ok(renamed.snapshot.events.some((item) => item.type === "project.renamed"));
  await core.request({
    type: "file.import",
    projectId,
    name: "数据.csv",
    base64: Buffer.from("x,y\n1,2\n").toString("base64"),
  });
  assert.equal(await readFile(path.join(workspace, "inputs", "数据.csv"), "utf8"), "x,y\n1,2\n");
  assert.equal(await readFile(path.join(workspace, "题目说明.txt"), "utf8"), "keep me");

  await core.close();
  core = new CoreService(path.join(dir, "app-data"));
  const persisted = core.snapshot().snapshot.projects.find((item) => item.id === projectId);
  assert.equal(persisted.name, "国赛 C 题建模");
  assert.equal(persisted.root, renamed.project.root);
});

test("a competition workspace carries its project history into a fresh NEXIOM data directory", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-portable-project-"));
  const workspace = path.join(dir, "可迁移赛题");
  const firstDataDir = path.join(dir, "first-app-data");
  const secondDataDir = path.join(dir, "second-app-data");
  await mkdir(workspace);
  let core = new CoreService(firstDataDir);
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await core.openProject(workspace);
  await core.request({
    type: "project.rename",
    projectId: opened.project.id,
    name: "国赛 C 题 · 完整记录",
  });
  await core.request({
    type: "message.submit",
    threadId: opened.thread.id,
    text: "保留这条项目研究结论",
    clientRequestId: randomUUID(),
  });
  await core.close();

  const recordPath = path.join(workspace, ".nexiom", "project.json");
  const recordText = await readFile(recordPath, "utf8");
  const record = JSON.parse(recordText);
  assert.equal(record.format, "nexiom.project");
  assert.equal(record.version, 1);
  assert.equal(record.project.id, opened.project.id);
  assert.equal(record.project.name, "国赛 C 题 · 完整记录");
  assert.equal("root" in record.project, false);
  assert.ok(record.records.messages.some((item) => item.text === "保留这条项目研究结论"));
  assert.equal("settings" in record, false);
  assert.equal("providers" in record, false);
  assert.equal("account" in record, false);
  assert.equal("agentThreads" in record.records, false);

  core = new CoreService(secondDataDir);
  const restored = await core.openProject(workspace);
  assert.equal(restored.project.id, opened.project.id);
  assert.equal(restored.project.name, "国赛 C 题 · 完整记录");
  assert.equal(restored.project.root, await realpath(workspace));
  assert.equal(restored.thread.id, opened.thread.id);
  assert.ok(restored.snapshot.messages.some((item) => item.text === "保留这条项目研究结论"));
  assert.ok(restored.snapshot.events.some((item) => item.type === "project.restored"));
  const restoredDb = new DatabaseSync(path.join(secondDataDir, "workspace.sqlite"));
  assert.deepEqual(restoredDb.prepare("PRAGMA foreign_key_check").all(), []);
  restoredDb.close();
});

test("a moved workspace is relinked only when its project record matches local history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-project-relocate-"));
  const dataDir = path.join(dir, "app-data");
  const original = path.join(dir, "原赛题目录");
  const moved = path.join(dir, "移动后的赛题目录");
  await mkdir(original);
  let core = new CoreService(dataDir);
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await core.openProject(original);
  await core.request({
    type: "message.submit",
    threadId: opened.thread.id,
    text: "移动前已保存的结论",
    clientRequestId: randomUUID(),
  });
  await core.close();
  await rename(original, moved);

  core = new CoreService(dataDir);
  const relinked = await core.openProject(moved);
  assert.equal(relinked.project.id, opened.project.id);
  assert.equal(relinked.project.root, await realpath(moved));
  assert.ok(relinked.snapshot.messages.some((message) => message.text === "移动前已保存的结论"));
  assert.ok(relinked.snapshot.events.some((event) => event.type === "project.relocated"));
});

test("relinking refuses to overwrite a newer divergent record for the same project", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-project-relocate-conflict-"));
  const localData = path.join(dir, "local-app-data");
  const remoteData = path.join(dir, "remote-app-data");
  const original = path.join(dir, "原赛题目录");
  const moved = path.join(dir, "异机继续工作的赛题目录");
  await mkdir(original);
  let local = new CoreService(localData);
  let remote;
  t.after(async () => {
    await local?.close();
    await remote?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await local.openProject(original);
  await local.request({
    type: "message.submit",
    threadId: opened.thread.id,
    text: "本机旧结论",
    clientRequestId: randomUUID(),
  });
  await local.close();
  await rename(original, moved);

  remote = new CoreService(remoteData);
  const imported = await remote.openProject(moved);
  await remote.request({
    type: "message.submit",
    threadId: imported.thread.id,
    text: "另一台机器上的新结论",
    clientRequestId: randomUUID(),
  });
  await remote.close();
  const recordPath = path.join(moved, ".nexiom", "project.json");
  const newerRecord = await readFile(recordPath, "utf8");

  local = new CoreService(localData);
  await assert.rejects(
    local.openProject(moved),
    /项目记录与本机同一项目的记录不一致.*停止重新关联/,
  );
  assert.equal(await readFile(recordPath, "utf8"), newerRecord);
  assert.ok(local.snapshot().snapshot.messages.some((message) => message.text === "本机旧结论"));
  assert.equal(
    local.snapshot().snapshot.messages.some((message) => message.text === "另一台机器上的新结论"),
    false,
  );
});

test("startup never overwrites another project record placed at the same ordinary path", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-project-path-replaced-"));
  const occupiedPath = path.join(dir, "当前路径");
  const otherPath = path.join(dir, "另一个赛题");
  const firstData = path.join(dir, "first-app-data");
  const secondData = path.join(dir, "second-app-data");
  await Promise.all([mkdir(occupiedPath), mkdir(otherPath)]);
  let first = new CoreService(firstData);
  let second = new CoreService(secondData);
  t.after(async () => {
    await first?.close();
    await second?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const original = await first.openProject(occupiedPath);
  const other = await second.openProject(otherPath);
  await first.close();
  await second.close();
  await rm(occupiedPath, { recursive: true });
  await rename(otherPath, occupiedPath);
  const otherRecordPath = path.join(occupiedPath, ".nexiom", "project.json");
  const otherRecord = await readFile(otherRecordPath, "utf8");

  first = new CoreService(firstData);
  assert.equal(await readFile(otherRecordPath, "utf8"), otherRecord);
  assert.equal(JSON.parse(otherRecord).project.id, other.project.id);
  assert.notEqual(other.project.id, original.project.id);
  assert.ok(
    first.snapshot().snapshot.events.some(
      (event) => event.type === "project.record_failed" && /另一个 NEXIOM 项目/.test(event.summary),
    ),
  );
});

test("a linked .nexiom directory cannot redirect project records outside the workspace", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-record-link-"));
  const dataDir = path.join(dir, "app-data");
  const workspace = path.join(dir, "赛题");
  const outside = path.join(dir, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, path.join(workspace, ".nexiom"), process.platform === "win32" ? "junction" : "dir");
  const core = new CoreService(dataDir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(core.openProject(workspace), /\.nexiom.*链接到其他位置/);
  assert.equal(core.snapshot().snapshot.projects.length, 0);
  await assert.rejects(readFile(path.join(outside, "project.json"), "utf8"), /ENOENT/);
});

test("a symlinked project.json cannot redirect record reads outside the workspace", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-record-file-symlink-"));
  const workspace = path.join(dir, "赛题");
  const recordDirectory = path.join(workspace, ".nexiom");
  const outsideRecord = path.join(dir, "outside-project.json");
  await mkdir(recordDirectory, { recursive: true });
  await writeFile(outsideRecord, '{"private":true}\n');
  let core;
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });
  try {
    await symlink(outsideRecord, path.join(recordDirectory, "project.json"), "file");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip("当前 Windows 环境不允许创建文件符号链接");
      return;
    }
    throw error;
  }
  core = new CoreService(path.join(dir, "app-data"));
  await assert.rejects(core.openProject(workspace), /项目记录路径不是普通文件/);
  assert.equal(core.snapshot().snapshot.projects.length, 0);
  assert.equal(await readFile(outsideRecord, "utf8"), '{"private":true}\n');
});

test("a linked project.json cannot be read from or overwritten outside the workspace", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-record-file-link-"));
  const workspace = path.join(dir, "赛题");
  const recordDirectory = path.join(workspace, ".nexiom");
  const recordPath = path.join(recordDirectory, "project.json");
  const outsideRecord = path.join(dir, "outside-project.json");
  const outsideText = '{"private":"must stay outside"}\n';
  await mkdir(recordDirectory, { recursive: true });
  await writeFile(outsideRecord, outsideText);
  await link(outsideRecord, recordPath);
  let core = new CoreService(path.join(dir, "first-app-data"));
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(core.openProject(workspace), /项目记录路径不是普通文件/);
  assert.equal(core.snapshot().snapshot.projects.length, 0);
  assert.equal(await readFile(outsideRecord, "utf8"), outsideText);
  await core.close();

  await rm(recordPath);
  core = new CoreService(path.join(dir, "second-app-data"));
  const opened = await core.openProject(workspace);
  await rm(recordPath);
  await link(outsideRecord, recordPath);
  await core.request({
    type: "project.rename",
    projectId: opened.project.id,
    name: "不会覆盖外部文件",
  });
  assert.equal(await readFile(outsideRecord, "utf8"), outsideText);
  assert.ok(core.snapshot().snapshot.events.some((event) => event.type === "project.record_failed"));
});

test("project record import rejects invalid UUIDs, enums, and run relationships", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-record-validation-"));
  const workspace = path.join(dir, "赛题");
  const recordPath = path.join(workspace, ".nexiom", "project.json");
  await mkdir(workspace);
  let core = new CoreService(path.join(dir, "source-app-data"));
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });
  await core.openProject(workspace);
  await core.close();
  const validRecord = JSON.parse(await readFile(recordPath, "utf8"));

  const cases = [
    {
      name: "invalid project UUID",
      mutate: (record) => { record.project.id = "not-a-uuid"; },
      error: /project\.id.*UUID/,
    },
    {
      name: "invalid thread stage",
      mutate: (record) => { record.records.threads[0].stageId = "unknown-stage"; },
      error: /threads\.stageId.*取值无效/,
    },
    {
      name: "event pointing to a missing run",
      mutate: (record) => { record.records.events[0].runId = randomUUID(); },
      error: /事件关联了不存在的运行/,
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const candidate = structuredClone(validRecord);
    scenario.mutate(candidate);
    await writeFile(recordPath, JSON.stringify(candidate));
    core = new CoreService(path.join(dir, `invalid-app-data-${index}`));
    await assert.rejects(core.openProject(workspace), scenario.error, scenario.name);
    assert.equal(core.snapshot().snapshot.projects.length, 0, scenario.name);
    await core.close();
  }
});

test("removing a project clears only NEXIOM records and keeps the workspace files", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-project-remove-"));
  const dataDir = path.join(dir, "app-data");
  const workspace = path.join(dir, "赛题一");
  const otherWorkspace = path.join(dir, "赛题二");
  await mkdir(workspace);
  await mkdir(otherWorkspace);
  await writeFile(path.join(workspace, "成果.md"), "# result");
  let core = new CoreService(dataDir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  const target = await core.openProject(workspace);
  const other = await core.openProject(otherWorkspace);
  await core.request({
    type: "message.submit",
    threadId: target.thread.id,
    text: "保存在 NEXIOM 中的研究记录",
    clientRequestId: randomUUID(),
  });
  const memory = await core.request({ type: "memory.read", projectId: target.project.id });
  await core.request({
    type: "memory.write",
    projectId: target.project.id,
    text: "项目约束",
    expectedRevision: memory.memory.revision,
  });
  await core.request({
    type: "file.import",
    projectId: target.project.id,
    name: "观测.csv",
    base64: Buffer.from("n,value\n1,3\n").toString("base64"),
  });

  const recordPath = path.join(workspace, ".nexiom", "project.json");
  await rm(recordPath);
  const result = await core.request({ type: "project.remove", projectId: target.project.id });
  assert.equal(result.snapshot.projects.some((item) => item.id === target.project.id), false);
  assert.equal(result.snapshot.projects.some((item) => item.id === other.project.id), true);
  assert.equal(await readFile(path.join(workspace, "成果.md"), "utf8"), "# result");
  assert.equal(await readFile(path.join(workspace, "inputs", "观测.csv"), "utf8"), "n,value\n1,3\n");
  assert.equal(await readFile(path.join(workspace, ".nexiom", "MEMORY.md"), "utf8"), "项目约束");
  const keptRecord = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(keptRecord.project.id, target.project.id);
  assert.ok(keptRecord.records.messages.some((item) => item.text === "保存在 NEXIOM 中的研究记录"));

  await core.close();
  const db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM projects WHERE id=?").get(target.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM threads WHERE projectId=?").get(target.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM questions WHERE projectId=?").get(target.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM runs WHERE projectId=?").get(target.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE projectId=?").get(target.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM messages WHERE threadId=?").get(target.thread.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM requests WHERE threadId=?").get(target.thread.id).count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  core = new CoreService(dataDir);
  assert.equal(core.snapshot().snapshot.projects.some((item) => item.id === target.project.id), false);
  assert.equal(core.snapshot().snapshot.projects.some((item) => item.id === other.project.id), true);
  const restored = await core.openProject(workspace);
  assert.equal(restored.project.id, target.project.id);
  assert.ok(restored.snapshot.messages.some((item) => item.text === "保存在 NEXIOM 中的研究记录"));
});

test("project removal keeps SQLite data after a save failure until explicit discard is requested", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-project-remove-save-failure-"));
  const dataDir = path.join(dir, "app-data");
  const workspace = path.join(dir, "赛题");
  await mkdir(workspace);
  const core = new CoreService(dataDir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });

  const opened = await core.openProject(workspace);
  await core.request({
    type: "message.submit",
    threadId: opened.thread.id,
    text: "不能在保存失败时丢失",
    clientRequestId: randomUUID(),
  });
  const recordPath = path.join(workspace, ".nexiom", "project.json");
  await rm(recordPath);
  await mkdir(recordPath);

  await assert.rejects(
    core.request({ type: "project.remove", projectId: opened.project.id }),
    /无法安全移除项目.*最新项目记录未能保存/,
  );
  const snapshot = core.snapshot().snapshot;
  assert.ok(snapshot.projects.some((project) => project.id === opened.project.id));
  assert.ok(snapshot.messages.some((message) => message.text === "不能在保存失败时丢失"));
  let db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM projects WHERE id=?").get(opened.project.id).count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM messages WHERE threadId=?").get(opened.thread.id).count, 2);
  db.close();

  const result = await core.request({
    type: "project.remove",
    projectId: opened.project.id,
    discardUnsavedRecord: true,
  });
  assert.equal(result.snapshot.projects.some((project) => project.id === opened.project.id), false);
  assert.equal(result.snapshot.messages.some((message) => message.threadId === opened.thread.id), false);
  db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS count FROM projects WHERE id=?").get(opened.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM threads WHERE projectId=?").get(opened.project.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM messages WHERE threadId=?").get(opened.thread.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM requests WHERE threadId=?").get(opened.thread.id).count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM events WHERE projectId=?").get(opened.project.id).count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  assert.equal((await lstat(recordPath)).isDirectory(), true);
});

test("a legacy filesystem-root project can be explicitly removed without writing to the root", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-remove-legacy-root-"));
  let core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { project } = await core.request({ type: "project.create", name: "历史根目录项目" });
  await core.close();
  const filesystemRoot = path.parse(dir).root;
  const rootRecordPath = path.join(filesystemRoot, ".nexiom", "project.json");
  const observeRootRecord = async () => {
    try {
      const info = await lstat(rootRecordPath);
      return { type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other", size: info.size, modified: info.mtimeMs };
    } catch (error) {
      return { error: error.code };
    }
  };
  const before = await observeRootRecord();
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.prepare("UPDATE projects SET root=? WHERE id=?").run(filesystemRoot, project.id);
  db.close();
  core = new CoreService(dir);

  await assert.rejects(
    core.request({ type: "project.remove", projectId: project.id }),
    /最新项目记录未能保存.*根目录/,
  );
  assert.ok(core.snapshot().snapshot.projects.some((item) => item.id === project.id));
  assert.deepEqual(await observeRootRecord(), before);

  const result = await core.request({
    type: "project.remove",
    projectId: project.id,
    discardUnsavedRecord: true,
  });
  assert.equal(result.snapshot.projects.some((item) => item.id === project.id), false);
  assert.deepEqual(await observeRootRecord(), before);
});

test("a project with a running task cannot be removed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-remove-running-"));
  const core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { project, thread } = await core.request({ type: "project.create", name: "运行中项目" });
  const runId = randomUUID();
  let db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'running', ?, NULL)")
    .run(runId, thread.id, project.id, new Date().toISOString());
  db.close();
  await assert.rejects(
    core.request({ type: "project.remove", projectId: project.id }),
    /仍有任务正在运行/,
  );
  await assert.rejects(
    core.request({ type: "project.remove", projectId: project.id, discardUnsavedRecord: true }),
    /仍有任务正在运行/,
  );
  assert.ok(core.snapshot().snapshot.projects.some((item) => item.id === project.id));
  db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.prepare("DELETE FROM runs WHERE id=?").run(runId);
  db.close();
});

test("startup repairs an existing project with a blank name", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-blank-project-"));
  const projectRoot = path.join(dir, "selected-workspace");
  await mkdir(projectRoot);
  const projectId = randomUUID();
  const threadId = randomUUID();
  const createdAt = new Date().toISOString();
  let core;
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, createdAt TEXT NOT NULL, stageId TEXT NOT NULL DEFAULT 'model' CHECK(stageId IN ('model','validation','chart','paper')), questionId TEXT);
    PRAGMA user_version=5;
  `);
  db.prepare("INSERT INTO projects VALUES (?, '', ?, ?)").run(projectId, projectRoot, createdAt);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, 'model', NULL)").run(threadId, projectId, "研究笔记", createdAt);
  db.close();

  core = new CoreService(dir);
  assert.deepEqual(core.snapshot().snapshot.projects.map(({ id, name, root }) => ({ id, name, root })), [
    { id: projectId, name: "selected-workspace", root: projectRoot },
  ]);
  assert.equal(core.snapshot().snapshot.threads[0].id, threadId);
  const reopened = await core.openProject(projectRoot);
  assert.equal(reopened.project.name, "selected-workspace");
  assert.equal(reopened.snapshot.projects.length, 1);
  assert.equal(reopened.snapshot.threads.length, 1);
});

test("notes survive reopening and a repeated request does not duplicate messages", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let core = new CoreService(dir);
  const { thread } = await core.request({
    type: "project.create",
    name: "持久化项目",
  });
  const command = {
    type: "message.submit",
    threadId: thread.id,
    text: "验证研究记录",
    clientRequestId: randomUUID(),
  };
  await core.request(command);
  await core.request(command);
  assert.equal(core.snapshot().snapshot.messages.length, 2);
  await assert.rejects(
    core.request({ ...command, text: "不同内容" }),
    /不一致/,
  );
  await core.close();
  core = new CoreService(dir);
  assert.equal(core.snapshot().snapshot.messages[0].text, "验证研究记录");
  assert.equal(core.snapshot().snapshot.runtime.connected, false);
  await core.close();
});
test("imports do not overwrite files; reads reject traversal and symlink escape", async (t) => {
  const { core, dir, project } = await setup(t);
  const payload = {
    type: "file.import",
    projectId: project.id,
    name: "数据.csv",
    base64: Buffer.from("x,y\n1,2\n").toString("base64"),
  };
  await core.request(payload);
  await assert.rejects(core.request(payload), /同名附件/);
  const result = await core.request({
    type: "file.read",
    projectId: project.id,
    path: "inputs/数据.csv",
  });
  assert.equal(result.file.text, "x,y\n1,2\n");
  const pdfBytes = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF");
  await core.request({
    type: "file.import",
    projectId: project.id,
    name: "赛题.pdf",
    base64: pdfBytes.toString("base64"),
  });
  const pdf = await core.request({
    type: "file.read",
    projectId: project.id,
    path: "inputs/赛题.pdf",
  });
  assert.equal(pdf.file.mime, "application/pdf");
  assert.equal(Buffer.from(pdf.file.base64, "base64").toString(), pdfBytes.toString());
  await assert.rejects(
    core.request({ ...payload, name: "../outside.csv" }),
    /文件名无效/,
  );
  await assert.rejects(
    core.request({ ...payload, name: "CON.txt" }),
    /文件名无效/,
  );
  await writeFile(path.join(dir, "outside.txt"), "private");
  await assert.rejects(
    core.request({
      type: "file.read",
      projectId: project.id,
      path: "../../outside.txt",
    }),
    /超出项目范围/,
  );
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(
    outside,
    path.join(project.root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    core.request({
      type: "file.read",
      projectId: project.id,
      path: "linked/secret.txt",
    }),
    /超出项目范围/,
  );
});
test("startup marks an abandoned run interrupted without replaying it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let core = new CoreService(dir);
  const { project, thread } = await core.request({
    type: "project.create",
    name: "恢复验证",
  });
  await core.close();
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL)").run(
    randomUUID(),
    thread.id,
    project.id,
    "running",
    new Date().toISOString(),
  );
  db.close();
  core = new CoreService(dir);
  assert.equal(core.snapshot().snapshot.runs[0].status, "interrupted");
  assert.equal(core.snapshot().snapshot.events.at(-1).type, "run.interrupted");
  await core.close();
});

test("a second core cannot acquire the same workspace", async (t) => {
  const { dir } = await setup(t);
  assert.throws(() => new CoreService(dir), /另一个本地核心/);
});

test("a newer schema is refused without downgrading its version", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-schema-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "workspace.sqlite");
  let db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=99");
  db.close();
  assert.throws(() => new CoreService(dir), /版本高于/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 99);
  db.close();
});
