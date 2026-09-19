import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["packages/visualization/store.ts"], bundle: true, platform: "node", format: "esm", write: false, target: "node24", minify: false });
const store = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const execFileAsync = promisify(execFile);

async function fixture(t) {
  const project = await mkdtemp(path.join(os.tmpdir(), "nexiom-visual-workspace-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(path.join(project, "model-results.csv"), "condition,A,B,C\nD,7,5,4\nE,4,8,5\nF,5,3,9\n");
  return project;
}

function figure() {
  return {
    version: 1, kind: "grouped-bar", title: "Survival by condition", categories: ["D", "E", "F"],
    xLabel: "Condition", yLabel: "Survival",
    series: [
      { id: "A", label: "A", color: "#CC3344", values: [7, 4, 5] },
      { id: "B", label: "B", color: "#DDAA22", values: [5, 8, 3] },
      { id: "C", label: "C", color: "#3366CC", values: [4, 5, 9] },
    ],
  };
}

async function create(project, options = {}) {
  return store.createVisualAsset(project, { library: "modeling", figure: figure(), purpose: "Compare modeled survival across conditions", sourcePaths: ["model-results.csv"], ...options });
}

function edited(asset) {
  const changed = structuredClone(asset.figure);
  changed.series[0].color = "#267F65";
  changed.layout.legend = { ...changed.layout.legend, x: 0.6, y: 0.08 };
  return changed;
}

test("listing a project is read-only; the Agent explicitly creates both visualization libraries", async t => {
  const project = await fixture(t);
  const empty = await store.listVisualWorkspace(project);
  assert.equal(empty.root, "outputs/visual-design");
  assert.equal(empty.libraries.length, 2);
  assert.ok(empty.libraries.every(library => !library.exists));
  assert.deepEqual(empty.assets, []);
  await assert.rejects(stat(path.join(project, "outputs")), { code: "ENOENT" });
  const initialized = await store.ensureVisualLibraries(project);
  assert.ok(initialized.libraries.every(library => library.exists));
  for (const library of initialized.libraries) assert.ok((await stat(path.join(project, library.path))).isDirectory());
  assert.deepEqual((await store.ensureVisualLibraries(project)).assets, []);
});

test("Agent creation persists semantic elements and a portable source; save recolors series and moves its legend", async t => {
  const project = await fixture(t);
  const created = await create(project);
  assert.equal(created.origin, "agent");
  assert.equal(created.revision, 1);
  assert.ok(created.elements.some(element => element.id === "series:A" && element.label === "A"));
  assert.match(created.sourcePath, /^outputs\/visual-design\/modeling\/.+\/rev-1\/render\.mjs$/);
  assert.ok((await store.listVisualWorkspace(project)).libraries.every(library => library.exists));
  const updated = await store.saveVisualAsset(project, { library: "modeling", id: created.id, expectedRevision: 1, figure: edited(created) });
  assert.equal(updated.revision, 2);
  assert.equal(updated.figure.series[0].color, "#267F65");
  assert.equal(updated.figure.layout.legend.x, 0.6);
  assert.ok(updated.svg.includes("#267F65"));
  assert.notEqual(created.svg, updated.svg);
  assert.notEqual(created.elements.find(element => element.id === "legend").bounds.x, updated.elements.find(element => element.id === "legend").bounds.x);
  assert.match(await readFile(path.join(project, updated.sourcePath), "utf8"), /#267F65/);
  assert.equal(await readFile(path.join(project, created.imagePath), "utf8"), created.svg, "old snapshots remain intact");
  assert.deepEqual(await store.readVisualAsset(project, "modeling", created.id), updated);
  const regenerated = path.join(project, "regenerated.svg");
  await execFileAsync(process.execPath, [path.join(project, updated.sourcePath), regenerated]);
  assert.equal(await readFile(regenerated, "utf8"), updated.svg, "saved source runs independently and reproduces the saved image");
  const workspace = await store.listVisualWorkspace(project);
  assert.equal(workspace.assets[0].revision, 2);
  assert.equal(workspace.assets[0].title, created.title);
});

test("paper and modeling assets remain in separate sibling libraries", async t => {
  const project = await fixture(t);
  await create(project);
  const paper = await create(project, { library: "paper", sourcePaths: [path.join(project, "model-results.csv")] });
  assert.deepEqual(paper.sourcePaths, ["model-results.csv"]);
  assert.match(paper.imagePath, /^outputs\/visual-design\/paper\//);
  assert.equal((await store.listVisualWorkspace(project)).assets.length, 2);
  await assert.rejects(store.readVisualAsset(project, "modeling", paper.id), /注册|不存在/);
});

test("renderer upgrades can reopen previous snapshots without rewriting source or stored SVG", async t => {
  const project = await fixture(t);
  const asset = await create(project);
  const oldSvg = asset.svg.replace('role="img"', 'role="img" data-renderer-version="previous"');
  await writeFile(path.join(project, asset.imagePath), oldSvg);
  const sourceBefore = await readFile(path.join(project, asset.sourcePath), "utf8");
  const documentBefore = await readFile(path.join(project, asset.documentPath), "utf8");
  const filesBefore = await readdir(path.join(project, "outputs"), { recursive: true });
  const reopened = await store.readVisualAsset(project, "modeling", asset.id);
  assert.deepEqual(reopened, asset, "the workbench receives current rendering from the validated semantic figure");
  assert.equal(reopened.revision, 1);
  assert.equal(await readFile(path.join(project, asset.imagePath), "utf8"), oldSvg, "reading preserves the original exported image");
  assert.equal(await readFile(path.join(project, asset.sourcePath), "utf8"), sourceBefore);
  assert.equal(await readFile(path.join(project, asset.documentPath), "utf8"), documentBefore);
  assert.deepEqual(await readdir(path.join(project, "outputs"), { recursive: true }), filesBefore);
  const saved = await store.saveVisualAsset(project, { library: "modeling", id: asset.id, expectedRevision: 1, figure: edited(asset) });
  assert.equal(saved.revision, 2);
  assert.equal(await readFile(path.join(project, asset.imagePath), "utf8"), oldSvg);
  assert.equal(await readFile(path.join(project, saved.imagePath), "utf8"), saved.svg);
});

test("concurrent saves cannot overwrite the same expected revision", async t => {
  const project = await fixture(t);
  const asset = await create(project);
  const payload = { library: "modeling", id: asset.id, expectedRevision: asset.revision, figure: edited(asset) };
  const results = await Promise.allSettled([store.saveVisualAsset(project, payload), store.saveVisualAsset(project, payload)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /版本冲突/);
  assert.equal((await store.readVisualAsset(project, "modeling", asset.id)).revision, 2);
  await assert.rejects(store.saveVisualAsset(project, payload), /版本冲突/);
});

test("workbench edits cannot change chart data, text, identities, or chart kind", async t => {
  const project = await fixture(t);
  const asset = await create(project);
  const mutations = [
    value => { value.series[0].values[0] = 999; },
    value => { value.series[0].label = "Somebody else"; },
    value => { value.series[0].id = "other"; },
    value => { value.title = "Changed argument"; },
    value => { value.categories[0] = "Other condition"; },
    value => { value.kind = "line"; },
    value => { value.series.reverse(); },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(asset.figure);
    mutate(candidate);
    assert.throws(() => store.validateVisualEdit(asset.figure, candidate), /只能调整配色/);
    await assert.rejects(store.saveVisualAsset(project, { library: "modeling", id: asset.id, expectedRevision: 1, figure: candidate }), /只能调整配色/);
  }
  assert.equal((await store.readVisualAsset(project, "modeling", asset.id)).revision, 1);
});

test("diagram presentation edits preserve node text and graph relationships", async t => {
  const project = await fixture(t);
  const asset = await create(project, { figure: { version: 1, kind: "diagram", title: "Model flow", nodes: [
    { id: "input", label: "Inputs", x: 0.1, y: 0.3, color: "#337788" },
    { id: "output", label: "Outputs", x: 0.7, y: 0.3, color: "#889933" },
  ], edges: [{ id: "flow", from: "input", to: "output" }], annotations: [{ id: "note", text: "Estimated", x: 0.2, y: 0.7 }] } });
  const candidate = structuredClone(asset.figure);
  candidate.nodes[0].x = 0.2;
  candidate.nodes[0].color = "#267F65";
  candidate.edges[0].color = "#990033";
  candidate.annotations[0].x = 0.4;
  candidate.annotations[0].color = "#003399";
  const updated = await store.saveVisualAsset(project, { library: "modeling", id: asset.id, expectedRevision: 1, figure: candidate });
  assert.equal(updated.figure.nodes[0].x, 0.2);
  candidate.edges[0].from = "output";
  assert.throws(() => store.validateVisualEdit(asset.figure, candidate), /只能调整配色/);
});

test("failed snapshot writes leave the previous revision readable and permit retry", async t => {
  const project = await fixture(t);
  const asset = await create(project);
  const blockedRevision = path.join(project, path.dirname(path.dirname(asset.imagePath)), "rev-2");
  await writeFile(blockedRevision, "Reserved externally");
  const request = { library: "modeling", id: asset.id, expectedRevision: 1, figure: edited(asset) };
  await assert.rejects(store.saveVisualAsset(project, request), /修订目录已存在/);
  assert.deepEqual(await store.readVisualAsset(project, "modeling", asset.id), asset);
  assert.ok((await readdir(path.dirname(blockedRevision))).every(name => !name.startsWith(".pending-") && !name.startsWith(".current-")));
  await rm(blockedRevision);
  assert.equal((await store.saveVisualAsset(project, request)).revision, 2);
});

test("ordinary images, hidden assets, and non-Agent documents never enter the workspace", async t => {
  const project = await fixture(t);
  const unknownId = randomUUID();
  await assert.rejects(store.saveVisualAsset(project, { library: "modeling", id: unknownId, expectedRevision: 1, figure: figure() }), /注册/);
  await assert.rejects(stat(path.join(project, "outputs")), { code: "ENOENT" });
  await store.ensureVisualLibraries(project);
  const library = path.join(project, "outputs/visual-design/modeling");
  await writeFile(path.join(library, "local.png"), "not an Agent chart");
  await mkdir(path.join(library, ".runtime"));
  await assert.rejects(store.readVisualAsset(project, "modeling", unknownId), /注册|不存在/);
  assert.deepEqual((await store.listVisualWorkspace(project)).assets, []);
  const asset = await create(project);
  const metadataPath = path.join(project, path.dirname(asset.documentPath), "meta.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.origin = "local-upload";
  await writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(store.readVisualAsset(project, "modeling", asset.id));
  const state = await store.listVisualWorkspace(project);
  assert.deepEqual(state.assets, []);
  assert.equal(state.warnings.length, 1);
});

test("source evidence must reference actual project files and structured chart data must be valid", async t => {
  const project = await fixture(t);
  await mkdir(path.join(project, ".nexiom"));
  await writeFile(path.join(project, ".nexiom", "private.json"), "{}");
  for (const sourcePaths of [[], ["missing.csv"], ["../outside.csv"], [".nexiom/private.json"], ["."]]) {
    await assert.rejects(create(project, { sourcePaths }));
  }
  await assert.rejects(create(project, { figure: { ...figure(), categories: ["D"] } }));
  await assert.rejects(create(project, { figure: { ...figure(), series: [{ ...figure().series[0], color: "red" }] } }));
  await assert.rejects(store.readVisualAsset(project, "../paper", randomUUID()));
  await assert.rejects(store.readVisualAsset(project, "modeling", "../../outside"));
  await assert.rejects(stat(path.join(project, "outputs")), { code: "ENOENT" });
});

test("directory junctions cannot redirect library writes or source references outside the project", async t => {
  const project = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "nexiom-visual-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.csv"), "private");
  await symlink(outside, path.join(project, "linked-data"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(create(project, { sourcePaths: ["linked-data/secret.csv"] }), /符号链接|目录联接/);
  await symlink(outside, path.join(project, "outputs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.ensureVisualLibraries(project), /符号链接|目录联接/);
  await assert.rejects(create(project), /符号链接|目录联接/);
  const state = await store.listVisualWorkspace(project);
  assert.equal(state.assets.length, 0);
  assert.ok(state.warnings.length > 0);
  assert.deepEqual(await readdir(outside), ["secret.csv"]);
});
