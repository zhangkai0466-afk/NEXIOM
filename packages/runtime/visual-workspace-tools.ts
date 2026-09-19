import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ThreadStage } from "../contracts";
import { visualFigureSchema, visualLibrarySchema, type VisualAsset } from "../visualization/document";
import { createVisualAsset, ensureVisualLibraries, listVisualWorkspace, readVisualAsset } from "../visualization/store";

export function supportsVisualWorkspace(stage: ThreadStage | undefined): boolean {
  return stage === "model" || stage === "chart" || stage === "paper";
}

const empty = z.object({}).strict();
const assetIdentity = z.object({
  library: visualLibrarySchema,
  id: z.string().uuid(),
}).strict();
const createAsset = z.object({
  library: visualLibrarySchema.describe("建模过程素材用 modeling；支撑论文论述的素材用 paper。"),
  title: z.string().trim().min(1).max(240).optional(),
  purpose: z.string().trim().min(1).max(4000).describe("说明图像要解释的建模过程或支撑的论文论述，以及数据/推导来源。"),
  sourcePaths: z.array(z.string().trim().min(1).max(4096)).min(1).max(32).describe("实际存在的来源文件在当前项目内的相对路径；概念图可先在项目中整理推导依据文档并引用，不得捏造数据或来源。"),
  figure: visualFigureSchema.describe("可编辑的语义图定义。条形图 categories 为横轴情况 D/E/F，series 为成员 A/B/C，每个系列有稳定 ID、标签、十六进制颜色及与类别顺序一致的数据；图例由系列自动生成。PS-FRAME-001：二维直角坐标图的绘图区固定使用完整四边矩形细框，上、右边默认不重复刻度和标签；结构图不加坐标框。"),
}).strict();

const definitions = [
  { name: "ensure_visual_libraries", readOnly: false, schema: empty,
    description: "由 Agent 创建当前项目的 outputs/visual-design/modeling（建模过程可视化库）和 outputs/visual-design/paper（论文论述可视化库）。仅执行模式可用；目录已存在时保留素材。" },
  { name: "list_visual_assets", readOnly: true, schema: empty,
    description: "只读列出两个可视化库及 Agent 制作的结构化素材、来源和用途；不会创建目录。图库参考图片和本地普通图片不属于工作台素材。" },
  { name: "get_visual_asset", readOnly: true, schema: assetIdentity,
    description: "读取 Agent 素材的图像类别、系列标签与配色、图例位置、可移动元素、数据及可复现源码路径，用于识别语义元素与分析设计。" },
  { name: "create_visual_asset", readOnly: false, schema: createAsset,
    description: "从真实数据或推导创建 Agent 结构化可视化素材并保存进指定库；自动确保两个库存在，同时生成语义图定义、可复现源码和 SVG。支持 grouped-bar、line、scatter、diagram。保留系列与颜色、图例等元素的对应关系，使工作台可以按系列换色并重新生成，或移动图例等元素。禁止将图库或本地 PNG 注册为项目成果。仅执行模式可用。" },
] as const;

export interface VisualNativeDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
}

export const visualWorkspaceDefinitions: VisualNativeDefinition[] = definitions.map(({ schema, ...definition }) => ({
  ...definition,
  inputSchema: zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }),
}));

function assetMetadata(asset: VisualAsset) {
  // The SVG remains on disk; semantic elements are sufficient for subsequent
  // design decisions and avoid filling agent history with generated markup.
  const { svg: _svg, ...metadata } = asset;
  return metadata;
}

export async function callVisualWorkspaceTool(root: string, tool: string, arguments_: unknown): Promise<unknown> {
  switch (tool) {
    case "ensure_visual_libraries":
      empty.parse(arguments_);
      return ensureVisualLibraries(root);
    case "list_visual_assets":
      empty.parse(arguments_);
      return listVisualWorkspace(root);
    case "get_visual_asset": {
      const input = assetIdentity.parse(arguments_);
      return assetMetadata(await readVisualAsset(root, input.library, input.id));
    }
    case "create_visual_asset":
      return assetMetadata(await createVisualAsset(root, createAsset.parse(arguments_)));
    default:
      throw new Error("未知的结构化可视化工具。");
  }
}
