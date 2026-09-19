import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { transform } from "esbuild";

const compiled = await transform(await readFile("packages/visualization/render.ts", "utf8"), { loader: "ts", format: "esm", target: "es2023" });
const { renderVisualFigure, generateVisualSource } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);
const figure = () => ({
  version: 1, kind: "grouped-bar", title: "不同情况下的生存能力", width: 960, height: 640,
  xLabel: "情况", yLabel: "生存能力", categories: ["D", "E", "F"],
  series: [
    { id: "a", label: "A", color: "#EE3333", values: [10, 18, 14], points: [] },
    { id: "b", label: "B", color: "#EEBB22", values: [15, 12, 22], points: [] },
    { id: "c", label: "C", color: "#2266EE", values: [20, 16, 12], points: [] },
  ],
  nodes: [], edges: [], annotations: [],
  layout: {
    plot: { x: 0.12, y: 0.18, width: 0.62, height: 0.66 },
    legend: { x: 0.78, y: 0.2, visible: true }, title: { x: 0.5, y: 0.075 },
    xLabel: { x: 0.43, y: 0.96 }, yLabel: { x: 0.035, y: 0.51 }, fontSize: 14,
  },
});
function group(svg, id) {
  const start = svg.indexOf(`<g data-element-id="${id}">`);
  assert.ok(start >= 0, `${id} exists`);
  const end = svg.indexOf('<g data-element-id="', start + 1);
  return svg.slice(start, end === -1 ? svg.length : end);
}

test("ABC / DEF grouped bars preserve semantic series and matching legend colors", () => {
  const input = figure();
  const { svg, elements } = renderVisualFigure(input);
  assert.equal((svg.match(/data-category=/g) || []).length, 9);
  for (const series of input.series) {
    assert.equal((group(svg, `series:${series.id}`).match(/data-category=/g) || []).length, 3);
    assert.ok(group(svg, `series:${series.id}`).includes(`fill="${series.color}"`));
    assert.match(group(svg, "legend"), new RegExp(`data-series-id="${series.id}"[^]*?fill="${series.color}"`));
    assert.equal(elements.find(element => element.id === `series:${series.id}`).movable, false);
  }
  const legend = elements.find(element => element.id === "legend");
  const plot = elements.find(element => element.id === "plot");
  assert.ok(legend.movable);
  assert.ok(legend.bounds.x >= plot.bounds.x + plot.bounds.width, "default legend sits in the right margin");
  assert.ok(legend.bounds.x + legend.bounds.width <= 1);
  assert.ok(legend.bounds.y + legend.bounds.height <= 1);
});

test("Cartesian plots retain a closed rectangular frame below data when moved or resized", () => {
  for (const kind of ["grouped-bar", "line", "scatter"]) {
    const input = figure();
    input.kind = kind;
    if (kind === "scatter") input.series.forEach(series => { series.points = [{ x: -2, y: 1 }, { x: 4, y: 3 }]; });
    for (const plot of [input.layout.plot, { x: 0.2, y: 0.25, width: 0.5, height: 0.5 }]) {
      input.layout.plot = plot;
      const { svg } = renderVisualFigure(input);
      const frames = [...svg.matchAll(/<rect\b[^>]*data-role="plot-frame"[^>]*\/>/g)];
      assert.equal(frames.length, 1, `${kind} has exactly one four-sided frame`);
      const frame = frames[0][0];
      for (const [attribute, expected] of Object.entries({ x: plot.x * input.width, y: plot.y * input.height, width: plot.width * input.width, height: plot.height * input.height })) {
        const value = frame.match(new RegExp(` ${attribute}="([\\d.]+)"`));
        assert.ok(value, `${attribute} is defined`);
        assert.ok(Math.abs(Number(value[1]) - expected) < 0.0001, `${attribute} follows the plot`);
      }
      assert.match(frame, /fill="none"/);
      assert.match(frame, /stroke="#[0-9a-fA-F]{6}" stroke-width="1"/);
      assert.ok(svg.indexOf(frame) < svg.indexOf('data-element-id="series:'), "the border never overlays data marks");
      assert.equal(group(svg, "plot").includes('data-element-id="series:'), false);
    }
  }
  const diagram = figure();
  diagram.kind = "diagram";
  assert.doesNotMatch(renderVisualFigure(diagram).svg, /data-role="plot-frame"/);
});

test("recoloring a named series changes only its marks and its legend swatch", () => {
  const input = figure();
  const before = renderVisualFigure(input);
  const revised = structuredClone(input);
  revised.series[1].color = "#A855F7";
  const after = renderVisualFigure(revised);
  assert.equal(after.svg, before.svg.replaceAll("#EEBB22", "#A855F7"));
  assert.deepEqual(revised.series.map(series => series.values), input.series.map(series => series.values));
  assert.equal(input.series[1].color, "#EEBB22");
});

test("moving the legend changes its bounds while preserving all data marks", () => {
  const input = figure();
  const before = renderVisualFigure(input);
  input.layout.legend = { x: 0.35, y: 0.35, visible: true };
  const after = renderVisualFigure(input);
  for (const series of input.series) assert.equal(group(before.svg, `series:${series.id}`), group(after.svg, `series:${series.id}`));
  assert.notDeepEqual(before.elements.find(element => element.id === "legend").bounds, after.elements.find(element => element.id === "legend").bounds);
});

test("hidden legends retain selectable metadata and restore with their series bindings", () => {
  const input = figure();
  const before = renderVisualFigure(input);
  input.layout.legend.visible = false;
  const hidden = renderVisualFigure(input);
  assert.deepEqual(hidden.elements.find(element => element.id === "legend"), before.elements.find(element => element.id === "legend"));
  assert.ok(!hidden.svg.includes('data-element-id="legend"'));
  assert.ok(!hidden.svg.includes('data-role="legend-swatch"'));
  input.layout.legend.visible = true;
  const restored = renderVisualFigure(input);
  assert.equal(restored.svg, before.svg);
  for (const series of input.series) assert.ok(group(restored.svg, "legend").includes(`data-series-id="${series.id}"`));
});

test("diagram connectors follow movable node geometry", () => {
  const input = figure();
  input.kind = "diagram";
  input.nodes = [
    { id: "input", label: "数据输入", x: 0.1, y: 0.3, width: 0.18, height: 0.1, color: "#2563EB" },
    { id: "model", label: "建立模型", x: 0.6, y: 0.3, width: 0.18, height: 0.1, color: "#059669" },
  ];
  input.edges = [{ id: "flow", from: "input", to: "model", color: "#64748B", label: "建模" }];
  const before = renderVisualFigure(input);
  input.nodes[1].y = 0.65;
  const after = renderVisualFigure(input);
  assert.notEqual(group(before.svg, "edge:flow"), group(after.svg, "edge:flow"));
  assert.notEqual(group(before.svg, "node:model"), group(after.svg, "node:model"));
  assert.equal(group(before.svg, "node:input"), group(after.svg, "node:input"));
  assert.ok(after.elements.find(element => element.id === "node:model").movable);
});

test("SVG text and attributes are escaped rather than interpreted as markup", () => {
  const input = figure();
  const hostile = '<script>alert("x")</script>&\'"';
  input.title = hostile;
  input.categories[0] = hostile;
  input.series[0].label = hostile;
  input.annotations.push({ id: "note", text: hostile, x: 0.1, y: 0.9, color: "#334155", fontSize: 14 });
  const { svg } = renderVisualFigure(input);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&apos;&quot;"));
  assert.ok(svg.includes('data-element-id="annotation:note"'));
});

test("negative bars, zero-only data, lines, and scatter use finite data coordinates", () => {
  const input = figure();
  input.series[0].values = [-10, 0, 10];
  for (const kind of ["grouped-bar", "line"]) {
    input.kind = kind;
    const { svg } = renderVisualFigure(input);
    assert.doesNotMatch(svg, /(?:NaN|Infinity)/);
    if (kind === "line") assert.equal((svg.match(/<polyline /g) || []).length, 3);
  }
  input.kind = "grouped-bar";
  input.series.forEach(series => { series.values = [0, 0, 0]; });
  assert.doesNotMatch(renderVisualFigure(input).svg, /(?:NaN|Infinity)/);
  input.kind = "scatter";
  input.series = [{ id: "xy", label: "坐标", color: "#2266EE", values: [], points: [{ x: -10, y: 5 }, { x: 0, y: 5 }, { x: 30, y: 5 }] }];
  const svg = renderVisualFigure(input).svg;
  const xs = [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map(match => Number(match[1]));
  assert.equal(xs.length, 3);
  assert.ok(Math.abs((xs[2] - xs[1]) / (xs[1] - xs[0]) - 3) < 0.001, "scatter spacing follows x values");
  assert.doesNotMatch(svg, /(?:NaN|Infinity)/);
});

test("many long legend entries remain inside the canvas", () => {
  const input = figure();
  input.width = 480;
  input.height = 320;
  input.series = Array.from({ length: 32 }, (_, index) => ({ id: `s${index}`, label: `长系列名称${index}`.repeat(8), color: "#2266EE", values: [1, 2, 3], points: [] }));
  const { svg, elements } = renderVisualFigure(input);
  const legend = elements.find(element => element.id === "legend");
  assert.ok(legend.bounds.x >= 0);
  assert.ok(legend.bounds.y >= 0);
  assert.ok(legend.bounds.x + legend.bounds.width <= 1);
  assert.ok(legend.bounds.y + legend.bounds.height <= 1);
  assert.equal((svg.match(/data-role="legend-swatch"/g) || []).length, 32);
});

test("small plots thin crowded category labels while preserving all bars", () => {
  const input = figure();
  input.width = 480;
  input.height = 320;
  input.layout.plot = { x: 0.12, y: 0.18, width: 0.1, height: 0.1 };
  input.layout.fontSize = 28;
  input.categories = Array.from({ length: 100 }, (_, index) => `类别${index}`);
  input.series.forEach(series => { series.values = input.categories.map((_, index) => index); });
  const { svg, elements } = renderVisualFigure(input);
  assert.equal((svg.match(/data-category=/g) || []).length, 300);
  assert.equal((svg.match(/data-role="category-tick"/g) || []).length, 1);
  assert.doesNotMatch(svg, /(?:NaN|Infinity)/);
  for (const element of elements) {
    for (const value of Object.values(element.bounds)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  }
});

test("portable source renders byte-identical SVG without repository dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nexiom-visual-render-"));
  try {
    const input = figure();
    input.series[0].color = "#46B79B";
    input.layout.legend.x = 0.32;
    const source = generateVisualSource(input);
    assert.ok(source.includes('"color": "#46B79B"'));
    assert.ok(!source.includes("packages/"));
    const sourcePath = join(directory, "render.mjs");
    const outputPath = join(directory, "output.svg");
    await writeFile(sourcePath, source);
    execFileSync(process.execPath, [sourcePath, outputPath], { cwd: directory });
    assert.equal(await readFile(outputPath, "utf8"), renderVisualFigure(input).svg);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
