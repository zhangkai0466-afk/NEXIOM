import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AgentRunner, AgentInput, ThreadEvent } from "./index";
import type { ModelProvider, RuntimeState } from "../contracts";
import { runAppServer } from "./app-server";
import { createVisualDesignTools, visualDesignInstructions } from "./visual-design";
import { supportsVisualWorkspace } from "./visual-workspace-tools";
import { createReadingTools, readingWebSearchMode } from "./reading-tools";
import { readingWorkflowInstructions } from "../contracts/reading-workflow";
import { createAttachmentTools } from "./attachment-tools";
import { attachmentWorkflowInstructions } from "../contracts/attachment-workflow";
export { getVisualDesignRuntimeStatus, createVisualDesignTools, resolveVisualDesignBundle } from "./visual-design";

const execute = promisify(execFile);
const instructions = `你是 NEXIOM，服务于全国大学生数学建模竞赛的桌面 Agent。使用中文与用户协作。
对问候和简单交流自然简短地回答。只有需要实际操作文件或工具的任务，才先说明简短行动计划，随后完成任务并验证；最终给出结果、文件路径、验证与未解决项。
数学结论必须来自实际推导或实验；不得编造数据、实验成绩或文献。区分假设、计算结果和已核实事实。
只操作用户选定的当前项目，附件默认在 inputs/。不要读取凭证或与任务无关的个人文件。不要自动提交、上传或推送。
根据用户目标自主判断需要讨论、读取、写入或运行工具，并完成必要验证；无需要求用户切换工作模式。缺少依赖时说明情况，不自动安装系统软件。
不加载其他应用或父目录的 AGENTS.md、全局提示词、配置和技能。用户可见内容只包含必要的工具动作和结论，不输出隐藏思维链。数学公式使用 Markdown 的 $...$ 或 $$...$$ 分隔符。`;

export function resolveCodexBinary(): { executable: string; pathDir: string } {
  const platform =
    process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "win32" ? "pc-windows-msvc" : platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const name = platform === "win32" ? "codex.exe" : "codex";
  const roots = [
    path.resolve(__dirname, "../../codex"),
    path.resolve(
      __dirname,
      `../node_modules/@openai/codex-${platform}-${process.arch}/vendor/${triple}`,
    ),
  ];
  if (process.env.NEXIOM_CODEX_PATH) {
    const executable = path.resolve(process.env.NEXIOM_CODEX_PATH);
    if (!existsSync(executable)) throw new Error("指定的 Codex 引擎不存在。");
    return {
      executable,
      pathDir: path.join(path.dirname(executable), "../codex-path"),
    };
  }
  for (const root of roots) {
    const executable = path.join(root, "bin", name);
    if (existsSync(executable))
      return { executable, pathDir: path.join(root, "codex-path") };
  }
  throw new Error("未找到 Codex 核心，请重新安装 NEXIOM 或运行 npm install。");
}
export function redact(text: string, secrets: Iterable<string> = []): string {
  let redacted = text;
  const exactSecrets = [...new Set(secrets)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of exactSecrets)
    redacted = redacted.split(secret).join("[密钥已隐藏]");
  return redacted
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[密钥已隐藏]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[已隐藏]");
}

export function secretRedactionVariants(secret?: string): string[] {
  if (!secret) return [];
  const encoded = JSON.stringify(secret).slice(1, -1);
  return encoded === secret ? [secret] : [secret, encoded];
}

export function runtimeEnvironment(pathDir: string, runtimeHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(?:CODEX(?:_|$)|OPENAI(?:_|$)|ANTHROPIC(?:_|$)|CLAUDE(?:_|$)|CHATGPT(?:_|$)|PYTHON|VISUAL_DESIGN_|NEXIOM_(?:VISUAL_|API_KEY|TEST_API_KEY))/i.test(entry[0]),
    ),
  );
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const hostRuntimePath = /(?:^|[\\/])(?:\.codex|codex-runtimes)(?:[\\/]|$)|[\\/]OpenAI[\\/]Codex[\\/]/i;
  const systemPath = (env[pathKey] ?? "").split(path.delimiter)
    .filter(entry => entry && !hostRuntimePath.test(entry));
  env[pathKey] = [pathDir, ...systemPath].join(path.delimiter);
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "psmodulepath")
      env[key] = env[key]?.split(path.delimiter)
        .filter(entry => entry && !hostRuntimePath.test(entry)).join(path.delimiter);
    if (key.toLowerCase() === "shell" && hostRuntimePath.test(env[key] ?? ""))
      delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  // Home discovery must never find the host application's auth, instructions,
  // skills or sessions, including when NEXIOM is launched from that application.
  const home = path.join(runtimeHome, "home");
  mkdirSync(home, { recursive: true });
  for (const key of Object.keys(env))
    if (/^(?:home|userprofile|xdg_config_home|xdg_data_home|xdg_cache_home)$/i.test(key))
      delete env[key];
  env.CODEX_HOME = runtimeHome;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  return env;
}

function requireIndependentProvider(provider: ModelProvider): void {
  if (provider.kind !== "responses")
    throw new Error("NEXIOM 仅使用自己配置的 API 供应商，请在设置中配置 API 地址、模型和凭证。");
}

function providerUrl(provider: ModelProvider, resource: string): URL {
  const base = new URL(provider.endpoint);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "API 地址必须是不含凭证、查询参数或片段的 HTTP(S) 根地址。",
    );
  if (/\/(?:models|responses)\/?$/i.test(base.pathname))
    throw new Error(
      "API 地址应填写根地址（通常以 /v1 结尾），不要包含 /models 或 /responses。",
    );
  const path = base.pathname.replace(/\/+$/, "") + "/";
  base.pathname = path;
  return new URL(resource, base);
}

async function responseText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > limit) throw new Error("模型列表响应超过 2 MB。");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("模型列表响应超过 2 MB。");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function responseModels(
  provider: ModelProvider,
  apiKey?: string,
): Promise<string[]> {
  if (provider.auth === "bearer" && !apiKey)
    throw new Error("此供应商尚未配置 API Key。");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider.auth === "bearer") headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(providerUrl(provider, "models"), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new Error("模型接口返回重定向，已阻止携带凭证跳转。");
  if (!response.ok) {
    const detail = redact(
      (await responseText(response, 2 * 1024 * 1024)).slice(0, 500),
      secretRedactionVariants(apiKey),
    );
    throw new Error(
      `模型接口返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`,
    );
  }
  const text = await responseText(response, 2 * 1024 * 1024);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("模型接口没有返回有效 JSON。");
  }
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const data = Array.isArray(record.data)
    ? record.data
    : Array.isArray(body)
      ? body
      : [];
  const models = data
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const value = item as Record<string, unknown>;
        return typeof value.id === "string"
          ? value.id
          : typeof value.model === "string"
            ? value.model
            : "";
      }
      return "";
    })
    .filter(
      (model) =>
        Boolean(model) &&
        !secretRedactionVariants(apiKey).some((secret) =>
          model.includes(secret),
        ),
    );
  const unique = [...new Set(models)].sort((a, b) => a.localeCompare(b));
  if (!unique.length) throw new Error("模型接口返回成功，但没有可用模型。");
  return unique;
}

export function applyProviderRuntime(
  provider: ModelProvider,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv,
  config: Record<string, unknown>,
) {
  requireIndependentProvider(provider);
  delete env.NEXIOM_API_KEY;
  if (provider.auth === "bearer" && !apiKey)
    throw new Error("尚未配置 API Key。");
  config.model_provider = "nexiom";
  providerUrl(provider, "responses");
  config.model_providers = {
    nexiom: {
      name: provider.name,
      base_url: provider.endpoint,
      ...(provider.auth === "bearer"
        ? { experimental_bearer_token: apiKey }
        : {}),
      wire_api: "responses",
      requires_openai_auth: false,
    },
  };
}

export class CodexRuntime implements AgentRunner {
  private readonly runtimeHome: string;
  constructor(options: { runtimeHome: string }) {
    if (!options?.runtimeHome || !path.isAbsolute(options.runtimeHome))
      throw new Error("NEXIOM 运行目录必须是独立的绝对路径。");
    this.runtimeHome = path.resolve(options.runtimeHome);
    mkdirSync(this.runtimeHome, { recursive: true });
  }
  async probe(provider: ModelProvider, apiKey?: string): Promise<RuntimeState> {
    let binary: ReturnType<typeof resolveCodexBinary>;
    let version = "";
    try {
      requireIndependentProvider(provider);
      binary = resolveCodexBinary();
      version = (
        await execute(binary.executable, ["--version"], {
          timeout: 10000,
          windowsHide: true,
          env: runtimeEnvironment(binary.pathDir, this.runtimeHome),
          cwd: this.runtimeHome,
        })
      ).stdout.trim();
    } catch (error) {
      return {
        connected: false,
        available: false,
        authenticated: false,
        label: redact(
          (error as Error).message,
          secretRedactionVariants(apiKey),
        ),
        version: "",
        hasApiKey: !!apiKey,
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: provider.model,
        activeModelProvider: provider.kind === "responses" ? "nexiom" : "",
      };
    }
    try {
      await responseModels(provider, apiKey);
      const authenticated = provider.auth === "none" || !!apiKey;
      const connected = authenticated && Boolean(provider.model.trim());
      return {
        connected,
        available: true,
        authenticated,
        label: connected
          ? `${provider.name} 已就绪`
          : authenticated
            ? `${provider.name} 需要填写模型 ID`
          : `${provider.name} 需要配置凭证`,
        version,
        hasApiKey: !!apiKey,
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: provider.model,
        activeModelProvider: "nexiom",
      };
    } catch (error) {
      return {
        connected: false,
        available: true,
        authenticated: false,
        label: redact(
          (error as Error).message,
          secretRedactionVariants(apiKey),
        ),
        version,
        hasApiKey: !!apiKey,
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: provider.model,
        activeModelProvider: provider.kind === "responses" ? "nexiom" : "",
      };
    }
  }
  async listModels(provider: ModelProvider, apiKey?: string): Promise<string[]> {
    requireIndependentProvider(provider);
    return responseModels(provider, apiKey);
  }
  async *run(input: AgentInput): AsyncIterable<ThreadEvent> {
    requireIndependentProvider(input.provider);
    if (!input.provider.model.trim()) throw new Error("请先配置模型 ID。");
    const binary = resolveCodexBinary();
    const env = runtimeEnvironment(binary.pathDir, this.runtimeHome);
    const config: Record<string, unknown> = {
      show_raw_agent_reasoning: false,
      model_reasoning_summary: "none",
      project_doc_max_bytes: 0,
      cli_auth_credentials_store: "ephemeral",
      sqlite_home: this.runtimeHome,
      log_dir: path.join(this.runtimeHome, "log"),
      "shell_environment_policy.experimental_use_profile": false,
      ...(process.platform === "win32" ? { "windows.sandbox": "unelevated" } : {}),
      web_search: readingWebSearchMode(input),
      "sandbox_workspace_write.network_access": input.settings.network,
    };
    applyProviderRuntime(input.provider, input.apiKey, env, config);
    const nativeTools = createReadingTools(input) ?? createAttachmentTools(input) ?? await createVisualDesignTools(input, env, this.runtimeHome);
    // Keep the stable application contract in baseInstructions only. Repeating it
    // here changes and lengthens the rendered prefix without adding behavior.
    const developerInstructions =
      (supportsVisualWorkspace(input.stageId) ? visualDesignInstructions : "") +
      (input.attachmentTarget ? `\n\n${attachmentWorkflowInstructions}` : "") +
      (input.stageId === "reading" ? `\n\n${readingWorkflowInstructions}\n文献联网检索：${input.settings.network ? "已允许，使用 web_search 实际检索并核对原文。如果供应商不支持或检索失败，报告限制，不伪造结果。" : "未允许。不得绕过联网设置；将需要的来源和查询词列为待核对，不得声称已完成文献核验。"}` : "") +
      (input.stageId === "model" ? "\n\n建模阶段用户提出的是想法分享与共同讨论。评估其依据、适用条件和取舍；不要将所有人类建议称为人工纠偏，不要未经讨论就改写已确认的题意口径。" : "") +
      (input.projectMemory
        ? `\n\n以下是用户维护的项目记忆，作为当前任务背景；与本轮用户要求冲突时以本轮要求为准。不要自动修改此文档。\n<project_memory>\n${input.projectMemory}\n</project_memory>`
        : "");
    yield* runAppServer({
      executable: binary.executable,
      env,
      input,
      config,
      nativeTools,
      developerInstructions: developerInstructions || undefined,
      baseInstructions: instructions,
      runtimeHome: this.runtimeHome,
    });
  }
}
