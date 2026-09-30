import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import service from "../.build/service.cjs";

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-pdf-save-"));
  const core = new service.CoreService(dir);
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  const { project } = await core.request({ type: "project.create", name: "PDF 修改验证" });
  await core.request({ type: "file.import", projectId: project.id, name: "题目.pdf", base64: Buffer.from("%PDF-1.4\noriginal").toString("base64") });
  const save = (contents, file = "inputs/题目.pdf") => core.request({ type: "pdf.save", projectId: project.id, path: file, base64: Buffer.from(contents).toString("base64") });
  return { dir, core, project, save };
}

test("PDF saves replace the current document and subsequent reads see added and removed annotations", async t => {
  const { core, project, save } = await setup(t);
  for (const contents of ["%PDF-1.4\nhighlight added", "%PDF-1.4\nhighlight removed"]) {
    assert.equal((await save(contents)).savedPath, "inputs/题目.pdf");
    const { file } = await core.request({ type: "file.read", projectId: project.id, path: "inputs/题目.pdf" });
    assert.equal(Buffer.from(file.base64, "base64").toString(), contents);
  }
  assert.deepEqual(await readdir(path.join(project.root, "inputs")), ["题目.pdf"]);
  await assert.rejects(readdir(path.join(project.root, "reading/annotations")), { code: "ENOENT" });
});

test("PDF save identifies the source by its full path, not its filename", async t => {
  const { project, save } = await setup(t);
  await mkdir(path.join(project.root, "outputs"));
  await writeFile(path.join(project.root, "outputs/题目.pdf"), "%PDF-1.4\nother");
  await save("%PDF-1.4\nedited");
  assert.equal(await readFile(path.join(project.root, "outputs/题目.pdf"), "utf8"), "%PDF-1.4\nother");
});

test("PDF save rejects invalid content, missing files, non-PDF targets and escaping paths", async t => {
  const { dir, project, save } = await setup(t);
  await writeFile(path.join(project.root, "inputs/notes.txt"), "keep");
  for (const file of ["inputs/missing.pdf", "inputs/notes.txt", "../outside.pdf", "inputs"])
    await assert.rejects(save("%PDF-1.4\nreplacement", file));
  await assert.rejects(save("not a PDF"));
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "题目.pdf"), "%PDF-1.4\noutside");
  await symlink(outside, path.join(project.root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(save("%PDF-1.4\nreplacement", "linked/题目.pdf"));
  assert.equal(await readFile(path.join(outside, "题目.pdf"), "utf8"), "%PDF-1.4\noutside");
  assert.equal(await readFile(path.join(project.root, "inputs/题目.pdf"), "utf8"), "%PDF-1.4\noriginal");
});
