import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import service from "../.build/service.cjs";

const { CoreService } = service;

async function workspace(t, options) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-modeling-"));
  const core = new CoreService(dir, () => {}, options);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { core, dir };
}

test("problem identity is shared across stages and remains isolated between projects", async (t) => {
  const { core } = await workspace(t);
  const { project, thread: initial } = await core.request({ type: "project.create", name: "赛题 A" });
  assert.equal(initial.stageId, "model");
  assert.equal(initial.questionId, null);
  const { thread: model } = await core.request({
    type: "thread.create", projectId: project.id, stageId: "model", questionName: " 问题一 ",
  });
  assert.equal(model.title, "问题一");
  const { thread: validation } = await core.request({
    type: "thread.create", projectId: project.id, stageId: "validation", questionId: model.questionId,
  });
  const { thread: paper } = await core.request({
    type: "thread.create", projectId: project.id, stageId: "paper", questionName: "问题一", title: " 结果解释 ",
  });
  assert.notEqual(validation.id, model.id);
  assert.equal(validation.questionId, model.questionId);
  assert.equal(paper.questionId, model.questionId);
  assert.equal(paper.title, "结果解释");
  assert.equal(core.snapshot().snapshot.questions.length, 1);
  await core.request({ type: "thread.rename", threadId: paper.id, title: "论文初稿" });
  assert.equal(core.snapshot().snapshot.threads.find(({ id }) => id === paper.id).questionId, model.questionId);

  const { project: other } = await core.request({ type: "project.create", name: "赛题 B" });
  const before = core.snapshot().snapshot;
  await assert.rejects(core.request({
    type: "thread.create", projectId: other.id, stageId: "chart", questionId: model.questionId,
  }), /不属于/);
  await assert.rejects(core.request({
    type: "thread.create", projectId: project.id, questionId: model.questionId, questionName: "问题二",
  }), /请选择/);
  await assert.rejects(core.request({
    type: "thread.create", projectId: project.id, questionName: "问题二", stageId: "unknown",
  }));
  assert.equal(core.snapshot().snapshot.threads.length, before.threads.length);
  assert.equal(core.snapshot().snapshot.questions.length, before.questions.length);
  const { thread: otherModel } = await core.request({
    type: "thread.create", projectId: other.id, questionName: "问题一",
  });
  assert.notEqual(otherModel.questionId, model.questionId);
  assert.equal(otherModel.stageId, "model");
});

test("conversation menu actions persist, move and fork history, and delete all dependent records", async (t) => {
  const { core, dir } = await workspace(t);
  const { project } = await core.request({ type: "project.create", name: "源项目" });
  const { project: targetProject } = await core.request({ type: "project.create", name: "目标项目" });
  const { thread } = await core.request({
    type: "thread.create", projectId: project.id, stageId: "model", questionName: "问题一", title: "效率模型",
  });
  await core.request({ type: "message.submit", threadId: thread.id, text: "保留这段建模讨论", clientRequestId: randomUUID() });

  let result = await core.request({ type: "thread.unread", threadId: thread.id, unread: true });
  assert.equal(result.snapshot.threads.find(({ id }) => id === thread.id).unread, true);
  result = await core.request({ type: "thread.archive", threadId: thread.id, archived: true });
  assert.ok(result.snapshot.threads.find(({ id }) => id === thread.id).archivedAt);
  result = await core.request({ type: "thread.archive", threadId: thread.id, archived: false });
  assert.equal(result.snapshot.threads.find(({ id }) => id === thread.id).archivedAt, null);

  const moved = (await core.request({ type: "thread.move", threadId: thread.id, projectId: targetProject.id })).thread;
  assert.equal(moved.projectId, targetProject.id);
  assert.equal(core.snapshot().snapshot.questions.find(({ id }) => id === moved.questionId).projectId, targetProject.id);
  assert.deepEqual(core.snapshot().snapshot.messages.filter(({ threadId }) => threadId === moved.id).map(({ text }) => text), [
    "保留这段建模讨论",
    "已保存这条研究笔记。模型尚未连接，本轮未执行分析或代码。",
  ]);

  const fork = (await core.request({ type: "thread.fork", threadId: moved.id, projectId: targetProject.id })).thread;
  assert.notEqual(fork.id, moved.id);
  assert.equal(fork.title, "效率模型（分叉）");
  assert.equal(fork.questionId, moved.questionId);
  assert.deepEqual(
    core.snapshot().snapshot.messages.filter(({ threadId }) => threadId === fork.id).map(({ text }) => text),
    core.snapshot().snapshot.messages.filter(({ threadId }) => threadId === moved.id).map(({ text }) => text),
  );

  await core.request({ type: "thread.delete", threadId: moved.id });
  const deleted = core.snapshot().snapshot;
  assert.equal(deleted.threads.some(({ id }) => id === moved.id), false);
  assert.equal(deleted.messages.some(({ threadId }) => threadId === moved.id), false);
  assert.equal(deleted.threads.some(({ id }) => id === fork.id), true);
  await core.close();
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
  } finally {
    db.close();
  }
});

test("version 4 conversations and messages migrate without losing their original identity", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-v4-modeling-"));
  let core;
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const projectId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const createdAt = "2026-09-18T09:00:00.000Z";
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id), role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL, sequence INTEGER NOT NULL);
    PRAGMA user_version=4;
  `);
  db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run(projectId, "原赛题", dir, createdAt);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(threadId, projectId, "原对话", createdAt);
  db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(messageId, threadId, "user", "note", "必须保留的原始记录", createdAt, 1);
  db.close();
  core = new CoreService(dir);
  assert.deepEqual(core.snapshot().snapshot.threads.map((thread) => ({ ...thread })), [{
    id: threadId, projectId, title: "原对话", createdAt, stageId: "model", questionId: null,
    unread: false, archivedAt: null,
  }]);
  assert.equal(core.snapshot().snapshot.messages[0].id, messageId);
  assert.equal(core.snapshot().snapshot.messages[0].text, "必须保留的原始记录");
  const { thread: newThread } = await core.request({
    type: "thread.create", projectId, stageId: "chart", questionName: "问题一",
  });
  await core.close();
  core = new CoreService(dir);
  assert.equal(core.snapshot().snapshot.threads.find(({ id }) => id === newThread.id).questionId, newThread.questionId);
  assert.equal(core.snapshot().snapshot.questions[0].name, "问题一");
  await core.request({ type: "project.remove", projectId });
  assert.equal(core.snapshot().snapshot.projects.length, 0);
  assert.equal(core.snapshot().snapshot.messages.length, 0);
  const inspected = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 9);
  assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
  inspected.close();
});

test("local account nickname and avatar persist while unsupported avatar sources are rejected", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-account-"));
  let core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(core.snapshot().snapshot.account, { nickname: "NEXIOM 用户", avatar: null });
  const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1EAAAAASUVORK5CYII=";
  const result = await core.request({ type: "account.update", profile: { nickname: " 小co ", avatar } });
  assert.deepEqual(result.snapshot.account, { nickname: "小co", avatar });
  for (const invalid of [
    { nickname: " ", avatar },
    { nickname: "x".repeat(41), avatar },
    { nickname: "小co", avatar: "https://example.com/avatar.png" },
    { nickname: "小co", avatar: "data:image/svg+xml;base64,PHN2Zy8+" },
    { nickname: "小co", avatar: "data:image/png;base64," },
    { nickname: "小co", avatar: "data:image/png;base64,!!!!" },
    { nickname: "小co", avatar: `data:image/png;base64,${"AAAA".repeat(700001)}` },
  ]) await assert.rejects(core.request({ type: "account.update", profile: invalid }));
  await core.close();
  core = new CoreService(dir);
  assert.deepEqual(core.snapshot().snapshot.account, { nickname: "小co", avatar });
  await core.request({ type: "account.update", profile: { nickname: "小co", avatar: null } });
  assert.equal(core.snapshot().snapshot.account.avatar, null);
});

test("agent receives and records the current problem and stage without importing another conversation", async (t) => {
  const calls = [];
  const runtime = {
    async probe(provider) {
      return {
        connected: true, available: true, authenticated: true, label: "fixture", version: "fixture",
        hasApiKey: false, activeProviderId: provider.id, activeProviderName: provider.name,
        activeModel: "fixture-model", activeModelProvider: "fixture-provider",
      };
    },
    async listModels() { return ["fixture-model"]; },
    async *run(input) {
      calls.push(input);
      yield { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } };
    },
  };
  const { core } = await workspace(t, { runner: runtime });
  await core.request({
    type: "provider.upsert",
    provider: {
      id: "nexiom-default", name: "Fixture API", kind: "responses",
      endpoint: "http://127.0.0.1:1234/v1", model: "fixture-model", auth: "none",
    },
  });
  await core.request({ type: "runtime.check" });
  const { project, thread: old } = await core.request({ type: "project.create", name: "储能赛题" });
  await core.request({ type: "message.submit", threadId: old.id, text: "其他对话不能隐式注入的内容", clientRequestId: randomUUID() });
  const { thread } = await core.request({ type: "thread.create", projectId: project.id, stageId: "validation", questionName: "问题二" });
  const { runId } = await core.request({ type: "agent.submit", threadId: thread.id, text: "检查数据泄露", mode: "plan", clientRequestId: randomUUID() });
  for (let i = 0; i < 100 && core.snapshot().snapshot.runs.find(({ id }) => id === runId).status === "running"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const run = core.snapshot().snapshot.runs.find(({ id }) => id === runId);
  assert.equal(run.status, "succeeded");
  const identity = JSON.parse(run.runtimeConfig).modelingContext;
  assert.deepEqual(identity, {
    project: { id: project.id, name: "储能赛题" },
    question: { id: thread.questionId, name: "问题二" },
    stage: { id: "validation", name: "模型检验" },
    threadId: thread.id,
  });
  assert.ok(calls[0].prompt.includes(JSON.stringify(identity)));
  assert.ok(calls[0].prompt.endsWith("检查数据泄露"));
  assert.ok(!calls[0].prompt.includes("其他对话不能隐式注入的内容"));
});
