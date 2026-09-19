import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentInput } from "./index";
import { callVisualWorkspaceTool, supportsVisualWorkspace, visualWorkspaceDefinitions, type VisualNativeDefinition } from "./visual-workspace-tools";

export const VISUAL_DESIGN_CAPABILITY_VERSION = "nexiom-native-visual-design-1.7.1-v4-rectangular-axes";
const hostRuntimePath = /(?:^|[\\/])(?:\.codex|codex-runtimes)(?:[\\/]|$)|[\\/]OpenAI[\\/]Codex[\\/]/i;

export interface VisualDesignRuntimeStatus {
  available: boolean;
  label: string;
  python: string | null;
  bundleVersion: string | null;
  bundleRoot: string | null;
}

export const visualDesignInstructions = `\n\n当前阶段具备 NEXIOM 原生可视化设计能力（命名空间 nexiom_visual）。执行可视化任务时，由 Agent 使用 ensure_visual_libraries 在当前项目 outputs/visual-design 下创建 modeling（建模过程可视化库）与 paper（论文论述可视化库）。model 阶段优先为建模方法、过程、变量关系与初步结果设计素材；paper 阶段为具体论文论述、比较和结论设计素材；chart 阶段可完善两个库。用 list_visual_assets、get_visual_asset 阅读已有成果及来源，再用 create_visual_asset 创建包含真实数据、系列标签、配色、图例、结构位置的语义图，保存 SVG、图定义与可复现源码。create_visual_asset 也会自动创建两个库。仅承诺实际生成和核验的格式。
两个素材库仅按设计阶段和用途归档，工作台统一汇总两个库，使用同一套调色与结构调整功能。工作台只编辑 Agent 创建的结构化图像。调色是识别图像语义元素后修改其源码配色并重新渲染；调整是移动图例、标题、绘图区、标注或结构节点等元素，以解决重叠和排版问题，不是亮度或对比度滤镜。按图像类别理解其结构，保留元素的稳定 ID 与语义对应关系。例如 A/B/C 三个成员在 D/E/F 三种情况下的生存能力分组条形图，应令 categories=[D,E,F]，series 为 A/B/C，每个系列带有标签、颜色与按 D/E/F 顺序排列的真实数据；图例颜色始终跟随对应系列。
PS-FRAME-001：二维直角坐标数据图的绘图区必须由左、下、上、右四边组成完整矩形细框，四边样式统一，默认只在左、下显示刻度和标签；上、右不重复标注。边框与辅助线位于数据图形下方。分组条形图、折线图、散点图由原生渲染器固定执行，不提供隐藏上、右边框的选项；Python 模板在导出前执行同一规则。结构图、极坐标、三维图和连续色条不套用此矩形坐标框规则。
绘图必须基于当前项目中的实际数据、计算结果或明确的概念/推导，purpose 说明图像用途和依据，sourcePaths 记录至少一个实际存在的资料文件的项目相对路径；概念图可先在项目中整理推导依据文档并引用。不得捏造数值或来源，不得将参考图库图片当作成果或注册进工作台。图表阶段若提供模板、色板与图库工具，可用于学习样式和选择配色；工作台无需 Python 或 MCP。旧模板工具导出的普通图片不能冒充可编辑素材，应使用结构化工具生成工作台所需图定义。规划模式只调用 list_visual_assets、get_visual_asset 与其他标记为只读的工具，不能创建文件夹或图像；写工具虽为延续会话保留声明，也仅执行模式可调用。网络关闭时不请求额外模型调用；模型参数使用 NEXIOM 当前供应商设置。`;

export function resolveVisualDesignBundle(): string {
  const configured = process.env.NEXIOM_VISUAL_BUNDLE_ROOT;
  const root = configured
    ? path.resolve(configured)
    : path.resolve(__dirname, "../packages/visualization-engine");
  if (!existsSync(path.join(root, "native.py")))
    throw new Error("未找到内置可视化组件，请重新安装 NEXIOM。");
  return root;
}

function bundleVersion(root: string): string | null {
  for (const name of ["manifest.json", "catalog.json"]) {
    try {
      const content = JSON.parse(readFileSync(path.join(root, name), "utf8"));
      const version = content.version ?? content.bundleVersion;
      if (typeof version === "string") return version;
    } catch { /* A missing optional manifest is reported by boot.py --check. */ }
  }
  return null;
}

function pythonCandidates(): string[] {
  const configured = process.env.NEXIOM_VISUAL_PYTHON;
  if (configured) {
    if (!path.isAbsolute(configured) || hostRuntimePath.test(configured))
      throw new Error("可视化 Python 必须是独立的绝对路径，不能使用个人 Codex 的运行环境。");
    return [configured];
  }
  const name = process.platform === "win32" ? "python.exe" : "python3";
  const candidates = [
    path.resolve(__dirname, "../runtime/python", name),
    path.resolve(__dirname, "../../python", name),
  ];
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const programs = path.join(process.env.LOCALAPPDATA, "Programs", "Python");
    try {
      for (const directory of readdirSync(programs).filter(name => /^Python\d+$/.test(name)).sort().reverse())
        candidates.push(path.join(programs, directory, "python.exe"));
    } catch { /* Continue with system PATH when Python is installed elsewhere. */ }
  }
  const systemPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  for (const directory of systemPath.split(path.delimiter)) {
    if (!directory || hostRuntimePath.test(directory) || /[\\/]WindowsApps(?:[\\/]|$)/i.test(directory)) continue;
    for (const executable of process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"])
      candidates.push(path.resolve(directory, executable));
  }
  return [...new Set(candidates)].filter(candidate => existsSync(candidate) && !hostRuntimePath.test(candidate));
}

function checkEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !/^(?:CODEX(?:_|$)|OPENAI(?:_|$)|ANTHROPIC(?:_|$)|CLAUDE(?:_|$)|CHATGPT(?:_|$)|PYTHON|VISUAL_DESIGN_|NEXIOM_(?:VISUAL_|API_KEY|TEST_API_KEY))/i.test(key),
  ));
  const home = path.join(tmpdir(), "nexiom-visual-design-check");
  mkdirSync(home, { recursive: true });
  for (const key of Object.keys(env))
    if (/^(?:home|userprofile|xdg_config_home|xdg_data_home|xdg_cache_home)$/i.test(key)) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  env.MPLCONFIGDIR = path.join(home, "matplotlib");
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

let cachedStatus: { key: string; time: number; value: Promise<VisualDesignRuntimeStatus> } | undefined;
export async function getVisualDesignRuntimeStatus(): Promise<VisualDesignRuntimeStatus> {
  let root: string;
  try { root = resolveVisualDesignBundle(); }
  catch (error) {
    return { available: false, label: (error as Error).message, python: null, bundleVersion: null, bundleRoot: null };
  }
  const key = `${root}|${process.env.NEXIOM_VISUAL_PYTHON ?? ""}`;
  if (cachedStatus?.key === key && Date.now() - cachedStatus.time < 30_000) return cachedStatus.value;
  const value = probeVisualDesign(root);
  cachedStatus = { key, time: Date.now(), value };
  return value;
}

async function probeVisualDesign(root: string): Promise<VisualDesignRuntimeStatus> {
  const status: VisualDesignRuntimeStatus = {
    available: false, label: "未找到 Python 3.11 及以上版本，请安装可视化运行依赖。",
    python: null, bundleVersion: bundleVersion(root), bundleRoot: root,
  };
  try {
    const candidates = pythonCandidates();
    const env = checkEnvironment();
    const deadline = Date.now() + 25_000;
    for (const python of candidates) {
      if (Date.now() >= deadline) break;
      try {
        const response = await runVisualWorker(python, root, { operation: "check" }, env, undefined, Math.min(20_000, deadline - Date.now()));
        const result = response.result as Record<string, unknown>;
        if (result.available === true || result.status === "ready" || result.ok === true)
          return { ...status, available: true, python, label: "原生图表设计能力已就绪", bundleVersion: typeof result.version === "string" ? result.version : status.bundleVersion };
        status.python ??= python;
        status.label = typeof result.label === "string" ? result.label : "可视化 Python 依赖未安装完整，请按组件说明安装。";
      } catch {
        status.python ??= python;
        status.label = "可视化 Python 依赖检查失败，请确认 Python 3.11 及以上版本和组件依赖。";
      }
    }
  } catch (error) { status.label = (error as Error).message; }
  return status;
}

export interface NativeToolResponse {
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
  success: boolean;
}
export interface NativeToolRegistry {
  specs: Array<Record<string, unknown>>;
  close(): void;
  call(namespace: string, tool: string, arguments_: unknown): Promise<NativeToolResponse>;
}
type WorkerResponse = { ok: boolean; result?: unknown; error?: { message?: string } };

async function terminateWorker(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => execFile("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

async function runVisualWorker(
  python: string, root: string, packet: Record<string, unknown>, env: NodeJS.ProcessEnv,
  signal?: AbortSignal, timeout = 900_000,
): Promise<WorkerResponse> {
  signal?.throwIfAborted();
  const child = spawn(python, ["-I", "-X", "utf8", "-B", "-u", path.join(root, "native.py")], {
    cwd: root, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; void terminateWorker(child); };
    const abort = () => stop(new Error("原生图表设计任务已停止。"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("原生图表设计工具超过运行时限。")), Math.max(1, timeout));
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) stop(new Error("原生图表设计工具输出超过 8 MB。"));
    });
    // Internal diagnostics never enter model context or persisted events.
    child.stderr.resume();
    child.on("error", error => { failure ??= error; });
    child.stdin.on("error", error => { failure ??= error; });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error("原生图表设计进程未能完成，请检查可视化运行环境。")); return; }
      try {
        const response = JSON.parse(stdout.trim()) as WorkerResponse;
        if (!response || typeof response.ok !== "boolean") throw new Error();
        resolve(response);
      } catch { reject(new Error("原生图表设计进程未返回有效结果。")); }
    });
    child.stdin.end(JSON.stringify(packet));
    if (signal?.aborted) abort();
  });
}

export async function createVisualDesignTools(
  input: AgentInput,
  env: NodeJS.ProcessEnv,
  runtimeHome: string,
): Promise<NativeToolRegistry | undefined> {
  if (!supportsVisualWorkspace(input.stageId)) return undefined;
  const status = input.stageId === "chart" ? await getVisualDesignRuntimeStatus() : undefined;
  let pythonDefinitions: VisualNativeDefinition[] = [];
  let pythonFailure = status && !status.available ? status.label : "";
  if (status?.available && status.python && status.bundleRoot) {
    try {
      const catalog = JSON.parse(readFileSync(path.join(status.bundleRoot, "native-tools.json"), "utf8"));
      pythonDefinitions = catalog.tools as VisualNativeDefinition[];
    } catch {
      pythonFailure = "内置模板工具目录不可用，请检查可视化组件。";
    }
  }
  const definitions = [...visualWorkspaceDefinitions, ...pythonDefinitions];
  const allowed = new Set(definitions.filter(tool => input.mode === "execute" || tool.readOnly === true).map(tool => tool.name));
  const workspaceTools = new Set(visualWorkspaceDefinitions.map(tool => tool.name));
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const cache = path.join(runtimeHome, "visual-design", "matplotlib");
  if (pythonDefinitions.length) mkdirSync(cache, { recursive: true });
  const workerEnv = { ...env, MPLCONFIGDIR: cache };
  const clean = (value: string): string => {
    if (!input.apiKey) return value;
    return value.split(input.apiKey).join("[密钥已隐藏]")
      .split(JSON.stringify(input.apiKey).slice(1, -1)).join("[密钥已隐藏]");
  };
  return {
    close() { lifetime.abort(); },
    specs: [{ type: "namespace", name: "nexiom_visual", description: `NEXIOM 原生可视化：建模过程与论文论述素材库、语义元素、配色和结构编辑。${pythonFailure ? `模板渲染暂不可用：${pythonFailure} 结构化素材工具仍可使用。` : ""}`, tools: definitions.map(tool => ({
      type: "function", name: tool.name, description: `${tool.description}${tool.readOnly ? "" : " 仅执行模式可调用；规划模式禁止写入。"}`, inputSchema: tool.inputSchema, deferLoading: false,
    })) }],
    async call(namespace, tool, arguments_) {
      if (namespace !== "nexiom_visual" || !allowed.has(tool))
        return { success: false, contentItems: [{ type: "inputText", text: "当前模式未授权或未提供此原生图表设计工具。规划模式只允许读取。" }] };
      let response: WorkerResponse;
      try {
        signal.throwIfAborted();
        if (workspaceTools.has(tool)) {
          response = { ok: true, result: await callVisualWorkspaceTool(input.cwd, tool, arguments_) };
        } else {
          if (!status?.python || !status.bundleRoot) throw new Error(pythonFailure || "模板渲染运行环境不可用。");
          response = await runVisualWorker(status.python, status.bundleRoot, {
            operation: "call", name: tool, arguments: arguments_, projectRoot: input.cwd,
            mode: input.mode, network: input.mode === "execute" && input.settings.network,
            runsDir: path.join(input.cwd, "outputs", "visual-design"),
            provider: {
              id: input.provider.id, name: input.provider.name, endpoint: input.provider.endpoint,
              model: input.provider.model, auth: input.provider.auth,
              ...(input.provider.auth === "bearer" && input.apiKey ? { apiKey: input.apiKey } : {}),
            },
          }, workerEnv, signal);
        }
      } catch (error) {
        response = { ok: false, error: { message: (error as Error).message } };
      }
      if (!response.ok) return { success: false, contentItems: [{ type: "inputText", text: clean(response.error?.message ?? "原生图表设计工具执行失败。") }] };
      const result = response.result as Record<string, unknown> | null;
      const contentItems: NativeToolResponse["contentItems"] = [];
      if (result && typeof result === "object" && Array.isArray(result.contentItems)) {
        for (const item of result.contentItems) {
          if (item?.type === "inputImage" && typeof item.imageUrl === "string" && /^data:image\/(?:png|jpeg|webp);base64,/.test(item.imageUrl) && item.imageUrl.length < 3 * 1024 * 1024)
            contentItems.push({ type: "inputImage", imageUrl: item.imageUrl });
        }
        const { contentItems: _images, ...metadata } = result;
        contentItems.unshift({ type: "inputText", text: clean(JSON.stringify(metadata)) });
      } else contentItems.push({ type: "inputText", text: clean(JSON.stringify(response.result) ?? "null") });
      if (Buffer.byteLength(JSON.stringify(contentItems)) > 3 * 1024 * 1024)
        return { success: false, contentItems: [{ type: "inputText", text: "原生图表设计结果超过 3 MB，请缩小本次查询或图像范围。" }] };
      return { success: true, contentItems };
    },
  };
}

