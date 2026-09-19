import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { visualFigureSchema, visualLibrarySchema, type VisualAsset, type VisualAssetSummary, type VisualFigure, type VisualLibraryKind, type VisualWorkspaceState } from "./document";
import { generateVisualSource, renderVisualFigure } from "./render";

const WORKSPACE = "outputs/visual-design";
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_RENDER_BYTES = 12 * 1024 * 1024;
const idSchema = z.string().uuid();
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pointerSchema = z.object({ version: z.literal(1), revision: revisionSchema }).strict();
const metadataSchema = z.object({
  version: z.literal(1), origin: z.literal("agent"), id: idSchema,
  library: visualLibrarySchema, title: z.string().trim().min(1).max(240),
  kind: z.enum(["grouped-bar", "line", "scatter", "diagram"]), revision: revisionSchema,
  updatedAt: z.string().datetime(), purpose: z.string().trim().min(1).max(4000),
  sourcePaths: z.array(z.string().min(1).max(4096)).min(1).max(32),
}).strict();
const projectQueues = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function relativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("可视化文件路径必须位于当前项目内。");
  return relative.split(path.sep).join("/");
}

async function projectRoot(project: string): Promise<string> {
  const root = await realpath(project);
  if (!(await lstat(root)).isDirectory()) throw new Error("项目路径必须是文件夹。");
  return root;
}

// Check each existing ancestor before making directories or opening project files.
async function checkedPath(root: string, relative: string, createDirectories = false): Promise<{ target: string; exists: boolean }> {
  const target = path.resolve(root, relative);
  const normalized = relativePath(root, target);
  let current = root;
  const parts = normalized.split("/").filter(Boolean);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!createDirectories) return { target, exists: false };
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) throw new Error("可视化素材路径不能包含符号链接或目录联接。");
    relativePath(root, await realpath(current));
    if ((index < parts.length - 1 || createDirectories) && !info.isDirectory()) throw new Error("可视化素材目录被同名文件占用。");
  }
  return { target, exists: true };
}

async function readBounded(root: string, relative: string, maxBytes: number): Promise<string> {
  const checked = await checkedPath(root, relative);
  if (!checked.exists) throw new Error("素材尚未由 Agent 注册，或素材文件不存在。");
  const info = await lstat(checked.target);
  if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes) throw new Error("可视化文件类型或大小无效。");
  const buffer = await readFile(checked.target);
  if (buffer.length > maxBytes) throw new Error("可视化文件超过大小限制。");
  return buffer.toString("utf8");
}

function assertSize(value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("可视化素材超过大小限制，请减少数据点或元素数量。");
}

function parseFigure(candidate: unknown): VisualFigure {
  const serialized = JSON.stringify(candidate);
  if (typeof serialized !== "string") throw new Error("缺少结构化可视化文档。");
  assertSize(serialized, MAX_DOCUMENT_BYTES);
  return visualFigureSchema.parse(candidate);
}

function immutableContent(figure: VisualFigure): unknown {
  return {
    version: figure.version, kind: figure.kind, title: figure.title,
    xLabel: figure.xLabel, yLabel: figure.yLabel, categories: figure.categories,
    series: figure.series.map(({ color: _color, ...series }) => series),
    nodes: figure.nodes.map(({ x: _x, y: _y, width: _width, height: _height, color: _color, ...node }) => node),
    edges: figure.edges.map(({ color: _color, ...edge }) => edge),
    annotations: figure.annotations.map(({ x: _x, y: _y, color: _color, fontSize: _fontSize, ...annotation }) => annotation),
  };
}

export function validateVisualEdit(original: VisualFigure, candidate: unknown): VisualFigure {
  const figure = parseFigure(candidate);
  if (JSON.stringify(immutableContent(parseFigure(original))) !== JSON.stringify(immutableContent(figure))) {
    throw new Error("工作台只能调整配色和元素布局，不能修改图表类型、数据、文字或元素关系。请由 Agent 重新创作素材。");
  }
  return figure;
}

async function validateSources(root: string, input: unknown): Promise<string[]> {
  const sources = z.array(z.string().trim().min(1).max(4096)).min(1, "请提供至少一个实际存在的建模或论文资料文件；概念图可引用项目中的依据说明文档。").max(32).parse(input);
  const result: string[] = [];
  for (const source of sources) {
    if (source.includes("\0")) throw new Error("资料来源路径无效。");
    const normalized = relativePath(root, path.resolve(root, source));
    if (!normalized || normalized.split("/").some(part => part.startsWith(".") || ["node_modules", "dist", "build", "vendor"].includes(part.toLowerCase()))) throw new Error("资料来源必须是项目中的建模或论文文件，不能引用隐藏运行目录或依赖目录。");
    const checked = await checkedPath(root, normalized);
    if (!checked.exists) throw new Error(`资料来源文件不存在：${normalized}`);
    const info = await lstat(checked.target);
    if (!info.isFile() || info.nlink !== 1) throw new Error(`资料来源必须是项目内的独立常规文件：${normalized}`);
    result.push(normalized);
  }
  return [...new Set(result)];
}

function libraryPath(library: VisualLibraryKind): string {
  return `${WORKSPACE}/${visualLibrarySchema.parse(library)}`;
}

function assetPath(library: VisualLibraryKind, id: string): string {
  return `${libraryPath(library)}/${idSchema.parse(id)}`;
}

async function stateForRoot(root: string): Promise<VisualWorkspaceState> {
  const state: VisualWorkspaceState = { root: WORKSPACE, libraries: [], assets: [], warnings: [] };
  for (const kind of ["modeling", "paper"] as const) {
    const relative = libraryPath(kind);
    try {
      const checked = await checkedPath(root, relative);
      state.libraries.push({ kind, label: kind === "modeling" ? "建模过程" : "论文论述", path: relative, exists: checked.exists });
      if (!checked.exists) continue;
      if (!(await lstat(checked.target)).isDirectory()) throw new Error("素材库路径不是文件夹。");
      for (const entry of await readdir(checked.target, { withFileTypes: true })) {
        if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success) continue;
        try {
          const metadata = await readMetadata(root, kind, entry.name);
          state.assets.push(toSummary(metadata));
        } catch (error) {
          state.warnings.push(`${relative}/${entry.name}：${error instanceof Error ? error.message : "素材读取失败"}`);
        }
      }
    } catch (error) {
      const library = state.libraries.find(library => library.kind === kind);
      if (library) library.exists = false;
      else state.libraries.push({ kind, label: kind === "modeling" ? "建模过程" : "论文论述", path: relative, exists: false });
      state.warnings.push(`${relative}：${error instanceof Error ? error.message : "素材库读取失败"}`);
    }
  }
  state.assets.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return state;
}

async function exclusive<T>(root: string, operation: () => Promise<T>, createWorkspace = false): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = projectQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  projectQueues.set(key, current);
  await previous;
  try {
    const workspace = await checkedPath(root, WORKSPACE, createWorkspace);
    if (!workspace.exists) throw new Error("素材尚未由 Agent 注册，请先由 Agent 创建可视化素材库。");
    const lockPath = (await checkedPath(root, `${WORKSPACE}/.write.lock`)).target;
    let lock;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("可视化素材库正在被另一进程保存，请稍后重试。");
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await operation();
    } finally {
      await lock.close();
      const checked = await checkedPath(root, `${WORKSPACE}/.write.lock`);
      if (checked.exists) await unlink(checked.target);
    }
  } finally {
    release();
    if (projectQueues.get(key) === current) projectQueues.delete(key);
  }
}

export async function listVisualWorkspace(project: string): Promise<VisualWorkspaceState> {
  return stateForRoot(await projectRoot(project));
}

export async function ensureVisualLibraries(project: string): Promise<VisualWorkspaceState> {
  const root = await projectRoot(project);
  return exclusive(root, async () => {
    for (const library of ["modeling", "paper"] as const) await checkedPath(root, libraryPath(library), true);
    return stateForRoot(root);
  }, true);
}

async function readMetadata(root: string, library: VisualLibraryKind, id: string) {
  const relative = assetPath(library, id);
  const pointer = pointerSchema.parse(JSON.parse(await readBounded(root, `${relative}/current.json`, 4096)));
  const metadata = metadataSchema.parse(JSON.parse(await readBounded(root, `${relative}/rev-${pointer.revision}/meta.json`, MAX_DOCUMENT_BYTES)));
  if (metadata.id !== id || metadata.library !== library || metadata.revision !== pointer.revision) throw new Error("素材注册信息与所属目录不一致。");
  return metadata;
}

function toSummary(metadata: z.infer<typeof metadataSchema>): VisualAssetSummary {
  return { id: metadata.id, library: metadata.library, title: metadata.title, kind: metadata.kind,
    revision: metadata.revision, updatedAt: metadata.updatedAt, purpose: metadata.purpose, sourcePaths: metadata.sourcePaths };
}

async function readAsset(root: string, library: VisualLibraryKind, id: string): Promise<VisualAsset> {
  const metadata = await readMetadata(root, library, id);
  const snapshot = `${assetPath(library, id)}/rev-${metadata.revision}`;
  const documentPath = `${snapshot}/figure.json`;
  const sourcePath = `${snapshot}/render.mjs`;
  const imagePath = `${snapshot}/figure.svg`;
  const figure = parseFigure(JSON.parse(await readBounded(root, documentPath, MAX_DOCUMENT_BYTES)));
  if (figure.kind !== metadata.kind) throw new Error("素材图表类型与注册信息不一致。");
  await readBounded(root, sourcePath, MAX_RENDER_BYTES);
  await readBounded(root, imagePath, MAX_RENDER_BYTES);
  // Renderer upgrades may change SVG output; only a save replaces the stored snapshot.
  const rendered = renderVisualFigure(figure);
  return { ...toSummary(metadata), origin: "agent", figure, svg: rendered.svg, elements: rendered.elements, documentPath, sourcePath, imagePath };
}

export async function readVisualAsset(project: string, library: VisualLibraryKind, id: string): Promise<VisualAsset> {
  return readAsset(await projectRoot(project), library, id);
}

async function writeExclusive(root: string, relative: string, contents: string, maxBytes: number): Promise<void> {
  assertSize(contents, maxBytes);
  const checked = await checkedPath(root, relative);
  const handle = await open(checked.target, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSnapshot(root: string, metadata: z.infer<typeof metadataSchema>, figure: VisualFigure): Promise<VisualAsset> {
  const relative = assetPath(metadata.library, metadata.id);
  await checkedPath(root, relative, true);
  const staging = `${relative}/.pending-${randomUUID()}`;
  const revision = `${relative}/rev-${metadata.revision}`;
  const pointerTemporary = `${relative}/.current-${randomUUID()}.tmp`;
  let revisionWritten = false;
  let committed = false;
  try {
    await checkedPath(root, staging, true);
    const rendered = renderVisualFigure(figure);
    await writeExclusive(root, `${staging}/figure.json`, JSON.stringify(figure, null, 2), MAX_DOCUMENT_BYTES);
    await writeExclusive(root, `${staging}/render.mjs`, generateVisualSource(figure), MAX_RENDER_BYTES);
    await writeExclusive(root, `${staging}/figure.svg`, rendered.svg, MAX_RENDER_BYTES);
    await writeExclusive(root, `${staging}/meta.json`, JSON.stringify(metadata, null, 2), MAX_DOCUMENT_BYTES);
    const revisionTarget = await checkedPath(root, revision);
    if (revisionTarget.exists) throw new Error("素材修订目录已存在，无法覆盖历史版本。");
    await rename((await checkedPath(root, staging)).target, revisionTarget.target);
    revisionWritten = true;
    await writeExclusive(root, pointerTemporary, JSON.stringify({ version: 1, revision: metadata.revision }), 4096);
    const pointer = await checkedPath(root, `${relative}/current.json`);
    if (pointer.exists) {
      const info = await lstat(pointer.target);
      if (!info.isFile() || info.nlink !== 1) throw new Error("素材修订指针不是合法文件。");
    }
    await rename((await checkedPath(root, pointerTemporary)).target, pointer.target);
    committed = true;
    const snapshot = `${relative}/rev-${metadata.revision}`;
    return { ...toSummary(metadata), origin: "agent", figure, svg: rendered.svg, elements: rendered.elements,
      documentPath: `${snapshot}/figure.json`, sourcePath: `${snapshot}/render.mjs`, imagePath: `${snapshot}/figure.svg` };
  } finally {
    for (const leftover of [staging, pointerTemporary, ...(!committed && revisionWritten ? [revision] : [])]) {
      const checked = await checkedPath(root, leftover);
      if (checked.exists) await rm(checked.target, { recursive: true, force: true });
    }
  }
}

export async function createVisualAsset(project: string, input: { library: VisualLibraryKind; title?: string; figure: unknown; purpose: string; sourcePaths: string[] }): Promise<VisualAsset> {
  const root = await projectRoot(project);
  const figure = parseFigure(input.figure);
  const sourcePaths = await validateSources(root, input.sourcePaths);
  const metadata = metadataSchema.parse({ version: 1, origin: "agent", id: randomUUID(), library: input.library,
    title: input.title ?? (figure.title || "未命名可视化"), kind: figure.kind, revision: 1,
    updatedAt: new Date().toISOString(), purpose: input.purpose, sourcePaths });
  return exclusive(root, async () => {
    for (const library of ["modeling", "paper"] as const) await checkedPath(root, libraryPath(library), true);
    return writeSnapshot(root, metadata, figure);
  }, true);
}

export async function saveVisualAsset(project: string, input: { library: VisualLibraryKind; id: string; expectedRevision: number; figure: unknown }): Promise<VisualAsset> {
  const root = await projectRoot(project);
  assetPath(input.library, input.id);
  revisionSchema.parse(input.expectedRevision);
  return exclusive(root, async () => {
    const original = await readAsset(root, input.library, input.id);
    if (original.revision !== input.expectedRevision) throw new Error("素材已由其他操作更新，当前修订版本冲突；请重新打开素材后再保存。");
    const figure = validateVisualEdit(original.figure, input.figure);
    const metadata = metadataSchema.parse({ id: original.id, library: original.library, title: original.title, kind: original.kind,
      purpose: original.purpose, sourcePaths: original.sourcePaths, version: 1, origin: "agent", revision: original.revision + 1, updatedAt: new Date().toISOString() });
    return writeSnapshot(root, metadata, figure);
  });
}
