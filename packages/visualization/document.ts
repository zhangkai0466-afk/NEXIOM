import { z } from "zod";

export const visualLibrarySchema = z.enum(["modeling", "paper"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const coordinate = z.number().finite().min(0).max(1);
const position = z.object({ x: coordinate, y: coordinate });
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const label = z.string().max(240);

export const visualFigureSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["grouped-bar", "line", "scatter", "diagram"]),
  title: label,
  width: z.number().int().min(480).max(2400).default(960),
  height: z.number().int().min(320).max(1800).default(640),
  xLabel: label.default(""),
  yLabel: label.default(""),
  categories: z.array(label).max(100).default([]),
  series: z.array(z.object({
    id: identifier,
    label: label,
    color,
    values: z.array(z.number().finite()).max(1000).default([]),
    points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() })).max(1000).default([]),
  })).max(32).default([]),
  nodes: z.array(z.object({
    id: identifier, label, x: coordinate, y: coordinate,
    width: z.number().min(0.03).max(0.8).default(0.18),
    height: z.number().min(0.03).max(0.8).default(0.1),
    color,
  })).max(100).default([]),
  edges: z.array(z.object({ id: identifier, from: identifier, to: identifier, label: label.default(""), color: color.default("#64748B") })).max(200).default([]),
  annotations: z.array(z.object({ id: identifier, text: label, x: coordinate, y: coordinate, color: color.default("#334155"), fontSize: z.number().min(8).max(48).default(14) })).max(100).default([]),
  layout: z.object({
    plot: position.extend({ width: z.number().min(0.1).max(0.9), height: z.number().min(0.1).max(0.9) }).default({ x: 0.12, y: 0.18, width: 0.62, height: 0.66 }),
    legend: position.extend({ visible: z.boolean().default(true) }).default({ x: 0.78, y: 0.2, visible: true }),
    title: position.default({ x: 0.5, y: 0.075 }),
    xLabel: position.default({ x: 0.43, y: 0.96 }),
    yLabel: position.default({ x: 0.035, y: 0.51 }),
    fontSize: z.number().int().min(10).max(28).default(14),
  }).default({ plot: { x: 0.12, y: 0.18, width: 0.62, height: 0.66 }, legend: { x: 0.78, y: 0.2, visible: true }, title: { x: 0.5, y: 0.075 }, xLabel: { x: 0.43, y: 0.96 }, yLabel: { x: 0.035, y: 0.51 }, fontSize: 14 }),
}).superRefine((figure, context) => {
  for (const [key, items] of Object.entries({ series: figure.series, nodes: figure.nodes, edges: figure.edges, annotations: figure.annotations })) {
    if (new Set(items.map(item => item.id)).size !== items.length) context.addIssue({ code: "custom", message: `${key} 元素 ID 必须唯一。`, path: [key] });
  }
  if (figure.kind === "diagram") {
    if (!figure.nodes.length) context.addIssue({ code: "custom", message: "结构图必须包含节点。", path: ["nodes"] });
    const ids = new Set(figure.nodes.map(node => node.id));
    if (figure.edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to))) context.addIssue({ code: "custom", message: "连线必须引用已有节点。", path: ["edges"] });
  } else {
    if (!figure.series.length) context.addIssue({ code: "custom", message: "图表必须包含有名称的数据系列。", path: ["series"] });
    if (figure.kind === "scatter") {
      if (figure.series.some(series => !series.points.length)) context.addIssue({ code: "custom", message: "散点系列必须包含坐标。", path: ["series"] });
    } else if (!figure.categories.length || figure.series.some(series => series.values.length !== figure.categories.length)) {
      context.addIssue({ code: "custom", message: "每个系列的数据数量必须与横轴类别一一对应。", path: ["series"] });
    }
  }
  if (figure.layout.plot.x + figure.layout.plot.width > 1 || figure.layout.plot.y + figure.layout.plot.height > 1) context.addIssue({ code: "custom", message: "绘图区不能超出画布。", path: ["layout", "plot"] });
});

export type VisualLibraryKind = z.infer<typeof visualLibrarySchema>;
export type VisualFigure = z.infer<typeof visualFigureSchema>;
export interface VisualElement {
  id: string;
  kind: "series" | "legend" | "title" | "plot" | "xLabel" | "yLabel" | "annotation" | "node" | "edge";
  label: string;
  color?: string;
  movable: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface VisualAssetSummary {
  id: string;
  library: VisualLibraryKind;
  title: string;
  kind: VisualFigure["kind"];
  revision: number;
  updatedAt: string;
  sourcePaths: string[];
  purpose: string;
}
export interface VisualAsset extends VisualAssetSummary {
  origin: "agent";
  figure: VisualFigure;
  svg: string;
  elements: VisualElement[];
  documentPath: string;
  sourcePath: string;
  imagePath: string;
}
export interface VisualWorkspaceState {
  root: string;
  libraries: Array<{ kind: VisualLibraryKind; label: string; path: string; exists: boolean }>;
  assets: VisualAssetSummary[];
  warnings: string[];
}
