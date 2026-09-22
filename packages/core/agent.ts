import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  settingsSchema,
  type AgentSettings,
  type AgentItem,
  type RuntimeState,
  type Command,
  type ThreadContext,
  type ModelProvider,
  type ProviderCheck,
  type ProviderDraft,
  type ThreadStage,
} from "../contracts";
import {
  redact,
  secretRedactionVariants,
} from "../runtime/codex";
import type { AgentRunner } from "../runtime";
import { VISUAL_DESIGN_CAPABILITY_VERSION } from "../runtime/visual-design";
import { READING_WORKFLOW_VERSION } from "../contracts/reading-workflow";
import { ATTACHMENT_ANALYSIS_LIMIT, ATTACHMENT_WORKFLOW_VERSION, ATTACHMENT_TASK_MARKER, ATTACHMENT_CORRECTION_MARKER, attachmentTargets, attachmentTargetPrompt, parseAttachmentStage, parseAttachmentReports, type AttachmentTarget } from "../contracts/attachment-workflow";
import { readProjectMemory } from "./memory";
import { StreamCheckpoint } from "./stream-checkpoint";
import { registerGeneratedFiles } from "../filesystem/generated-files";
import type { TokenActivityLedger } from "./token-activity";

type Submit = Extract<Command, { type: "agent.submit" }>;
type ProviderUpsert = Extract<Command, { type: "provider.upsert" }>;
type ModelingContext = {
  project: { id: string; name: string };
  question: { id: string; name: string } | null;
  stage: { id: ThreadStage; name: string };
  threadId: string;
};
const stageNames: Record<ThreadStage, string> = {
  overview: "项目总览",
  reading: "赛题研读",
  attachments: "附件分析",
  model: "开始建模",
  validation: "模型检验",
  chart: "图表设计",
  paper: "论文写作",
  delivery: "检查交付",
};
type Hooks = {
  notify(options?: { deferProjectRecord?: boolean }): void;
  changed(projectId: string): void;
  event(
    projectId: string,
    type: string,
    summary: string,
    runId?: string | null,
  ): number;
  message(
    threadId: string,
    role: "user" | "assistant",
    kind: "note" | "progress" | "answer",
    text: string,
  ): void;
  transaction<T>(fn: () => T): T;
};
const now = () => new Date().toISOString();
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AgentCoordinator {
  settings: AgentSettings;
  state: RuntimeState = {
    connected: false,
    available: false,
    authenticated: false,
    label: "请配置 NEXIOM 的模型和 API Key",
    version: "",
    hasApiKey: false,
    activeProviderId: "nexiom-default",
    activeProviderName: "NEXIOM API",
    activeModel: "",
    activeModelProvider: "",
  };
  private active = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  private secrets = new Map<string, string>();
  private probeGeneration = 0;
  constructor(
    private db: DatabaseSync,
    private hooks: Hooks,
    private runner: AgentRunner,
    private tokenActivity?: TokenActivityLedger,
  ) {
    const saved = db
      .prepare("SELECT value FROM settings WHERE key='agent'")
      .get();
    this.settings = settingsSchema.parse(
      saved ? JSON.parse(String(saved.value)) : {},
    );
    const provider = this.provider(this.settings.activeProviderId);
    this.state = {
      ...this.state,
      activeProviderId: provider.id,
      activeProviderName: provider.name,
      activeModel: provider.model,
      activeModelProvider: "nexiom",
      label: this.configurationIssue(provider) || `正在检测 ${provider.name}`,
    };
  }
  setSecrets(secrets: Record<string, string>) {
    const activeProviderId = this.settings.activeProviderId;
    const previous = this.secrets.get(activeProviderId);
    const providerIds = new Set(this.providers().map((provider) => provider.id));
    this.secrets = new Map(
      Object.entries(secrets).filter(
        (entry): entry is [string, string] =>
          providerIds.has(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1]),
      ),
    );
    const current = this.secrets.get(activeProviderId);
    this.state.hasApiKey = Boolean(current);
    if (previous !== current) {
      ++this.probeGeneration;
      this.state.connected = false;
      this.state.authenticated = false;
      this.state.label = "模型凭证已更新，请重新检测连接";
    }
    this.hooks.notify();
  }
  providers(): ModelProvider[] {
    return this.db
      .prepare("SELECT * FROM model_providers ORDER BY createdAt, name")
      .all()
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        kind: String(row.kind) as ModelProvider["kind"],
        endpoint: String(row.endpoint),
        modelName: String(row.modelName),
        model: String(row.model),
        auth: String(row.auth) as ModelProvider["auth"],
        revision: Number(row.revision),
        hasApiKey: this.secrets.has(String(row.id)),
        createdAt: String(row.createdAt),
        updatedAt: String(row.updatedAt),
      }));
  }
  private provider(id: string): ModelProvider {
    if (id === "local-codex")
      throw new Error("不再支持本机 Codex 配置，请配置 NEXIOM 独立的模型和 API Key。");
    const provider = this.providers().find((item) => item.id === id);
    if (!provider) throw new Error("模型供应商不存在。");
    return provider;
  }
  private supportedProvider(id: string): ModelProvider {
    const provider = this.provider(id);
    this.validateProvider(provider);
    return provider;
  }
  private configurationIssue(provider: ModelProvider, requireModel = true) {
    if (requireModel && !provider.model)
      return "请在设置中填写 NEXIOM 的模型 ID。";
    if (provider.auth === "bearer" && !this.secrets.get(provider.id))
      return "请在设置中填写 NEXIOM 的 API Key。";
    return "";
  }
  private async probe(provider: ModelProvider): Promise<RuntimeState> {
    const issue = this.configurationIssue(provider);
    if (issue)
      return {
        connected: false,
        available: false,
        authenticated: false,
        label: issue,
        version: "",
        hasApiKey: this.secrets.has(provider.id),
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: provider.model,
        activeModelProvider: "nexiom",
      };
    return this.runner.probe(provider, this.secrets.get(provider.id));
  }
  private publicModels(models: string[], apiKey?: string): string[] {
    const secrets = secretRedactionVariants(apiKey);
    return [...new Set(models)].filter(
      (model) =>
        typeof model === "string" &&
        Boolean(model) &&
        !secrets.some((secret) => model.includes(secret)),
    );
  }
  async check() {
    const generation = ++this.probeGeneration;
    const provider = this.supportedProvider(this.settings.activeProviderId);
    const apiKey = this.secrets.get(provider.id);
    const state = await this.probe(provider);
    this.applyProbe(provider, apiKey, state, generation);
  }
  private applyProbe(
    provider: ModelProvider,
    apiKey: string | undefined,
    state: RuntimeState,
    generation: number,
  ) {
    if (generation === this.probeGeneration) {
      const secrets = secretRedactionVariants(apiKey);
      this.state = {
        ...state,
        label: redact(state.label, secrets),
        version: redact(state.version, secrets),
        hasApiKey: Boolean(apiKey),
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: redact(provider.model, secrets),
        activeModelProvider: "nexiom",
      };
      this.hooks.notify();
    }
  }
  async configure(settings: AgentSettings) {
    if (this.active.size) throw new Error("请先停止当前任务，再修改模型设置。");
    this.supportedProvider(settings.activeProviderId);
    this.db
      .prepare(
        "INSERT INTO settings VALUES ('agent', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(settings));
    this.settings = settings;
    await this.check();
  }
  private validateProvider(draft: ProviderDraft) {
    if (draft.kind !== "responses")
      throw new Error("请配置 NEXIOM 独立的 Responses API；不再支持本机 Codex 配置。");
    if (draft.auth !== "bearer" && draft.auth !== "none")
      throw new Error("模型供应商的鉴权方式不受支持。");
    let endpoint: URL;
    try {
      endpoint = new URL(draft.endpoint);
    } catch {
      throw new Error("请输入有效的 Responses API 地址。");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        "API 地址必须是不含凭证、查询参数或片段的 HTTP(S) 根地址。",
      );
    if (/\/(?:models|responses)\/?$/i.test(endpoint.pathname))
      throw new Error(
        "API 地址应填写根地址（通常以 /v1 结尾），不要包含 /models 或 /responses。",
      );
    return {
      ...draft,
      endpoint: draft.endpoint.replace(/\/+$/, ""),
      modelName: draft.modelName.trim() || draft.model.trim(),
    };
  }
  upsertProvider(command: ProviderUpsert): ModelProvider {
    if (this.active.size) throw new Error("请先停止当前任务，再修改模型供应商。");
    if (command.apiKey && command.clearApiKey)
      throw new Error("不能同时更新和清除 API Key。");
    const existing = command.provider.id
      ? this.providers().find((item) => item.id === command.provider.id)
      : undefined;
    if (command.provider.id && !existing && !uuidPattern.test(command.provider.id))
      throw new Error("新模型供应商标识无效。");
    const id = existing?.id ?? command.provider.id ?? randomUUID();
    const value = this.validateProvider(command.provider);
    const runtimeChanged = !existing ||
      existing.kind !== value.kind ||
      existing.endpoint !== value.endpoint ||
      existing.model !== value.model ||
      existing.auth !== value.auth ||
      Boolean(command.apiKey) ||
      command.clearApiKey;
    const revision = existing
      ? existing.revision + (runtimeChanged ? 1 : 0)
      : 1;
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO model_providers
          (id,name,kind,endpoint,modelName,model,auth,revision,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,kind=excluded.kind,endpoint=excluded.endpoint,
          modelName=excluded.modelName,model=excluded.model,auth=excluded.auth,
          revision=excluded.revision,updatedAt=excluded.updatedAt`,
      )
      .run(
        id,
        value.name,
        value.kind,
        value.endpoint,
        value.modelName,
        value.model,
        value.auth,
        revision,
        existing?.createdAt ?? timestamp,
        timestamp,
      );
    if (command.clearApiKey) this.secrets.delete(id);
    else if (command.apiKey) this.secrets.set(id, command.apiKey);
    const provider = this.provider(id);
    if (id === this.settings.activeProviderId && runtimeChanged) {
      ++this.probeGeneration;
      this.state = {
        connected: false,
        available: true,
        authenticated: false,
        label: `${provider.name} 配置已更新，请重新检测`,
        version: this.state.version,
        hasApiKey: provider.hasApiKey,
        activeProviderId: provider.id,
        activeProviderName: provider.name,
        activeModel: provider.model,
        activeModelProvider: "nexiom",
      };
    } else if (id === this.settings.activeProviderId) {
      this.state = {
        ...this.state,
        activeProviderName: provider.name,
        activeModel: provider.model,
      };
    }
    this.hooks.notify();
    return provider;
  }
  deleteProvider(providerId: string) {
    if (this.active.size) throw new Error("请先停止当前任务，再删除模型供应商。");
    if (providerId === this.settings.activeProviderId)
      throw new Error("请先启用其他供应商，再删除当前供应商。");
    if (!this.provider(providerId)) return;
    this.db.prepare("DELETE FROM model_providers WHERE id=?").run(providerId);
    this.secrets.delete(providerId);
    this.hooks.notify();
  }
  async activateProvider(providerId: string) {
    if (this.active.size) throw new Error("请先停止当前任务，再切换模型供应商。");
    this.supportedProvider(providerId);
    this.settings = { ...this.settings, activeProviderId: providerId };
    this.db
      .prepare(
        "INSERT INTO settings VALUES ('agent', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(this.settings));
    await this.check();
  }
  async listProviderModels(providerId: string) {
    const provider = this.supportedProvider(providerId);
    const issue = this.configurationIssue(provider, false);
    if (issue) throw new Error(issue);
    const apiKey = this.secrets.get(providerId);
    return this.publicModels(
      await this.runner.listModels(provider, apiKey),
      apiKey,
    );
  }
  async testProvider(providerId: string): Promise<ProviderCheck> {
    const provider = this.supportedProvider(providerId);
    const apiKey = this.secrets.get(providerId);
    const generation = providerId === this.settings.activeProviderId
      ? ++this.probeGeneration
      : undefined;
    const started = Date.now();
    const state = await this.probe(provider);
    if (generation !== undefined)
      this.applyProbe(provider, apiKey, state, generation);
    let models: string[] = [];
    if (state.connected) {
      try {
        models = this.publicModels(
          await this.runner.listModels(provider, apiKey),
          apiKey,
        );
      } catch {
        // Probe already provides the actionable connection result.
      }
    }
    return {
      providerId,
      ok: state.connected,
      label: redact(state.label, secretRedactionVariants(apiKey)),
      latencyMs: Date.now() - started,
      models,
      checkedAt: now(),
    };
  }
  items(): AgentItem[] {
    return this.db
      .prepare("SELECT * FROM agent_items ORDER BY sequence")
      .all()
      .map((row) => ({
        id: String(row.id),
        runId: String(row.runId),
        threadId: String(row.threadId),
        sequence: Number(row.sequence),
        status: String(row.status),
        item: JSON.parse(String(row.payload)),
        updatedAt: String(row.updatedAt),
      }));
  }
  contexts(): ThreadContext[] {
    return this.db
      .prepare("SELECT payload FROM agent_contexts")
      .all()
      .map((row) => JSON.parse(String(row.payload)));
  }
  private context(threadId: string, patch: Partial<ThreadContext>) {
    const row = this.db
      .prepare("SELECT payload FROM agent_contexts WHERE threadId=?")
      .get(threadId);
    const current: ThreadContext = row
      ? JSON.parse(String(row.payload))
      : {
          threadId,
          engine: "codex",
          transport: "app-server",
          engineThreadId: "",
          modelContextWindow: null,
          totalTokens: null,
          lastInputTokens: null,
          lastOutputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          compactions: 0,
          updatedAt: now(),
        };
    const next = { ...current, ...patch, updatedAt: now() };
    this.db
      .prepare(
        "INSERT INTO agent_contexts VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET payload=excluded.payload",
      )
      .run(threadId, JSON.stringify(next));
  }
  start(command: Submit, projectRoot: string): string {
    const digest = createHash("sha256")
      .update(JSON.stringify([command.threadId, command.text]))
      .digest("hex");
    const existing = this.db
      .prepare("SELECT * FROM agent_requests WHERE id=?")
      .get(command.clientRequestId);
    if (existing) {
      if (existing.digest !== digest) throw new Error("重复请求的内容不一致。");
      return String(existing.runId);
    }
    const thread = this.db
      .prepare(
        "SELECT threads.*, projects.root, projects.name AS projectName, questions.name AS questionName FROM threads JOIN projects ON projects.id=threads.projectId LEFT JOIN questions ON questions.id=threads.questionId AND questions.projectId=threads.projectId WHERE threads.id=?",
      )
      .get(command.threadId);
    if (!thread) throw new Error("会话不存在。");
    const stageId = String(thread.stageId) as ThreadStage;
    const targets = stageId === "attachments" ? attachmentTargets(command.text) : [];
    if (targets.length > ATTACHMENT_ANALYSIS_LIMIT || new Set(targets.map(target => target.id)).size !== targets.length ||
        new Set(targets.map(target => target.path)).size !== targets.length)
      throw new Error("附件清单重复或超过单次分析上限。");
    const modelingContext: ModelingContext = {
      project: { id: String(thread.projectId), name: String(thread.projectName) },
      question: thread.questionId && thread.questionName
        ? { id: String(thread.questionId), name: String(thread.questionName) }
        : null,
      stage: { id: stageId, name: stageNames[stageId] },
      threadId: command.threadId,
    };
    if (
      this.db
        .prepare("SELECT id FROM runs WHERE projectId=? AND status='running'")
        .get(thread.projectId)
    )
      throw new Error("此项目已有任务正在执行。");
    if (!this.state.connected)
      throw new Error("NEXIOM 尚未连接模型，请在设置中配置独立的模型和 API Key。");
    const runId = randomUUID();
    const settings = { ...this.settings };
    const provider = this.supportedProvider(settings.activeProviderId);
    const issue = this.configurationIssue(provider);
    if (issue) throw new Error(issue);
    if (this.state.activeProviderId !== provider.id)
      throw new Error("当前模型连接状态已过期，请重新检测连接。");
    const resolvedModel = provider.model;
    const resolvedModelProvider = "nexiom";
    if (!resolvedModel || !resolvedModelProvider)
      throw new Error("无法确定本次运行使用的模型和供应商，请重新检测连接。");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          "nexiom-private-v1",
          provider.id,
          provider.revision,
          provider.kind,
          provider.endpoint,
          provider.model,
          provider.auth,
          ...(["model", "chart", "paper"].includes(stageId) ? [VISUAL_DESIGN_CAPABILITY_VERSION] : []),
          ...(stageId === "reading" ? [READING_WORKFLOW_VERSION, settings.network] : []),
          ...(stageId === "attachments" ? [ATTACHMENT_WORKFLOW_VERSION] : []),
        ]),
      )
      .digest("hex");
    const binding = this.db
      .prepare(
        "SELECT * FROM agent_threads WHERE threadId=? AND fingerprint=?",
      )
      .get(command.threadId, fingerprint);
    const memory = readProjectMemory({
      id: String(thread.projectId),
      root: projectRoot,
      name: "",
      createdAt: "",
    });
    this.hooks.transaction(() => {
      this.db
        .prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, NULL)")
        .run(runId, command.threadId, thread.projectId, "running", now());
      this.db
        .prepare(
          "INSERT INTO agent_runs (runId,mode,usage,providerId,providerFingerprint,runtimeConfig) VALUES (?, ?, NULL, ?, ?, ?)",
        )
        .run(
          runId,
          "execute",
          provider.id,
          fingerprint,
          JSON.stringify({
            provider: {
              id: provider.id,
              name: provider.name,
              kind: provider.kind,
              endpoint: provider.endpoint,
              model: provider.model,
              auth: provider.auth,
              revision: provider.revision,
            },
            resolvedModel,
            resolvedModelProvider,
            effort: settings.effort,
            network: settings.network,
            modelingContext,
            cacheThreadState: binding ? "continuation" : "new_thread",
          }),
        );
      this.db
        .prepare("INSERT INTO agent_requests VALUES (?, ?, ?)")
        .run(command.clientRequestId, digest, runId);
      this.db.prepare("UPDATE agent_runs SET activityId=? WHERE runId=?").run(runId, runId);
      this.tokenActivity?.recordRun(runId);
      this.hooks.message(command.threadId, "user", "note", command.text);
      if (thread.title === "新会话" || thread.title === "研究笔记")
        this.db
          .prepare("UPDATE threads SET title=? WHERE id=?")
          .run(command.text.slice(0, 24), command.threadId);
      this.hooks.event(
        String(thread.projectId),
        "agent.started",
        "开始任务",
        runId,
      );
      if (memory.text)
        this.hooks.event(
          String(thread.projectId),
          "memory.loaded",
          `项目记忆 ${memory.revision.slice(0, 12)} 已载入。`,
          runId,
        );
    });
    const abort = new AbortController();
    const promise = this.perform({
      command,
      runId,
      projectId: String(thread.projectId),
      cwd: projectRoot,
      engineThreadId: binding ? String(binding.engineThreadId) : undefined,
      fingerprint,
      settings,
      provider,
      resolvedModelProvider,
      apiKey: this.secrets.get(provider.id),
      abort,
      projectMemory: memory.text,
      modelingContext,
    });
    this.active.set(runId, { abort, promise });
    void promise.finally(() => this.active.delete(runId));
    this.hooks.notify();
    return runId;
  }
  cancel(runId: string) {
    const active = this.active.get(runId);
    if (active) active.abort.abort();
    return !!active;
  }
  private previousAttachmentReport(threadId: string, target: AttachmentTarget) {
    const start = this.db.prepare("SELECT sequence, text FROM messages WHERE threadId=? AND role='user' AND substr(text,1,?)=? ORDER BY sequence DESC LIMIT 1")
      .get(threadId, ATTACHMENT_TASK_MARKER.length, ATTACHMENT_TASK_MARKER);
    if (!start || !attachmentTargets(String(start.text)).some(entry => entry.id === target.id && entry.path === target.path)) return;
    let body: string | undefined;
    const records = this.db.prepare("SELECT runId, payload FROM agent_items WHERE threadId=? AND sequence>? AND status='completed' ORDER BY sequence")
      .all(threadId, Number(start.sequence)).map(row => ({ runId: String(row.runId), item: JSON.parse(String(row.payload)) as AgentItem["item"] }));
    const structuredRuns = new Set(records.filter(({ item }) => item.type === "native_tool_call" && item.namespace === "nexiom_attachments" && item.tool === "begin_attachment").map(record => record.runId));
    for (const { runId, item } of records) {
      if (item.type === "native_tool_call" && item.namespace === "nexiom_attachments" && item.tool === "publish_attachment_report" &&
          !item.error && (item.result as { accepted?: boolean } | undefined)?.accepted === true) {
        const data = item.arguments as Record<string, unknown>;
        if (data.attachmentId === target.id && typeof data.body === "string") body = data.body;
      } else if (item.type === "agent_message" && !structuredRuns.has(runId)) {
        body = parseAttachmentReports(item.text).find(report => report.id === target.id)?.body ?? body;
      }
    }
    return body;
  }
  private async perform(input: {
    command: Submit;
    runId: string;
    projectId: string;
    cwd: string;
    engineThreadId?: string;
    fingerprint: string;
    settings: AgentSettings;
    provider: ModelProvider;
    resolvedModelProvider: string;
    apiKey?: string;
    abort: AbortController;
    projectMemory: string;
    modelingContext: ModelingContext;
  }) {
    const { command, runId, projectId, abort, settings } = input;
    let completed = false;
    let usage: Extract<import("../runtime").ThreadEvent, { type: "turn.completed" }>["usage"] = null;
    let usageIncomplete = false;
    let nativeTurn: { threadId: string; turnId: string } | undefined;
    const checkpoint = new StreamCheckpoint((events) => {
      this.hooks.transaction(() => {
        for (const event of events) {
          if (event.type === "thread.started") {
            this.db
              .prepare(
                "INSERT INTO agent_threads (threadId,engineThreadId,fingerprint) VALUES (?, ?, ?) ON CONFLICT(threadId,fingerprint) DO UPDATE SET engineThreadId=excluded.engineThreadId",
              )
              .run(command.threadId, event.thread_id, input.fingerprint);
            const previous = this.contexts().find(
              (context) => context.threadId === command.threadId,
            );
            this.context(command.threadId, {
              engineThreadId: event.thread_id,
              ...(previous && previous.engineThreadId !== event.thread_id
                ? {
                    totalTokens: null,
                    lastInputTokens: null,
                    lastOutputTokens: null,
                    cachedInputTokens: null,
                    cacheWriteInputTokens: null,
                    modelContextWindow: null,
                    compactions: 0,
                  }
                : {}),
            });
          } else if (event.type === "turn.started" && event.thread_id && event.turn_id) {
            nativeTurn = { threadId: event.thread_id, turnId: event.turn_id };
            this.tokenActivity?.recordNative(runId, nativeTurn.threadId, nativeTurn.turnId, null);
          } else if (event.type === "usage.updated") {
            if (nativeTurn) this.tokenActivity?.recordNative(runId, nativeTurn.threadId, nativeTurn.turnId, event.usage);
          } else if (event.type === "context.updated") {
            const { type: _type, ...usage } = event;
            this.context(command.threadId, usage);
          } else if (event.type === "context.compacted") {
            const current = this.contexts().find(
              (context) => context.threadId === command.threadId,
            );
            this.context(command.threadId, {
              compactions: (current?.compactions ?? 0) + 1,
            });
            this.hooks.event(
              projectId,
              "context.compacted",
              "Codex 已完成原生上下文压缩。",
              runId,
            );
          } else if (
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed"
          ) {
            const id = `${runId}:${event.item.id}`;
            const existing = this.db
              .prepare("SELECT sequence FROM agent_items WHERE id=?")
              .get(id);
            const sequence = existing
              ? Number(existing.sequence)
              : this.hooks.event(
                  projectId,
                  "agent.item",
                  event.item.type,
                  runId,
                );
            const exactSecrets = secretRedactionVariants(input.apiKey);
            let payload = JSON.stringify(event.item, (_key, value) =>
              typeof value === "string"
                ? redact(value, exactSecrets)
                : value,
            );
            if (input.apiKey) {
              const encodedSecret = JSON.stringify(input.apiKey).slice(1, -1);
              payload = payload
                .split(encodedSecret)
                .join("[密钥已隐藏]");
            }
            if (payload.length > 4 * 1024 * 1024)
              throw new Error("单条工具输出超过 4 MB，已停止本次任务。");
            this.db
              .prepare(
                "INSERT INTO agent_items VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload,updatedAt=excluded.updatedAt",
              )
              .run(
                id,
                runId,
                command.threadId,
                sequence,
                event.type === "item.completed" ? "completed" : "running",
                payload,
                now(),
              );
            if (event.type === "item.completed" && event.item.type === "file_change" && event.item.status === "completed") {
              registerGeneratedFiles(input.cwd, event.item.changes.filter(change => change.kind === "add").map(change => change.path));
            }
          } else if (event.type === "turn.completed") {
            if (nativeTurn) this.tokenActivity?.recordNative(runId, nativeTurn.threadId, nativeTurn.turnId, event.usage, true);
            completed = true;
            if (event.usage) {
              usage = usage ? {
                input_tokens: usage.input_tokens + event.usage.input_tokens,
                cached_input_tokens: (usage.cached_input_tokens ?? 0) + (event.usage.cached_input_tokens ?? 0),
                cache_write_input_tokens: (usage.cache_write_input_tokens ?? 0) + (event.usage.cache_write_input_tokens ?? 0),
                output_tokens: usage.output_tokens + event.usage.output_tokens,
                reasoning_output_tokens: (usage.reasoning_output_tokens ?? 0) + (event.usage.reasoning_output_tokens ?? 0),
              } : event.usage;
            } else usageIncomplete = true;
            this.db
              .prepare("UPDATE agent_runs SET usage=? WHERE runId=?")
              .run(usage && !usageIncomplete ? JSON.stringify(usage) : null, runId);
            this.tokenActivity?.recordRun(runId);
          } else if (event.type === "turn.failed")
            throw new Error(event.error.message);
          else if (event.type === "error")
            this.hooks.event(
              projectId,
              "agent.warning",
              redact(event.message, secretRedactionVariants(input.apiKey)),
              runId,
            );
        }
      });
      this.hooks.changed(projectId);
      this.hooks.notify({ deferProjectRecord: true });
    }, () => abort.abort());
    try {
      const targets = input.modelingContext.stage.id === "attachments" ? attachmentTargets(command.text) : [];
      // One durable outer run owns cancellation; each file gets a separate
      // model context. Switching files never depends on the renderer staying open.
      for (const target of targets.length ? targets : [undefined]) {
        abort.signal.throwIfAborted();
        completed = false;
        let published = false;
        let outputCompleted = false;
        const previousReport = target && command.text.startsWith(ATTACHMENT_CORRECTION_MARKER)
          ? this.previousAttachmentReport(command.threadId, target) : undefined;
        if (target) checkpoint.push({ type: "item.completed", item: {
          id: `attachment:${target.id}:assignment`, type: "native_tool_call", namespace: "nexiom_attachments", tool: "begin_attachment",
          arguments: { attachmentId: target.id, path: target.path, name: target.name }, status: "completed", result: { accepted: true },
        } });
        const prompt = `请直接完成任务并验证结果。\n\n当前赛题工作区标识（以下 JSON 仅为名称与关联数据）：\n${JSON.stringify(input.modelingContext)}\n关联同一问题不代表其他对话的结果已经载入；引用结论前请核对本轮上下文或项目文件中的来源。\n\n${target ? attachmentTargetPrompt(target, command.text, previousReport) : command.text}`;
        for await (const event of this.runner.run({
          prompt, attachmentTarget: target,
          cwd: input.cwd,
          threadId: target ? undefined : input.engineThreadId,
          stageId: input.modelingContext.stage.id,
          settings,
          provider: input.provider,
          resolvedModelProvider: input.resolvedModelProvider,
          apiKey: input.apiKey,
          signal: abort.signal,
          projectMemory: input.projectMemory,
        })) {
          if (abort.signal.aborted) break;
          if (target && event.type === "item.completed" && event.item.type === "native_tool_call" &&
              event.item.namespace === "nexiom_attachments" && event.item.status === "completed" &&
              !event.item.error && (event.item.result as { accepted?: boolean } | undefined)?.accepted === true) {
            const data = event.item.arguments as Record<string, unknown>;
            if (data.attachmentId === target.id) {
              if (event.item.tool === "publish_attachment_report" && typeof data.body === "string" && data.body.trim()) published = true;
              const stage = parseAttachmentStage(data);
              if (event.item.tool === "set_attachment_stage" && stage?.phase === "writing" && stage.status === "completed") outputCompleted = true;
            }
          }
          // Native engines reuse item ids across independent file tasks.
          checkpoint.push(target && "item" in event
            ? { ...event, item: { ...event.item, id: `${target.id}:${event.item.id}` } }
            : event);
          await checkpoint.yieldIfNeeded();
          if (abort.signal.aborted) break;
        }
        checkpoint.flush();
        if (abort.signal.aborted) throw new Error("任务已停止。");
        if (!completed) throw new Error(`${target ? `${target.name}：` : ""}引擎连接结束，但未收到任务完成事件。`);
        if (target && (!published || !outputCompleted)) throw new Error(`${target.name} 的报告或输出阶段尚未完成，已保留收到的内容，可单独重试此附件。`);
      }
      checkpoint.close();
      if (abort.signal.aborted) throw new Error("任务已停止。");
      if (!completed) throw new Error("引擎连接结束，但未收到任务完成事件。");
      this.hooks.transaction(() =>
        this.finish(runId, projectId, "succeeded", "任务完成"),
      );
    } catch (error) {
      // Persist received output before recording cancellation or a stream failure.
      try { checkpoint.close(); } catch (failure) { error = failure; }
      const cancelled = abort.signal.aborted && !checkpoint.error;
      abort.abort();
      const summary = cancelled
        ? "任务已停止，已经发生的文件修改会保留。"
        : redact(
            (error as Error).message,
            secretRedactionVariants(input.apiKey),
          );
      this.hooks.transaction(() => {
        this.finish(
          runId,
          projectId,
          cancelled ? "cancelled" : "failed",
          summary,
        );
        this.hooks.message(command.threadId, "assistant", "answer", summary);
      });
    } finally {
      this.db
        .prepare(
          "UPDATE agent_items SET status='interrupted' WHERE runId=? AND status='running'",
        )
        .run(runId);
      this.hooks.changed(projectId);
      this.hooks.notify();
    }
  }
  private finish(
    runId: string,
    projectId: string,
    status: string,
    summary: string,
  ) {
    this.db
      .prepare("UPDATE runs SET status=?,finishedAt=? WHERE id=?")
      .run(status, now(), runId);
    this.hooks.event(projectId, `agent.${status}`, summary, runId);
    this.tokenActivity?.recordRun(runId);
  }
  async close() {
    for (const task of this.active.values()) task.abort.abort();
    await Promise.allSettled(
      [...this.active.values()].map((task) => task.promise),
    );
  }
}
