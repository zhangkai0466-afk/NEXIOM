import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import service from "../.build/service.cjs";

test("imported visualization catalog, gallery and path boundaries", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "nexiom-visual-library-"));
  const core = new service.CoreService(path.join(temporary, "state"));
  const previous = process.env.NEXIOM_VISUAL_BUNDLE_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.NEXIOM_VISUAL_BUNDLE_ROOT;
    else process.env.NEXIOM_VISUAL_BUNDLE_ROOT = previous;
    await core.close();
    await rm(temporary, { recursive: true, force: true });
  });
  delete process.env.NEXIOM_VISUAL_BUNDLE_ROOT;
  const raw = JSON.parse(await readFile("packages/visualization-engine/catalog.json", "utf8"));
  const { visualCatalog: catalog } = await core.request({ type: "visual.catalog" });
  assert.equal(catalog.counts.templates, 62);
  assert.equal(catalog.counts.palettes, 17);
  assert.equal(catalog.counts.grammar, 308);
  assert.equal(catalog.counts.references, raw.references.length + raw.previews.length);
  assert.equal(catalog.grammar.filter(item => item.status === "executable").length, 62);
  assert.equal(new Set(catalog.references.map(item => item.id)).size, catalog.references.length);
  assert.ok(catalog.templates.every(item => item.name && item.requiredColumns.length));
  assert.ok(catalog.palettes.every(item => item.colors.length));
  for (const item of [...raw.references, ...raw.previews])
    await access(path.join("packages/visualization-engine", item.imagePath));
  for (const tag of ["参考原图", "模板预览"]) {
    const entry = catalog.references.find(item => item.tags.includes(tag));
    assert.ok(entry?.assetId);
    const { file } = await core.request({ type: "visual.asset", assetId: entry.assetId });
    assert.equal(file.mime, "image/png");
    assert.equal(Buffer.from(file.base64, "base64").subarray(1, 4).toString(), "PNG");
  }
  await assert.rejects(core.request({ type: "visual.asset", assetId: "../../package.json" }), /没有这张图片/);
  assert.equal(core.snapshot().snapshot.projects.length, 0, "browsing must not create project or thread records");

  const fixture = path.join(temporary, "malformed-bundle");
  await mkdir(fixture);
  await writeFile(path.join(temporary, "outside.png"), "must not be read");
  await writeFile(path.join(fixture, "catalog.json"), JSON.stringify({
    templates: [], palettes: [], references: [{ id: "escape", imagePath: "../outside.png" }],
  }));
  process.env.NEXIOM_VISUAL_BUNDLE_ROOT = fixture;
  await assert.rejects(core.request({ type: "visual.asset", assetId: "escape" }), /路径无效/);
  process.env.NEXIOM_VISUAL_BUNDLE_ROOT = path.join(temporary, "missing-bundle");
  await assert.rejects(core.request({ type: "visual.catalog" }), /尚未导入/);
});

test("image recolor reads project images and exports collision-safe PNG files", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "nexiom-recolor-"));
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  const core = new service.CoreService(path.join(temporary, "state"));
  t.after(async () => {
    await core.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const opened = await core.openProject(workspace);
  const projectId = opened.project.id;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Z8xZ5QAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(path.join(workspace, "source.png"), png);

  const loaded = await core.request({
    type: "visual.image.read",
    projectId,
    path: "source.png",
  });
  assert.equal(loaded.file.mime, "image/png");
  assert.deepEqual(Buffer.from(loaded.file.base64, "base64"), png);

  const first = await core.request({
    type: "visual.image.save",
    projectId,
    name: "结果图.jpg",
    base64: png.toString("base64"),
  });
  const second = await core.request({
    type: "visual.image.save",
    projectId,
    name: "结果图.jpg",
    base64: png.toString("base64"),
  });
  assert.equal(first.savedPath, "outputs/visual-design/edits/结果图.png");
  assert.equal(second.savedPath, "outputs/visual-design/edits/结果图-2.png");
  assert.deepEqual(await readFile(path.join(workspace, ...first.savedPath.split("/"))), png);
  assert.deepEqual(await readFile(path.join(workspace, ...second.savedPath.split("/"))), png);
  assert.ok(core.snapshot().snapshot.events.some((event) => event.type === "visual.image.saved"));

  await assert.rejects(core.request({
    type: "visual.image.save",
    projectId,
    name: "../escape.png",
    base64: png.toString("base64"),
  }), /文件名无效/);
  await assert.rejects(core.request({
    type: "visual.image.save",
    projectId,
    name: "bad.png",
    base64: Buffer.from("not a png").toString("base64"),
  }), /不是有效的 PNG/);
  await assert.rejects(core.request({
    type: "visual.image.read",
    projectId,
    path: "missing.png",
  }), /ENOENT/);
});
