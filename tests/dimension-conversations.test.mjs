import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import service from "../.build/service.cjs";

const { CoreService } = service;
const stages = {
  reading: "赛题研读",
  attachments: "附件分析",
  delivery: "检查交付",
};

test("project dimension chats are created once, stay separate, and persist with conversation renames", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-dimension-chats-"));
  let core = new CoreService(dir);
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { project, thread: legacy } = await core.request({ type: "project.create", name: "赛题一" });
  const { project: other } = await core.request({ type: "project.create", name: "赛题二" });
  const { thread: modeling } = await core.request({
    type: "thread.create", projectId: project.id, stageId: "model", questionName: "问题一",
  });
  await core.request({ type: "thread.rename", threadId: legacy.id, title: "研究思路" });
  await core.request({ type: "thread.rename", threadId: modeling.id, title: " 问题一：优化方案 " });
  const identities = new Map();
  for (const [stageId, title] of Object.entries(stages)) {
    const request = { type: "thread.ensure", projectId: project.id, stageId };
    const repeated = await Promise.all(Array.from({ length: 5 }, () => core.request(request)));
    assert.equal(new Set(repeated.map(({ thread }) => thread.id)).size, 1);
    const thread = repeated[0].thread;
    identities.set(stageId, thread.id);
    assert.equal(thread.title, title);
    assert.equal(thread.questionId, null);
    assert.equal(thread.stageId, stageId);
    assert.equal(repeated.at(-1).snapshot.threads.filter((item) => item.projectId === project.id && item.stageId === stageId).length, 1);
    await core.request({ type: "message.submit", threadId: thread.id, text: `${title}专属记录`, clientRequestId: randomUUID() });
    const otherThread = (await core.request({ ...request, projectId: other.id })).thread;
    assert.notEqual(otherThread.id, thread.id);
  }
  assert.equal(new Set(identities.values()).size, 3);
  const before = core.snapshot().snapshot;
  await assert.rejects(core.request({ type: "thread.ensure", projectId: project.id, stageId: "model" }));
  await assert.rejects(core.request({ type: "thread.ensure", projectId: project.id, stageId: "overview" }));
  await assert.rejects(core.request({ type: "thread.ensure", projectId: randomUUID(), stageId: "reading" }), /项目不存在/);
  await assert.rejects(core.request({ type: "thread.create", projectId: project.id, stageId: "overview" }));
  await assert.rejects(core.request({ type: "thread.rename", threadId: modeling.id, title: "  " }));
  assert.equal(core.snapshot().snapshot.threads.length, before.threads.length);
  assert.equal(core.snapshot().snapshot.runs.length, 0);
  await core.close();
  core = new CoreService(dir);
  const snapshot = core.snapshot().snapshot;
  assert.equal(snapshot.threads.find(({ id }) => id === legacy.id).title, "研究思路");
  assert.deepEqual({ ...snapshot.threads.find(({ id }) => id === modeling.id) }, { ...modeling, title: "问题一：优化方案" });
  for (const [stageId, threadId] of identities) {
    const reopened = await core.request({ type: "thread.ensure", projectId: project.id, stageId });
    assert.equal(reopened.thread.id, threadId);
    assert.deepEqual(reopened.snapshot.messages.filter((message) => message.threadId === threadId && message.role === "user").map(({ text }) => text), [`${stages[stageId]}专属记录`]);
  }
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    assert.throws(() => db.prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId) VALUES (?, ?, ?, ?, 'reading', NULL)")
      .run(randomUUID(), project.id, "重复", new Date().toISOString()), /UNIQUE constraint/);
    assert.throws(() => db.prepare("UPDATE threads SET questionId=? WHERE id=?").run(modeling.questionId, identities.get("reading")), /CHECK constraint/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("version 6 upgrade retains question threads and every dependent history record", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-v6-dimensions-"));
  let core = new CoreService(dir);
  t.after(async () => {
    await core?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { project } = await core.request({ type: "project.create", name: "历史赛题" });
  const { thread } = await core.request({ type: "thread.create", projectId: project.id, stageId: "chart", questionName: "问题三", title: "历史绘图" });
  const note = { type: "message.submit", threadId: thread.id, text: "保留的讨论内容", clientRequestId: randomUUID() };
  await core.request(note);
  const oldMessages = core.snapshot().snapshot.messages;
  await core.close();
  core = undefined;
  const runId = randomUUID();
  const requestId = randomUUID();
  const createdAt = "2026-09-19T02:00:00.000Z";
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      CREATE TABLE threads_v6 (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, createdAt TEXT NOT NULL, stageId TEXT NOT NULL DEFAULT 'model' CHECK(stageId IN ('model','validation','chart','paper')), questionId TEXT REFERENCES questions(id));
      INSERT INTO threads_v6 (id,projectId,title,createdAt,stageId,questionId)
        SELECT id,projectId,title,createdAt,stageId,questionId FROM threads;
      DROP TABLE threads;
      ALTER TABLE threads_v6 RENAME TO threads;
      PRAGMA user_version=6;
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'succeeded', ?, ?)").run(runId, thread.id, project.id, createdAt, createdAt);
    db.prepare("INSERT INTO agent_runs (runId,mode,usage,providerId,providerFingerprint,runtimeConfig) VALUES (?, 'plan', ?, 'nexiom-default', 'private-fingerprint', '{}')").run(runId, '{"input_tokens":8,"output_tokens":3}');
    db.prepare("INSERT INTO agent_requests VALUES (?, 'request-digest', ?)").run(requestId, runId);
    db.prepare("INSERT INTO agent_threads VALUES (?, 'private-engine-id', 'private-fingerprint')").run(thread.id);
    db.prepare("INSERT INTO agent_items VALUES ('historical-item', ?, ?, 1, 'completed', ?, ?)").run(runId, thread.id, '{"id":"message","type":"agent_message","text":"历史结果"}', createdAt);
    db.prepare("INSERT INTO agent_contexts VALUES (?, ?)").run(thread.id, JSON.stringify({ threadId: thread.id, engineThreadId: "private-engine-id", totalTokens: 11 }));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
  core = new CoreService(dir);
  const migrated = core.snapshot().snapshot;
  assert.deepEqual({ ...migrated.threads.find(({ id }) => id === thread.id) }, thread);
  assert.deepEqual(migrated.messages, oldMessages);
  assert.equal(migrated.questions.find(({ id }) => id === thread.questionId).name, "问题三");
  assert.equal(migrated.runs.find(({ id }) => id === runId).usage, '{"input_tokens":8,"output_tokens":3}');
  assert.equal(migrated.items.find(({ id }) => id === "historical-item").item.text, "历史结果");
  assert.equal(migrated.contexts.find((item) => item.threadId === thread.id).engineThreadId, "private-engine-id");
  await core.request(note);
  assert.deepEqual(core.snapshot().snapshot.messages, oldMessages);
  for (const stageId of Object.keys(stages))
    await core.request({ type: "thread.ensure", projectId: project.id, stageId });
  const inspected = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  try {
    assert.equal(inspected.prepare("PRAGMA user_version").get().user_version, 10);
    assert.equal(inspected.prepare("SELECT engineThreadId FROM agent_threads WHERE threadId=?").get(thread.id).engineThreadId, "private-engine-id");
    assert.equal(inspected.prepare("SELECT runId FROM agent_requests WHERE id=?").get(requestId).runId, runId);
    assert.deepEqual(inspected.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    inspected.close();
  }
  await core.request({ type: "project.remove", projectId: project.id });
  const removed = core.snapshot().snapshot;
  for (const key of ["projects", "questions", "threads", "messages", "runs", "items", "contexts"])
    assert.equal(removed[key].length, 0, `${key} was not removed`);
});

test("each project dimension submits its own stage identity and conversation history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-dimension-runtime-"));
  const calls = [];
  const runtime = {
    async probe(provider) {
      return {
        connected: true, available: true, authenticated: true, label: "fixture", version: "fixture",
        hasApiKey: false, activeProviderId: provider.id, activeProviderName: provider.name,
        activeModel: "fixture-model", activeModelProvider: "nexiom",
      };
    },
    async listModels() { return ["fixture-model"]; },
    async *run(input) {
      calls.push(input);
      yield { type: "thread.started", thread_id: `engine-${input.stageId}` };
      yield { type: "item.completed", item: { id: `answer-${input.stageId}`, type: "agent_message", text: `${input.stageId}的回答` } };
      yield { type: "turn.completed", usage: { input_tokens: 4, output_tokens: 2 } };
    },
  };
  const core = new CoreService(dir, () => {}, { runner: runtime });
  t.after(async () => {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  });
  await core.request({
    type: "provider.upsert",
    provider: { id: "nexiom-default", name: "Fixture", kind: "responses", endpoint: "http://127.0.0.1:1234/v1", model: "fixture-model", auth: "none" },
  });
  await core.request({ type: "runtime.check" });
  const { project, thread: old } = await core.request({ type: "project.create", name: "独立对话赛题" });
  await core.request({ type: "message.submit", threadId: old.id, text: "其他对话的专属历史", clientRequestId: randomUUID() });
  for (const [stageId, name] of Object.entries(stages)) {
    const { thread } = await core.request({ type: "thread.ensure", projectId: project.id, stageId });
    const { runId } = await core.request({ type: "agent.submit", threadId: thread.id, text: `讨论${name}`, clientRequestId: randomUUID() });
    for (let i = 0; i < 100 && core.snapshot().snapshot.runs.find(({ id }) => id === runId).status === "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = core.snapshot().snapshot;
    const run = snapshot.runs.find(({ id }) => id === runId);
    assert.equal(run.status, "succeeded");
    assert.deepEqual(JSON.parse(run.runtimeConfig).modelingContext, {
      project: { id: project.id, name: project.name },
      question: null,
      stage: { id: stageId, name },
      threadId: thread.id,
    });
    const call = calls.at(-1);
    assert.equal(call.stageId, stageId);
    assert.ok(!call.prompt.includes("其他对话的专属历史"));
    assert.ok(call.prompt.endsWith(`讨论${name}`));
    assert.equal(snapshot.items.find((item) => item.threadId === thread.id && item.item.type === "agent_message").item.text, `${stageId}的回答`);
  }
  assert.equal(calls.length, Object.keys(stages).length);
});
