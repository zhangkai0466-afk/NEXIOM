import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import service from "../.build/service.cjs";

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-unimport-"));
  const core = new service.CoreService(dir);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const { project, thread } = await core.request({ type: "project.create", name: "赛题移除验证" });
  const payload = { type: "file.import", projectId: project.id, name: "C题.pdf", base64: Buffer.from("%PDF-1.4\noriginal").toString("base64") };
  await core.request(payload);
  const remove = (file = "inputs/C题.pdf") => core.request({ type: "file.unimport", projectId: project.id, path: file });
  return { core, dir, project, thread, payload, remove };
}

test("removing a problem PDF preserves its source and backup, and permits same-name reimport", async t => {
  const { core, dir, project, payload, remove } = await setup(t);
  const original = path.join(dir, "C题.pdf");
  const bytes = Buffer.from(payload.base64, "base64");
  await writeFile(original, bytes);
  await core.request({ ...payload, name: "保留.pdf" });
  await remove();
  const { files } = await core.request({ type: "project.files", projectId: project.id });
  assert.equal(files.some(file => file.path === "inputs/C题.pdf"), false);
  assert.equal(files.some(file => file.path === "inputs/保留.pdf"), true);
  assert.equal(files.some(file => file.path.includes("removed-inputs")), false);
  assert.deepEqual(await readFile(original), bytes);
  const backup = path.join(project.root, ".nexiom/removed-inputs");
  const entries = await readdir(backup);
  assert.equal(entries.length, 1);
  assert.deepEqual(await readFile(path.join(backup, entries[0], "C题.pdf")), bytes);
  await assert.rejects(core.request({ type: "file.read", projectId: project.id, path: "inputs/C题.pdf" }));
  await core.request({ ...payload, base64: Buffer.from("%PDF-1.4\nreplacement").toString("base64") });
  assert.equal(await readFile(path.join(project.root, "inputs/C题.pdf"), "utf8"), "%PDF-1.4\nreplacement");
});

test("unimport rejects traversal, directories and linked source or backup directories", async t => {
  const { dir, project, remove } = await setup(t);
  for (const relative of ["C题.pdf", "inputs/../C题.pdf", "inputs/../../outside.pdf", "inputs", ".nexiom/MEMORY.md"])
    await assert.rejects(remove(relative), /只能移除 inputs/);
  await mkdir(path.join(project.root, "inputs/folder"));
  await assert.rejects(remove("inputs/folder"), /只能移除文件/);
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "C题.pdf"), "outside");
  await symlink(outside, path.join(project.root, "inputs/linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(remove("inputs/linked/C题.pdf"), /符号链接或目录联接/);
  await symlink(outside, path.join(project.root, ".nexiom/removed-inputs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(remove(), /符号链接或目录联接/);
  assert.equal(await readFile(path.join(outside, "C题.pdf"), "utf8"), "outside");
  assert.ok((await readFile(path.join(project.root, "inputs/C题.pdf"), "utf8")).includes("original"));
});

test("unimport leaves materials intact while the project has an active run", async t => {
  const { dir, project, thread, remove } = await setup(t);
  const db = new DatabaseSync(path.join(dir, "workspace.sqlite"));
  const id = randomUUID();
  try {
    db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'running', ?, NULL)").run(id, thread.id, project.id, new Date().toISOString());
    await assert.rejects(remove(), /仍有任务或文件操作/);
    assert.ok((await readFile(path.join(project.root, "inputs/C题.pdf"), "utf8")).includes("original"));
  } finally {
    db.prepare("DELETE FROM runs WHERE id=?").run(id);
    db.close();
  }
});
