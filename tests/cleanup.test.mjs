import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import service from "../.build/service.cjs";

async function moduleFor(file) {
  const result = await build({ entryPoints: [file], bundle: true, platform: "node", format: "esm", write: false, target: "node24" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { registerGeneratedFiles } = await moduleFor("packages/filesystem/generated-files.ts");
const { cleanStorage } = await moduleFor("packages/core/storage-cleanup.ts");
const { deleteProjectContents } = await moduleFor("packages/core/project-reset.ts");

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-cleanup-"));
  const core = new service.CoreService(dir);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const { project, thread } = await core.request({ type: "project.create", name: "清理验证" });
  await writeFile(path.join(project.root, "inputs", "原题.txt"), "original problem");
  const memory = (await core.request({ type: "memory.read", projectId: project.id })).memory;
  await core.request({ type: "memory.write", projectId: project.id, text: "Old project assumptions", expectedRevision: memory.revision });
  return { dir, core, project, thread };
}
async function preview(core, project) {
  return (await core.request({ type: "project.reset.preview", projectId: project.id })).resetPreview;
}
async function reset(core, project, options = {}) {
  return core.request({ type: "project.reset", projectId: project.id, revision: (await preview(core, project)).revision, ...options });
}
function seed(dir, project, thread, status = "succeeded") {
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  const runId = randomUUID();
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)").run(runId, thread.id, project.id, status, timestamp, status === "running" ? null : timestamp);
  db.prepare("INSERT INTO messages VALUES (?, ?, 'assistant', 'answer', 'Old report', ?, 100)").run(randomUUID(), thread.id, timestamp);
  db.prepare("INSERT INTO requests VALUES (?, ?, 'Old request')").run(randomUUID(), thread.id);
  db.prepare("INSERT INTO agent_runs (runId,mode) VALUES (?, 'execute')").run(runId);
  db.prepare("INSERT INTO agent_requests VALUES (?, 'digest', ?)").run(randomUUID(), runId);
  db.prepare("INSERT INTO agent_threads VALUES (?, 'old-native-thread', 'fingerprint')").run(thread.id);
  db.prepare("INSERT INTO agent_contexts VALUES (?, ?)").run(thread.id, JSON.stringify({ threadId: thread.id, engine: "codex", transport: "app-server", engineThreadId: "old-native-thread" }));
  db.prepare("INSERT INTO agent_items VALUES (?, ?, ?, 101, 'completed', ?, ?)").run(`${runId}:answer`, runId, thread.id, JSON.stringify({ id: "answer", type: "agent_message", text: "Old answer" }), timestamp);
  db.prepare("INSERT INTO events (id, projectId, type, runId, summary, createdAt) VALUES (?, ?, 'agent.succeeded', ?, 'Done', ?)").run(randomUUID(), project.id, runId, timestamp);
  db.close();
  return runId;
}

test("reset clears both stores, memory and context, preserves inputs, outputs, configuration and other projects", async t => {
  const { core, dir, project, thread } = await fixture(t);
  const other = await core.request({ type: "project.create", name: "另一个项目" });
  seed(dir, project, thread); seed(dir, other.project, other.thread);
  await writeFile(path.join(project.root, "paper.md"), "Existing paper");
  const before = core.snapshot().snapshot;
  const result = await reset(core, project);
  assert.ok(result.snapshot.projects.some(p => p.id === project.id));
  for (const key of ["threads", "messages", "runs", "events", "items", "contexts"])
    assert.ok(result.snapshot[key].every(row => row.projectId !== project.id && row.threadId !== thread.id && row.id !== thread.id), key);
  assert.deepEqual(result.snapshot.settings, before.settings);
  assert.deepEqual(result.snapshot.providers, before.providers);
  assert.ok(result.snapshot.messages.some(row => row.threadId === other.thread.id));
  assert.equal((await core.request({ type: "memory.read", projectId: project.id })).memory.text, "");
  assert.equal(await readFile(path.join(project.root, "inputs", "原题.txt"), "utf8"), "original problem");
  assert.equal(await readFile(path.join(project.root, "paper.md"), "utf8"), "Existing paper");
  const record = JSON.parse(await readFile(path.join(project.root, ".nexiom", "project.json"), "utf8"));
  assert.ok(Object.values(record.records).every(rows => rows.length === 0));
  await core.request({ type: "project.remove", projectId: project.id });
  const reopened = await core.openProject(project.root);
  assert.equal(reopened.project.id, project.id);
  assert.equal(reopened.snapshot.messages.some(row => row.text === "Old report" && row.threadId === thread.id), false);
  const reading = await core.request({ type: "thread.ensure", projectId: project.id, stageId: "reading" });
  assert.notEqual(reading.thread.id, thread.id);
});

test("optional deletion requires the project name and only deletes unchanged registered outputs", async t => {
  const { core, project } = await fixture(t);
  await writeFile(path.join(project.root, "generated.py"), "print(1)");
  await writeFile(path.join(project.root, "edited.py"), "print(2)");
  registerGeneratedFiles(project.root, ["generated.py", "edited.py", "inputs/原题.txt"]);
  await writeFile(path.join(project.root, "edited.py"), "manual edit");
  registerGeneratedFiles(project.root, ["edited.py"]); // A replay must retain the first recorded hash.
  const list = await preview(core, project);
  assert.deepEqual(list.generatedFiles.map(file => file.path), ["generated.py"]);
  assert.equal(list.preservedFiles, 1);
  await assert.rejects(reset(core, project, { deleteGenerated: true }), /项目名称/);
  await reset(core, project, { deleteGenerated: true, confirmationName: project.name });
  await assert.rejects(stat(path.join(project.root, "generated.py")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(project.root, "edited.py"), "utf8"), "manual edit");
  assert.ok(await stat(path.join(project.root, "inputs", "原题.txt")));
  await writeFile(path.join(project.root, "generated.py"), "new generated output");
  registerGeneratedFiles(project.root, ["generated.py"]);
  assert.deepEqual((await preview(core, project)).generatedFiles.map(file => file.path), ["generated.py"]);
});

test("a stale reset preview cannot discard new content or a modified output", async t => {
  const { core, project } = await fixture(t);
  const initial = await preview(core, project);
  await core.request({ type: "thread.create", projectId: project.id, title: "New work" });
  await assert.rejects(core.request({ type: "project.reset", projectId: project.id, revision: initial.revision }), /已变化/);
  await writeFile(path.join(project.root, "generated.py"), "before");
  registerGeneratedFiles(project.root, ["generated.py"]);
  const withFile = await preview(core, project);
  await writeFile(path.join(project.root, "generated.py"), "after");
  await assert.rejects(core.request({ type: "project.reset", projectId: project.id, revision: withFile.revision, deleteGenerated: true, confirmationName: project.name }), /已变化/);
  assert.equal(await readFile(path.join(project.root, "generated.py"), "utf8"), "after");
});

test("active runs block project reset and cache clearing in the core", async t => {
  const { core, dir, project, thread } = await fixture(t);
  seed(dir, project, thread, "running");
  await assert.rejects(reset(core, project), /正在运行/);
  await assert.rejects(core.request({ type: "storage.clear" }), /正在运行/);
});

test("a project mirror owned by another project refuses reset without changing SQL or memory", async t => {
  const { core, project, thread } = await fixture(t);
  const other = await core.request({ type: "project.create", name: "different" });
  await writeFile(path.join(project.root, ".nexiom", "project.json"), await readFile(path.join(other.project.root, ".nexiom", "project.json")));
  await assert.rejects(reset(core, project), /另一个/);
  assert.ok(core.snapshot().snapshot.threads.some(row => row.id === thread.id));
  assert.equal((await core.request({ type: "memory.read", projectId: project.id })).memory.text, "Old project assumptions");
});

test("a file staging failure restores the portable record, memory and SQL", async t => {
  const { core, project, thread } = await fixture(t);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith("MEMORY.md")) throw new Error("fixture: file in use");
    return originalRename(from, to);
  };
  try { await assert.rejects(reset(core, project), /file in use/); }
  finally { fs.renameSync = originalRename; }
  assert.ok(core.snapshot().snapshot.threads.some(row => row.id === thread.id));
  assert.equal((await core.request({ type: "memory.read", projectId: project.id })).memory.text, "Old project assumptions");
  const record = JSON.parse(await readFile(path.join(project.root, ".nexiom", "project.json"), "utf8"));
  assert.ok(record.records.threads.some(row => row.id === thread.id));
});

test("failure writing the empty mirror rolls back SQL and restores all staged files", async t => {
  const { core, dir, project, thread } = await fixture(t);
  seed(dir, project, thread);
  await writeFile(path.join(project.root, "generated.py"), "print(42)");
  registerGeneratedFiles(project.root, ["generated.py"]);
  const originalRename = fs.renameSync;
  let mirrorWrites = 0;
  fs.renameSync = (from, to) => {
    if (String(from).endsWith(".tmp") && String(to).endsWith("project.json") && ++mirrorWrites === 2)
      throw new Error("fixture: mirror write failed");
    return originalRename(from, to);
  };
  try { await assert.rejects(reset(core, project, { deleteGenerated: true, confirmationName: project.name }), /mirror write failed/); }
  finally { fs.renameSync = originalRename; }
  assert.ok(core.snapshot().snapshot.messages.some(row => row.threadId === thread.id && row.text === "Old report"));
  assert.equal(await readFile(path.join(project.root, "generated.py"), "utf8"), "print(42)");
  assert.equal((await core.request({ type: "memory.read", projectId: project.id })).memory.text, "Old project assumptions");
  const record = JSON.parse(await readFile(path.join(project.root, ".nexiom", "project.json"), "utf8"));
  assert.ok(record.records.messages.some(row => row.text === "Old report"));
});

test("reset rejects an in-flight attachment import instead of racing its write", async t => {
  const { core, project } = await fixture(t);
  const initial = await preview(core, project);
  const importing = core.request({ type: "file.import", projectId: project.id, name: "pending.txt", base64: Buffer.from("input").toString("base64") });
  await assert.rejects(core.request({ type: "project.reset", projectId: project.id, revision: initial.revision }), /正在提交/);
  await importing;
  assert.equal(await readFile(path.join(project.root, "inputs", "pending.txt"), "utf8"), "input");
});

test("semantic visual creation registers the exact files offered for reset deletion", async t => {
  const { core, project } = await fixture(t);
  const { createVisualAsset } = await moduleFor("packages/visualization/store.ts");
  const asset = await createVisualAsset(project.root, {
    library: "paper", purpose: "fixture chart", sourcePaths: ["inputs/原题.txt"],
    figure: { version: 1, kind: "grouped-bar", title: "Example", categories: ["A"], series: [{ id: "series", label: "Test", color: "#3366CC", values: [2] }] },
  });
  const initial = await preview(core, project);
  assert.equal(initial.generatedFiles.length, 5);
  assert.ok(initial.generatedFiles.some(file => file.path === asset.imagePath));
  await reset(core, project, { deleteGenerated: true, confirmationName: project.name });
  for (const file of initial.generatedFiles) await assert.rejects(stat(path.join(project.root, file.path)), { code: "ENOENT" });
  assert.ok(await stat(path.join(project.root, "inputs", "原题.txt")));
});

for (const committed of [false, true]) test(`startup recovers a reset interrupted ${committed ? "after" : "before"} SQL commit`, async t => {
  const { core, dir, project, thread } = await fixture(t);
  seed(dir, project, thread);
  await core.close();
  const id = randomUUID();
  const stage = path.join(project.root, ".nexiom", `.reset-${id}`);
  await mkdir(stage);
  await mkdir(path.join(dir, "reset-journals"));
  const files = [".nexiom/project.json", ".nexiom/MEMORY.md"];
  await writeFile(path.join(dir, "reset-journals", `${id}.json`), JSON.stringify({ id, projectId: project.id, root: project.root, files }));
  for (const [index, file] of files.entries()) await rename(path.join(project.root, file), path.join(stage, String(index)));
  const record = JSON.parse(await readFile(path.join(stage, "0"), "utf8"));
  for (const key of Object.keys(record.records)) record.records[key] = [];
  await writeFile(path.join(project.root, ".nexiom", "project.json"), JSON.stringify(record));
  if (committed) {
    const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
    deleteProjectContents(db, project.id);
    db.prepare("INSERT INTO settings VALUES (?, ?)").run(`project-reset:${id}`, project.id);
    db.close();
  }
  const reopened = new service.CoreService(dir);
  try {
    assert.equal(reopened.snapshot().snapshot.threads.some(row => row.id === thread.id), !committed);
    assert.equal((await reopened.request({ type: "memory.read", projectId: project.id })).memory.text, committed ? "" : "Old project assumptions");
    await assert.rejects(stat(stage), { code: "ENOENT" });
  } finally { await reopened.close(); }
});

test("cache clearing counts removed bytes, leaves sessions and project data untouched and does not traverse junctions", async t => {
  const { core, dir, project } = await fixture(t);
  const cache = path.join(dir, "runtime", "home", ".cache");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "cache.bin"), "12345");
  const sessions = path.join(dir, "runtime", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, "history.jsonl"), "must remain");
  await symlink(project.root, path.join(cache, "linked-project"), "junction");
  const response = await core.request({ type: "storage.clear" });
  assert.equal(response.cleanup.freedBytes, 5);
  assert.equal(response.cleanup.skippedFiles, 1);
  assert.equal(await readFile(path.join(sessions, "history.jsonl"), "utf8"), "must remain");
  assert.equal(await readFile(path.join(project.root, "inputs", "原题.txt"), "utf8"), "original problem");
});

test("old log cleanup preserves current and recent logs", async t => {
  const { dir } = await fixture(t);
  await mkdir(path.join(dir, "logs"));
  await writeFile(path.join(dir, "logs", "startup.log"), "active");
  const previous = path.join(dir, "logs", "startup.log.previous");
  await writeFile(previous, "old");
  const locations = [{ id: "logs", label: "logs", relative: "logs/startup.log.previous", olderThan: Date.now() - 7 * 86400000 }];
  assert.equal(cleanStorage(dir, locations, true).cleanup.freedBytes, 0);
  const old = new Date(Date.now() - 8 * 86400000);
  await utimes(previous, old, old);
  assert.equal(cleanStorage(dir, locations, true).cleanup.freedBytes, 3);
  assert.equal(await readFile(path.join(dir, "logs", "startup.log"), "utf8"), "active");
});
