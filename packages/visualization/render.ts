import type { VisualElement, VisualFigure } from "./document";

/** Keep this function self-contained: its JavaScript is also the portable source file. */
export function renderVisualFigure(figure: VisualFigure): { svg: string; elements: VisualElement[] } {
  const { width: w, height: h, layout } = figure;
  const fs = layout.fontSize;
  const elements: VisualElement[] = [];
  const body: string[] = [];
  const esc = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
  const n = (value: number) => Number(value.toFixed(4));
  const textWidth = (text: string, size: number) => Array.from(text).reduce((width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? size : size * 0.6), 0);
  const bounds = (x: number, y: number, width: number, height: number) => {
    const left = Math.max(0, Math.min(w, x));
    const top = Math.max(0, Math.min(h, y));
    return { x: left / w, y: top / h, width: Math.max(0, Math.min(w, x + width) - left) / w, height: Math.max(0, Math.min(h, y + height) - top) / h };
  };
  const add = (id: string, kind: VisualElement["kind"], label: string, movable: boolean, box: { x: number; y: number; width: number; height: number }, content: string, color?: string, visible = true) => {
    elements.push({ id, kind, label, movable, bounds: bounds(box.x, box.y, box.width, box.height), ...(color ? { color } : {}) });
    if (visible) body.push(`<g data-element-id="${esc(id)}">${content}</g>`);
  };
  const labelText = (x: number, y: number, text: string, size = fs, anchor = "middle", extra = "") => `<text x="${n(x)}" y="${n(y)}" font-size="${size}" text-anchor="${anchor}" ${extra}>${esc(text)}</text>`;
  const shortText = (value: string, width: number, size: number) => {
    if (width < textWidth("…", size)) return "";
    if (textWidth(value, size) <= width) return value;
    let result = "";
    for (const character of value) {
      if (textWidth(result + character + "…", size) > width) break;
      result += character;
    }
    return result + "…";
  };
  const spacedIndices = (count: number, available: number, minimumGap: number) => {
    const slots = Math.min(count, Math.max(1, Math.floor(available / minimumGap) + 1));
    return slots === 1 ? [Math.floor((count - 1) / 2)] : Array.from({ length: slots }, (_, index) => Math.round(index * (count - 1) / (slots - 1)));
  };
  const centeredLabel = (id: "title" | "xLabel" | "yLabel", value: string, size: number, rotated = false) => {
    if (!value) return;
    const x = layout[id].x * w, y = layout[id].y * h;
    const length = Math.min(textWidth(value, size), rotated ? h - 16 : w - 16);
    const text = shortText(value, length, size);
    add(id, id, value, true,
      rotated ? { x: x - size * 0.65, y: y - length / 2, width: size * 1.3, height: length } : { x: x - length / 2, y: y - size * 0.65, width: length, height: size * 1.3 },
      `<title>${esc(value)}</title>${labelText(x, y, text, size, "middle", `dominant-baseline="middle"${rotated ? ` transform="rotate(-90 ${n(x)} ${n(y)})"` : ""}${id === "title" ? ' font-weight="600"' : ""}`)}`);
  };
  const domain = (values: number[], includeZero: boolean) => {
    let minimum = includeZero ? 0 : Infinity, maximum = includeZero ? 0 : -Infinity;
    for (const value of values) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) { minimum = 0; maximum = 1; }
    if (minimum === maximum) {
      if (minimum === 0) maximum = 1;
      else { const padding = Math.max(Math.abs(minimum) * 0.2, 1e-12); minimum -= padding; maximum += padding; }
    }
    const span = maximum - minimum;
    if (Number.isFinite(span) && span > 0) {
      const roughStep = span / 5;
      const power = 10 ** Math.floor(Math.log10(roughStep));
      const unit = roughStep / power;
      const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
      const low = Math.floor(minimum / step) * step;
      const high = Math.ceil(maximum / step) * step;
      if (Number.isFinite(low) && Number.isFinite(high) && high > low) {
        const ticks = Array.from({ length: Math.min(12, Math.round((high - low) / step) + 1) }, (_, index) => low + index * step);
        return { minimum: low, maximum: high, ticks };
      }
    }
    return { minimum, maximum, ticks: Array.from({ length: 6 }, (_, index) => minimum * (1 - index / 5) + maximum * (index / 5)) };
  };
  const ratio = (value: number, minimum: number, maximum: number) => Number.isFinite(maximum - minimum)
    ? (value - minimum) / (maximum - minimum)
    : (value / 2 - minimum / 2) / (maximum / 2 - minimum / 2);
  const tickText = (value: number) => {
    if (value === 0) return "0";
    if (Math.abs(value) >= 100000 || Math.abs(value) < 0.001) return value.toExponential(1).replace(/\.0e/, "e");
    return String(Number(value.toPrecision(6)));
  };

  if (figure.kind === "diagram") {
    const nodes = new Map(figure.nodes.map(node => {
      const width = node.width * w, height = node.height * h;
      return [node.id, { ...node, px: Math.min(w - width, Math.max(0, node.x * w)), py: Math.min(h - height, Math.max(0, node.y * h)), pw: width, ph: height }];
    }));
    const edgePoint = (node: { px: number; py: number; pw: number; ph: number }, toward: { x: number; y: number }) => {
      const x = node.px + node.pw / 2, y = node.py + node.ph / 2;
      const dx = toward.x - x, dy = toward.y - y;
      const scale = 1 / Math.max(Math.abs(dx) / (node.pw / 2), Math.abs(dy) / (node.ph / 2), 1e-9);
      return { x: x + dx * scale, y: y + dy * scale };
    };
    for (const edge of figure.edges) {
      const from = nodes.get(edge.from), to = nodes.get(edge.to);
      if (!from || !to) continue;
      const start = edgePoint(from, { x: to.px + to.pw / 2, y: to.py + to.ph / 2 });
      const end = edgePoint(to, { x: from.px + from.pw / 2, y: from.py + from.ph / 2 });
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const arrow = [end, { x: end.x - 10 * Math.cos(angle - 0.45), y: end.y - 10 * Math.sin(angle - 0.45) }, { x: end.x - 10 * Math.cos(angle + 0.45), y: end.y - 10 * Math.sin(angle + 0.45) }];
      add(`edge:${edge.id}`, "edge", edge.label || `${from.label} → ${to.label}`, false,
        { x: Math.min(start.x, end.x) - 5, y: Math.min(start.y, end.y) - 5, width: Math.abs(end.x - start.x) + 10, height: Math.abs(end.y - start.y) + 10 },
        `<line x1="${n(start.x)}" y1="${n(start.y)}" x2="${n(end.x)}" y2="${n(end.y)}" stroke="${esc(edge.color)}" stroke-width="2"/><polygon points="${arrow.map(point => `${n(point.x)},${n(point.y)}`).join(" ")}" fill="${esc(edge.color)}"/>${edge.label ? labelText((start.x + end.x) / 2, (start.y + end.y) / 2 - 8, edge.label, fs, "middle", 'paint-order="stroke" stroke="#FFFFFF" stroke-width="4" stroke-linejoin="round"') : ""}`, edge.color);
    }
    for (const node of nodes.values()) {
      const rows: string[] = [];
      let row = "";
      for (const character of node.label) {
        if (row && (character === "\n" || textWidth(row + character, fs) > node.pw - 20)) { rows.push(row); row = ""; }
        if (character !== "\n") row += character;
      }
      if (row) rows.push(row);
      const maxRows = Math.max(1, Math.floor((node.ph - 12) / (fs * 1.3)));
      const visibleRows = rows.slice(0, maxRows);
      if (rows.length > maxRows) visibleRows[maxRows - 1] = shortText(visibleRows[maxRows - 1] + "…", node.pw - 20, fs);
      const luminance = [1, 3, 5].map(index => parseInt(node.color.slice(index, index + 2), 16)).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
      const textColor = luminance > 155 ? "#0F172A" : "#FFFFFF";
      add(`node:${node.id}`, "node", node.label, true, { x: node.px, y: node.py, width: node.pw, height: node.ph },
        `<title>${esc(node.label)}</title><rect x="${n(node.px)}" y="${n(node.py)}" width="${n(node.pw)}" height="${n(node.ph)}" rx="8" fill="${esc(node.color)}"/>${visibleRows.map((line, index) => labelText(node.px + node.pw / 2, node.py + node.ph / 2 + (index - (visibleRows.length - 1) / 2) * fs * 1.3, line, fs, "middle", `dominant-baseline="middle" fill="${textColor}"`)).join("")}`, node.color);
    }
  } else {
    const px = layout.plot.x * w, py = layout.plot.y * h, pw = layout.plot.width * w, ph = layout.plot.height * h;
    const yDomain = domain(figure.series.flatMap(series => figure.kind === "scatter" ? series.points.map(point => point.y) : series.values), figure.kind === "grouped-bar");
    const xDomain = domain(figure.series.flatMap(series => series.points.map(point => point.x)), false);
    const yFor = (value: number) => py + ph * (1 - ratio(value, yDomain.minimum, yDomain.maximum));
    const xFor = (value: number) => px + pw * ratio(value, xDomain.minimum, xDomain.maximum);
    const categoryX = (index: number) => figure.kind === "grouped-bar" ? px + pw * (index + 0.5) / figure.categories.length : px + pw * (figure.categories.length === 1 ? 0.5 : index / (figure.categories.length - 1));
    const axes: string[] = [`<rect x="${n(px)}" y="${n(py)}" width="${n(pw)}" height="${n(ph)}" fill="#FFFFFF" fill-opacity="0"/>`];
    for (const index of spacedIndices(yDomain.ticks.length, ph, fs + 10)) {
      const value = yDomain.ticks[index]!;
      const y = yFor(value);
      axes.push(`<line x1="${n(px)}" y1="${n(y)}" x2="${n(px + pw)}" y2="${n(y)}" stroke="${value === 0 ? "#94A3B8" : "#E2E8F0"}"/>${labelText(px - 10, y, tickText(value), fs - 1, "end", 'dominant-baseline="middle"')}`);
    }
    // PS-FRAME-001: one closed plot border, below data, with labels only at left/bottom.
    axes.push(`<rect data-role="plot-frame" data-visual-rule="PS-FRAME-001" x="${n(px)}" y="${n(py)}" width="${n(pw)}" height="${n(ph)}" fill="none" stroke="#92949A" stroke-width="1"/>`);
    if (figure.kind === "scatter") {
      const labelWidth = Math.max(...xDomain.ticks.map(value => textWidth(tickText(value), fs - 1)));
      for (const index of spacedIndices(xDomain.ticks.length, pw, labelWidth + 14)) {
        const value = xDomain.ticks[index]!;
        axes.push(labelText(xFor(value), py + ph + fs + 8, tickText(value), fs - 1));
      }
    } else {
      const maximumLabelWidth = Math.max(...figure.categories.map(value => textWidth(value, fs - 1)));
      const tickIndices = spacedIndices(figure.categories.length, pw, Math.max(40, Math.min(120, maximumLabelWidth + 12)));
      const slotWidth = tickIndices.length > 1 ? Math.min(...tickIndices.slice(1).map((index, offset) => categoryX(index) - categoryX(tickIndices[offset]!))) : pw;
      for (const index of tickIndices) {
        const label = figure.categories[index]!;
        axes.push(`<g data-role="category-tick"><title>${esc(label)}</title>${labelText(categoryX(index), py + ph + fs + 8, shortText(label, slotWidth - 8, fs - 1), fs - 1)}</g>`);
      }
    }
    add("plot", "plot", "绘图区", true, { x: px, y: py, width: pw, height: ph }, axes.join(""));
    for (let seriesIndex = 0; seriesIndex < figure.series.length; seriesIndex++) {
      const series = figure.series[seriesIndex]!;
      const marks: string[] = [];
      const points: Array<{ x: number; y: number }> = [];
      if (figure.kind === "grouped-bar") {
        const groupWidth = pw / figure.categories.length;
        const step = groupWidth * 0.76 / figure.series.length;
        const barWidth = step * 0.9;
        for (let index = 0; index < series.values.length; index++) {
          const value = series.values[index]!;
          const x = categoryX(index) - groupWidth * 0.38 + step * seriesIndex + (step - barWidth) / 2;
          const y = Math.min(yFor(value), yFor(0));
          const height = Math.abs(yFor(value) - yFor(0));
          marks.push(`<rect data-category="${esc(figure.categories[index]!)}" data-value="${esc(value)}" x="${n(x)}" y="${n(y)}" width="${n(barWidth)}" height="${n(height)}"><title>${esc(series.label)} · ${esc(figure.categories[index]!)}: ${esc(value)}</title></rect>`);
          points.push({ x, y }, { x: x + barWidth, y: y + height });
        }
      } else {
        const data = figure.kind === "scatter" ? series.points.map(point => ({ x: xFor(point.x), y: yFor(point.y), title: `${series.label}: (${point.x}, ${point.y})` })) : series.values.map((value, index) => ({ x: categoryX(index), y: yFor(value), title: `${series.label} · ${figure.categories[index]}: ${value}` }));
        if (figure.kind === "line") marks.push(`<polyline points="${data.map(point => `${n(point.x)},${n(point.y)}`).join(" ")}" stroke="${esc(series.color)}" stroke-width="2.5" stroke-linejoin="round" fill="none"/>`);
        for (const point of data) { marks.push(`<circle cx="${n(point.x)}" cy="${n(point.y)}" r="4"><title>${esc(point.title)}</title></circle>`); points.push({ x: point.x - 4, y: point.y - 4 }, { x: point.x + 4, y: point.y + 4 }); }
      }
      const left = Math.min(...points.map(point => point.x)), top = Math.min(...points.map(point => point.y));
      add(`series:${series.id}`, "series", series.label, false,
        { x: left, y: top, width: Math.max(2, Math.max(...points.map(point => point.x)) - left), height: Math.max(2, Math.max(...points.map(point => point.y)) - top) },
        `<g data-series-id="${esc(series.id)}" fill="${esc(series.color)}">${marks.join("")}</g>`, series.color);
    }
    if (figure.series.length) {
      const padding = 12, rowHeight = fs + 12;
      const maximumRows = Math.max(1, Math.floor((h - 2 * padding - 20) / rowHeight));
      const columns = Math.ceil(figure.series.length / maximumRows);
      const rows = Math.ceil(figure.series.length / columns);
      const widestLabel = Math.max(...figure.series.map(series => textWidth(series.label, fs)));
      const columnWidth = Math.min((w - 2 * padding) / columns, Math.max(72, Math.min(220, widestLabel + 38)));
      const legendWidth = Math.min(w - 2 * padding, columns * columnWidth + 2 * padding);
      const legendHeight = rows * rowHeight + 2 * padding;
      const lx = Math.min(w - padding - legendWidth, Math.max(padding, layout.legend.x * w));
      const ly = Math.min(h - padding - legendHeight, Math.max(padding, layout.legend.y * h));
      const content = [`<rect x="${n(lx)}" y="${n(ly)}" width="${n(legendWidth)}" height="${n(legendHeight)}" rx="6" fill="#FFFFFF" fill-opacity="0.96" stroke="#E2E8F0"/>`];
      for (let index = 0; index < figure.series.length; index++) {
        const series = figure.series[index]!;
        const x = lx + padding + Math.floor(index / rows) * columnWidth;
        const y = ly + padding + (index % rows + 0.5) * rowHeight;
        content.push(`<g data-series-id="${esc(series.id)}"><title>${esc(series.label)}</title><rect data-role="legend-swatch" x="${n(x)}" y="${n(y - 6)}" width="16" height="12" rx="2" fill="${esc(series.color)}"/>${labelText(x + 24, y, shortText(series.label, columnWidth - 32, fs), fs, "start", 'dominant-baseline="middle"')}</g>`);
      }
      add("legend", "legend", "图例", true, { x: lx, y: ly, width: legendWidth, height: legendHeight }, content.join(""), undefined, layout.legend.visible);
    }
    centeredLabel("xLabel", figure.xLabel, fs);
    centeredLabel("yLabel", figure.yLabel, fs, true);
  }
  centeredLabel("title", figure.title, fs + 6);
  for (const annotation of figure.annotations) {
    const x = annotation.x * w, y = annotation.y * h, size = annotation.fontSize;
    const length = Math.min(textWidth(annotation.text, size), Math.max(0, w - x - 8));
    add(`annotation:${annotation.id}`, "annotation", annotation.text, true,
      { x, y: y - size * 0.65, width: length, height: size * 1.3 },
      `<title>${esc(annotation.text)}</title>${labelText(x, y, shortText(annotation.text, length, size), size, "start", `dominant-baseline="middle" fill="${esc(annotation.color)}"`)}`, annotation.color);
  }
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(figure.title)}"><title>${esc(figure.title)}</title><rect width="${w}" height="${h}" fill="#FFFFFF"/><g font-family="Arial, 'Microsoft YaHei', sans-serif" fill="#334155">${body.join("")}</g></svg>`, elements };
}

/** The saved source is portable and preserves every semantic color and layout choice. */
export function generateVisualSource(figure: VisualFigure): string {
  return `// NEXIOM visual source. Edit FIGURE, then run: node render.mjs [output.svg]\nimport { writeFileSync } from "node:fs";\n\nexport const FIGURE = ${JSON.stringify(figure, null, 2)};\n\nconst renderVisualFigure = ${renderVisualFigure.toString()};\n\nwriteFileSync(process.argv[2] || "figure.svg", renderVisualFigure(FIGURE).svg, "utf8");\n`;
}
