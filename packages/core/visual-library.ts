import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FileContent, VisualCatalog } from "../contracts";

type Entry = Record<string, any>;
type Library = { catalog: VisualCatalog; assets: Map<string, string> };
let cached: { key: string; value: Library } | undefined;
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string") : [];
const entries = (value: unknown): Entry[] => Array.isArray(value)
  ? value.filter((item) => item && typeof item === "object") : [];

function bundleRoot() {
  return path.resolve(process.env.NEXIOM_VISUAL_BUNDLE_ROOT || path.join(__dirname, "../packages/visualization-engine"));
}

async function library(): Promise<Library> {
  const root = bundleRoot();
  const catalogPath = path.join(root, "catalog.json");
  let modified;
  try { modified = await stat(catalogPath); }
  catch { throw new Error("可视化资源库尚未导入，请重新安装含图表设计资源的 NEXIOM。"); }
  const key = `${root}:${modified.mtimeMs}:${modified.size}`;
  if (cached?.key === key) return cached.value;
  const raw = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!Array.isArray(raw.templates) || !Array.isArray(raw.palettes))
    throw new Error("可视化资源目录格式无效，请重新导入资源。");
  const assets = new Map<string, string>();
  const templates = entries(raw.templates).map((item) => ({
    id: String(item.template_id ?? item.id),
    name: String(item.name ?? item.description ?? item.template_id),
    family: String(item.family ?? ""),
    description: String(item.description ?? ""),
    readerQuestion: String(item.reader_question ?? ""),
    requiredColumns: strings(item.required_columns),
    preconditions: strings(item.statistical_preconditions),
    forbiddenUses: strings(item.forbidden_use_cases),
    keywords: strings(item.keywords),
  }));
  const paletteNames = new Map(entries(raw.palettes).map((item) => [item.id, item.name]));
  const palettes = entries(raw.palettes).map((item) => ({
    id: String(item.id), name: String(item.name), description: String(item.description ?? ""),
    colors: (Array.isArray(item.colors) ? item.colors : []).map((color: any) =>
      typeof color === "string" ? color : String(color.hex ?? "")).filter((color: string) => /^#[0-9a-f]{6}$/i.test(color)),
  }));
  const referenceIds = new Set<string>();
  const references = [
    ...entries(raw.references).map((item) => ({ ...item, sourceType: "参考原图" })),
    ...entries(raw.previews).map((item) => ({
      ...item, sourceType: "模板预览",
      name: `${item.name ?? item.chartId ?? item.id} · ${paletteNames.get(item.paletteId) ?? item.paletteId ?? ""}`,
      description: item.description || `使用「${paletteNames.get(item.paletteId) ?? item.paletteId ?? "预设"}」配色的图表预览，供选择布局与色彩。`,
    })),
  ].map((item: Entry, index) => {
    const baseId = String(item.id ?? `${item.sourceType === "参考原图" ? "reference" : "preview"}-${index}`);
    let id = baseId;
    for (let duplicate = 2; referenceIds.has(id); duplicate += 1) id = `${baseId}-${duplicate}`;
    referenceIds.add(id);
    const imagePath = typeof item.imagePath === "string" ? item.imagePath : null;
    if (imagePath) assets.set(id, imagePath);
    return {
      id, name: String(item.name ?? item.id),
      description: String(item.description ?? item.reader_question ?? item.use_when ?? ""),
      tags: [...new Set([item.sourceType, item.family, item.chartId, paletteNames.get(item.paletteId), ...strings(item.tags), ...strings(item.aliases)].filter((tag): tag is string => typeof tag === "string" && !!tag))],
      assetId: imagePath ? id : null,
    };
  });
  const templateIds = new Set(templates.map((item) => item.id));
  const grammar = entries(raw.grammar).map((item, index) => {
    const templateId = item.template_id ?? item.templateId;
    return {
      id: String(item.id ?? item.grammar_id ?? `grammar-${index}`),
      name: String(item.name_zh ?? item.name ?? item.id ?? "图种"),
      nameEn: String(item.name_en ?? item.nameEn ?? ""),
      description: [item.reader_question, item.description, ...strings(item.aliases)].filter(Boolean).join(" · "),
      status: item.status === "executable" && templateIds.has(templateId) ? "executable" as const : "name_index_only" as const,
      ...(templateIds.has(templateId) ? { templateId: String(templateId) } : {}),
    };
  });
  const catalog: VisualCatalog = {
    version: String(raw.version ?? "unknown"), templates, palettes, references, grammar,
    counts: { templates: templates.length, palettes: palettes.length, references: references.length, grammar: grammar.length },
  };
  const value = { catalog, assets };
  cached = { key, value };
  return value;
}

export async function readVisualCatalog(): Promise<VisualCatalog> {
  return (await library()).catalog;
}

export async function readVisualAsset(assetId: string): Promise<FileContent> {
  const asset = (await library()).assets.get(assetId);
  if (!asset) throw new Error("图库中没有这张图片。");
  const root = await realpath(bundleRoot());
  const file = await realpath(path.resolve(root, asset));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new Error("图库图片路径无效。");
  const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string, string>)[path.extname(file).toLowerCase()];
  if (!mime) throw new Error("不支持此图库图片格式。");
  const info = await stat(file);
  if (!info.isFile() || info.size > 12 * 1024 * 1024) throw new Error("图库图片超出预览大小限制。");
  const bytes = await readFile(file);
  return { path: assetId, mime, size: bytes.length, text: null, base64: bytes.toString("base64") };
}
