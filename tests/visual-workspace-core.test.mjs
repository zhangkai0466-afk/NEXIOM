import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import service from "../.build/service.cjs";

const compiled = await build({ entryPoints: ["packages/visualization/store.ts"], bundle: true, platform: "node", format: "esm", write: false, target: "node24" });
const store = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function chart() {
  return {
    version: 1, kind: "grouped-bar", title: "Survival in D, E and F", categories: ["D", "E", "F"],
    xLabel: "Conditions", yLabel: "Survival",
    series: [
      { id: "A", label: "Member A", color: "#CC3344", values: [7, 4, 5] },
      { id: "B", label: "Member B", color: "#DDAA22", values: [5, 8, 3] },
      { id: "C", label: "Member C", color: "#3366CC", values: [4, 5, 9] },
    ],
  };
}

async function setup(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "nexiom-visual-core-"));
  const workspace = path.join(temporary, "project");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "results.csv"), "condition,A,B,C\nD,7,5,4\nE,4,8,5\nF,5,3,9\n");
  await writeFile(path.join(workspace, "argument.md"), "The discussion compares survival across the modeled conditions.\n");
  const core = new service.CoreService(path.join(temporary, "state"));
  t.after(async () => { await core.close(); await rm(temporary, { recursive: true, force: true }); });
  const { project } = await core.openProject(workspace);
  return { core, workspace, projectId: project.id };
}

async function assets(workspace) {
  const modeling = await store.createVisualAsset(workspace, { library: "modeling", title: "Model comparison", figure: chart(), purpose: "Compare computed survival", sourcePaths: ["results.csv"] });
  const paper = await store.createVisualAsset(workspace, { library: "paper", title: "Paper argument", purpose: "Explain the argument in the discussion", sourcePaths: ["argument.md"], figure: {
    version: 1, kind: "diagram", title: "Evidence to conclusion", nodes: [
      { id: "evidence", label: "Model evidence", x: 0.12, y: 0.4, color: "#337788" },
      { id: "conclusion", label: "Discussion", x: 0.65, y: 0.4, color: "#779944" },
    ], edges: [{ id: "argument", from: "evidence", to: "conclusion", label: "supports" }],
  } });
  return { modeling, paper };
}

async function snapshotFiles(directory) {
  const files = {};
  async function visit(relative) {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files[child] = createHash("sha256").update(await readFile(path.join(directory, child))).digest("hex");
    }
  }
  await visit("");
  return files;
}

test("Core workspace presents both Agent libraries together and excludes ordinary local images", async t => {
  const { core, workspace, projectId } = await setup(t);
  const empty = await core.request({ type: "visual.workspace", projectId });
  assert.deepEqual(empty.visualWorkspace.assets, []);
  await assert.rejects(stat(path.join(workspace, "outputs")), { code: "ENOENT" }, "opening the workspace must not create libraries");
  const { modeling, paper } = await assets(workspace);
  await writeFile(path.join(workspace, "local.png"), "ordinary local image");
  await writeFile(path.join(workspace, "outputs/visual-design/modeling/reference.png"), "ordinary reference image");
  await mkdir(path.join(workspace, "outputs/visual-design/edits"));
  await writeFile(path.join(workspace, "outputs/visual-design/edits/old-recolor.png"), "old raster export");
  const listed = await core.request({ type: "visual.workspace", projectId });
  assert.deepEqual(new Set(listed.visualWorkspace.assets.map(asset => asset.id)), new Set([modeling.id, paper.id]));
  assert.deepEqual(new Set(listed.visualWorkspace.assets.map(asset => asset.library)), new Set(["modeling", "paper"]));
  for (const expected of [modeling, paper]) {
    const { visualFigure } = await core.request({ type: "visual.figure.read", projectId, library: expected.library, id: expected.id });
    assert.equal(visualFigure.id, expected.id);
    assert.equal(visualFigure.origin, "agent");
    assert.equal(visualFigure.svg, expected.svg);
    assert.deepEqual(visualFigure.figure, expected.figure);
  }
  await assert.rejects(core.request({ type: "visual.figure.read", projectId, library: "modeling", id: paper.id }), /注册|不存在/);
});

test("Core previews recoloring and structural movement without writing files or advancing revisions", async t => {
  const { core, workspace, projectId } = await setup(t);
  const { modeling, paper } = await assets(workspace);
  const before = await snapshotFiles(path.join(workspace, "outputs"));
  const proposed = structuredClone(modeling.figure);
  proposed.series[0].color = "#268F65";
  proposed.layout.legend.x = 0.54;
  proposed.layout.legend.y = 0.06;
  const { visualPreview } = await core.request({ type: "visual.figure.preview", projectId, library: modeling.library, id: modeling.id, figure: proposed });
  assert.ok(visualPreview.svg.includes("#268F65"));
  assert.notEqual(visualPreview.svg, modeling.svg);
  assert.notDeepEqual(visualPreview.elements.find(element => element.id === "legend").bounds, modeling.elements.find(element => element.id === "legend").bounds);
  const paperEdit = structuredClone(paper.figure);
  paperEdit.nodes[0].x = 0.22;
  paperEdit.nodes[0].color = "#BB4466";
  const paperPreview = await core.request({ type: "visual.figure.preview", projectId, library: paper.library, id: paper.id, figure: paperEdit });
  assert.ok(paperPreview.visualPreview.svg.includes("#BB4466"));
  assert.deepEqual(await snapshotFiles(path.join(workspace, "outputs")), before);
  const { visualFigure } = await core.request({ type: "visual.figure.read", projectId, library: modeling.library, id: modeling.id });
  assert.equal(visualFigure.revision, 1);
  assert.equal(visualFigure.svg, modeling.svg);
});

test("Core saves semantic color and layout edits while preserving data and rejecting stale revisions", async t => {
  const { core, workspace, projectId } = await setup(t);
  const { modeling } = await assets(workspace);
  const proposed = structuredClone(modeling.figure);
  proposed.series[1].color = "#B35587";
  proposed.layout.legend.x = 0.55;
  proposed.layout.legend.y = 0.05;
  const request = { type: "visual.figure.save", projectId, library: modeling.library, id: modeling.id, expectedRevision: 1, figure: proposed };
  const { visualFigure, savedPath } = await core.request(request);
  assert.equal(visualFigure.revision, 2);
  assert.equal(savedPath, visualFigure.imagePath);
  assert.equal(visualFigure.figure.series[1].color, "#B35587");
  assert.equal(visualFigure.figure.layout.legend.x, 0.55);
  assert.equal(visualFigure.figure.layout.legend.y, 0.05);
  assert.deepEqual(visualFigure.figure.categories, modeling.figure.categories);
  assert.deepEqual(visualFigure.figure.series.map(({ color, ...series }) => series), modeling.figure.series.map(({ color, ...series }) => series));
  assert.equal(await readFile(path.join(workspace, modeling.imagePath), "utf8"), modeling.svg);
  const source = await readFile(path.join(workspace, visualFigure.sourcePath), "utf8");
  assert.ok(source.includes("#B35587"));
  assert.ok(source.includes('"x": 0.55'));
  await assert.rejects(core.request(request), /版本冲突/);
  const reopened = await core.request({ type: "visual.figure.read", projectId, library: modeling.library, id: modeling.id });
  assert.deepEqual(reopened.visualFigure, visualFigure);
  assert.equal(core.snapshot().snapshot.events.filter(event => event.type === "visual.figure.saved").length, 1);
});

test("Core preview and save both reject data edits and unregistered assets", async t => {
  const { core, workspace, projectId } = await setup(t);
  const { modeling } = await assets(workspace);
  const before = await snapshotFiles(path.join(workspace, "outputs"));
  const tampered = structuredClone(modeling.figure);
  tampered.series[0].values[0] = 900;
  for (const type of ["visual.figure.preview", "visual.figure.save"]) {
    await assert.rejects(core.request({ type, projectId, library: modeling.library, id: modeling.id, expectedRevision: 1, figure: tampered }), /只能调整配色/);
    await assert.rejects(core.request({ type, projectId, library: "modeling", id: randomUUID(), expectedRevision: 1, figure: modeling.figure }), /注册|不存在/);
  }
  await assert.rejects(core.request({ type: "visual.figure.read", projectId, library: "../paper", id: modeling.id }));
  assert.deepEqual(await snapshotFiles(path.join(workspace, "outputs")), before);
});
