import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import path from "node:path";
import type { AgentInput, ThreadEvent, ThreadItem } from "./index";
import type { Usage } from "../../vendor/codex-sdk/src/index";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { NativeToolRegistry, NativeToolResponse } from "./visual-design";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" ? (value as RecordValue) : {};
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const readUsage = (value: RecordValue): Usage => ({
  input_tokens: number(value.inputTokens),
  output_tokens: number(value.outputTokens),
  cached_input_tokens: number(value.cachedInputTokens),
  cache_write_input_tokens: number(value.cacheWriteInputTokens),
  reasoning_output_tokens: number(value.reasoningOutputTokens),
});
const usageDifference = (total: Usage, baseline: Usage): Usage | null => {
  const result = { ...total };
  for (const key of Object.keys(result) as (keyof Usage)[]) {
    result[key] -= baseline[key];
    if (result[key] < 0) return null;
  }
  return result;
};

type Notification = { method: string; params: RecordValue };
const NOTIFICATION_BATCH_SIZE = 64;
const NOTIFICATION_BATCH_MS = 8;

// One owned app-server per active turn; Codex persists and resumes its own threads.
class AppServerConnection {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: RecordValue): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private queue: Notification[] = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private stopped = false;
  private stderr = "";
  private exited: Promise<void>;
  constructor(executable: string, env: NodeJS.ProcessEnv, cwd: string, projectCwd: string,
    private readonly toolCall?: (params: RecordValue) => Promise<NativeToolResponse>) {
    // Apply before configuration loading, including every ancestor of the
    // workspace. NEXIOM supplies its settings explicitly; local Codex files
    // must not introduce hooks, tools, instructions or environment variables.
    const untrustedDirectories = new Set<string>();
    for (let directory of [cwd, projectCwd]) {
      while (!untrustedDirectories.has(directory)) {
        untrustedDirectories.add(directory);
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const projects = [...untrustedDirectories]
      .map(directory => `${JSON.stringify(directory)}={trust_level="untrusted"}`).join(",");
    this.child = spawn(executable, [
      "app-server", "--listen", "stdio://",
      "-c", "project_doc_max_bytes=0",
      "-c", "cli_auth_credentials_store=\"ephemeral\"",
      "-c", "features.skip_host_skill_discovery=true",
      "-c", "features.plugins=false",
      "-c", "features.apps=false",
      "-c", "features.hooks=false",
      "-c", "features.skill_search=false",
      "-c", "skills.include_instructions=false",
      "-c", "skills.bundled.enabled=false",
      "-c", `projects={${projects}}`,
    ], {
      env,
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => {
        this.fail(
          new Error(
            this.stopped
              ? "Codex 已停止。"
              : `Codex 引擎连接中断。${this.stderr.slice(-1800)}`,
          ),
        );
        resolve();
      });
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-5000);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 8 * 1024 * 1024)
          throw new Error("Codex 协议消息超过 8 MB。");
        const message = object(JSON.parse(line));
        if (typeof message.id === "number" && !message.method) {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error)
            request.reject(
              new Error(
                string(object(message.error).message) || "Codex 请求失败。",
              ),
            );
          else request.resolve(object(message.result));
        } else if (typeof message.method === "string") {
          if (message.id !== undefined) {
            if (message.method === "item/tool/call" && this.toolCall) {
              void this.handleToolCall(message.id, object(message.params));
              return;
            }
            // Unexpected server approvals cannot silently grant additional permissions.
            this.send({
              id: message.id,
              error: {
                code: -32601,
                message:
                  "This NEXIOM session does not grant interactive permission escalation.",
              },
            });
            this.queue.push({
              method: "error",
              params: {
                error: {
                  message: `引擎请求 ${message.method} 需要当前界面尚未提供的交互。`,
                },
              },
            });
          } else
            this.queue.push({
              method: message.method,
              params: object(message.params),
            });
          if (this.queue.length > 10000)
            throw new Error("Codex 事件积压，任务已停止。");
          this.wake?.();
        }
      } catch (error) {
        this.fail(error as Error);
      }
    });
    this.exited.then(() => lines.close());
  }
  private async handleToolCall(id: unknown, params: RecordValue) {
    let result: NativeToolResponse;
    try { result = await this.toolCall!(params); }
    catch (error) {
      result = { success: false, contentItems: [{ type: "inputText", text: (error as Error).message }] };
    }
    if (!this.stopped && !this.failure) this.send({ id, result });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
    this.pending.clear();
    this.wake?.();
  }
  private send(value: unknown) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  notify(method: string, params: unknown = {}) {
    this.send({ method, params });
  }
  request(method: string, params: unknown): Promise<RecordValue> {
    return new Promise((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时。`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async *notifications(): AsyncIterable<Notification> {
    while (true) {
      let count = 0;
      let sliceStarted = performance.now();
      while (this.queue.length) {
        yield this.queue.shift()!;
        // Async generators alone only yield to microtasks. Even notifications
        // filtered by the adapter must give IPC, cancellation and timers time
        // to run while a native stream is already buffered.
        if (++count >= NOTIFICATION_BATCH_SIZE || performance.now() - sliceStarted >= NOTIFICATION_BATCH_MS) {
          await yieldToEventLoop();
          count = 0;
          sliceStarted = performance.now();
        }
      }
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
  async close() {
    if (this.stopped) {
      await this.exited;
      return;
    }
    this.stopped = true;
    const pid = this.child.pid;
    if (pid && this.child.exitCode === null) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) =>
          execFile(
            "taskkill.exe",
            ["/pid", String(pid), "/T", "/F"],
            { windowsHide: true },
            () => resolve(),
          ),
        );
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          this.child.kill("SIGTERM");
        }
      }
    }
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited;
    clearTimeout(kill);
  }
}

function mapItem(raw: RecordValue): ThreadItem | undefined {
  const id = string(raw.id);
  const status =
    raw.status === "completed"
      ? "completed"
      : raw.status === "failed" || raw.status === "declined"
        ? "failed"
        : "in_progress";
  switch (raw.type) {
    case "agentMessage":
      return { id, type: "agent_message", text: string(raw.text) };
    case "plan":
      return { id, type: "agent_message", text: string(raw.text) };
    case "commandExecution":
      return {
        id,
        type: "command_execution",
        command: string(raw.command),
        aggregated_output: string(raw.aggregatedOutput),
        status,
        ...(typeof raw.exitCode === "number"
          ? { exit_code: raw.exitCode }
          : {}),
      };
    case "fileChange":
      return {
        id,
        type: "file_change",
        status: status === "failed" ? "failed" : "completed",
        changes: (Array.isArray(raw.changes) ? raw.changes : []).map(
          (value) => {
            const change = object(value);
            const kind = object(change.kind).type;
            return {
              path: string(change.path),
              kind: kind === "add" || kind === "delete" ? kind : "update",
            };
          },
        ),
      };
    case "mcpToolCall":
      return {
        id,
        type: "mcp_tool_call",
        server: string(raw.server),
        tool: string(raw.tool),
        arguments: raw.arguments,
        status: object(raw.result).isError === true ? "failed" : status,
        ...(raw.error
          ? { error: { message: string(object(raw.error).message) } }
          : {}),
        ...(raw.result
          ? {
              result: {
                content: (Array.isArray(object(raw.result).content)
                  ? object(raw.result).content
                  : []) as ContentBlock[],
                structured_content: object(raw.result).structuredContent,
                _meta: object(raw.result)._meta,
              },
            }
          : {}),
      };
    case "dynamicToolCall": {
      const textItems = (Array.isArray(raw.contentItems) ? raw.contentItems : [])
        .map(object).filter(item => item.type === "inputText").map(item => string(item.text));
      let result: unknown;
      if (textItems.length === 1) {
        try { result = JSON.parse(textItems[0]); } catch { result = textItems[0]; }
      } else if (textItems.length) result = textItems;
      return {
        id, type: "native_tool_call", namespace: string(raw.namespace), tool: string(raw.tool),
        arguments: raw.arguments, status,
        ...(result !== undefined ? { result } : {}),
        ...(raw.success === false ? { error: { message: textItems.join("\n") || "原生工具执行失败。" } } : {}),
      };
    }
    case "webSearch":
      return {
        id,
        type: "web_search",
        query: string(raw.query) || string(object(raw.action).query),
      };
    default:
      return undefined;
  }
}

// Reasoning content stays inside the engine. Every chat keeps only the thinking lifecycle.
export class AppServerEvents {
  private items = new Map<string, ThreadItem>();
  private compacted = new Set<string>();
  private plan: Extract<ThreadItem, { type: "todo_list" }> | undefined;
  private usage: Usage | null = null;
  private baseline: Usage | null;
  private turnStarted = false;
  complete = false;
  constructor(
    private turnId = "",
    freshThread = true,
  ) {
    this.baseline = freshThread ? readUsage({}) : null;
  }
  map(method: string, params: RecordValue): ThreadEvent[] {
    const notificationTurnId =
      string(params.turnId) || string(object(params.turn).id);
    if (
      method === "turn/started" &&
      (!this.turnId || notificationTurnId === this.turnId)
    ) {
      this.turnStarted = true;
      return [];
    }
    if (
      this.turnId &&
      notificationTurnId &&
      notificationTurnId !== this.turnId
    ) {
      // Resume replays the authoritative cumulative totals before the next turn starts.
      if (method === "thread/tokenUsage/updated" && !this.turnStarted)
        this.baseline = readUsage(object(object(params.tokenUsage).total));
      return [];
    }
    if (method === "item/started" || method === "item/completed") {
      const raw = object(params.item);
      if (raw.type === "reasoning") {
        const id = string(raw.id);
        if (!id) return [];
        return [{
          type: method === "item/started" ? "item.started" : "item.completed",
          item: { id: `activity:${id}`, type: "agent_activity", phase: "thinking" },
        }];
      }
      if (raw.type === "contextCompaction") {
        const id = string(raw.id);
        if (method !== "item/completed" || this.compacted.has(id)) return [];
        this.compacted.add(id);
        return [{ type: "context.compacted", itemId: id }];
      }
      const item = mapItem(raw);
      if (!item) return [];
      this.items.set(item.id, item);
      return [
        {
          type: method === "item/started" ? "item.started" : "item.completed",
          item,
        },
      ];
    }
    if (
      [
        "item/agentMessage/delta",
        "item/plan/delta",
        "item/commandExecution/outputDelta",
      ].includes(method)
    ) {
      const id = string(params.itemId);
      let item = this.items.get(id);
      if (!item && method !== "item/commandExecution/outputDelta")
        item = {
          id,
          type: "agent_message",
          text: "",
        };
      if (!item) return [];
      if (item.type === "agent_message")
        item = { ...item, text: item.text + string(params.delta) };
      else if (item.type === "command_execution")
        item = {
          ...item,
          aggregated_output: item.aggregated_output + string(params.delta),
        };
      this.items.set(id, item);
      return [{ type: "item.updated", item }];
    }
    if (method === "turn/plan/updated") {
      this.plan = {
        id: `plan:${string(params.turnId)}`,
        type: "todo_list",
        items: (Array.isArray(params.plan) ? params.plan : []).map((step) => ({
          text: string(object(step).step),
          completed: object(step).status === "completed",
        })),
      };
      return [{ type: "item.updated", item: this.plan }];
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const last = object(usage.last);
      const total = object(usage.total);
      this.usage = this.baseline
        ? usageDifference(readUsage(total), this.baseline)
        : null;
      return [
        {
          type: "context.updated",
          modelContextWindow:
            typeof usage.modelContextWindow === "number"
              ? usage.modelContextWindow
              : null,
          totalTokens: number(total.totalTokens),
          lastInputTokens: number(last.inputTokens),
          lastOutputTokens: number(last.outputTokens),
          cachedInputTokens: number(last.cachedInputTokens),
          cacheWriteInputTokens: number(last.cacheWriteInputTokens),
        },
        ...(this.usage ? [{ type: "usage.updated" as const, usage: this.usage }] : []),
      ];
    }
    if (method === "turn/completed") {
      this.complete = true;
      const turn = object(params.turn);
      return turn.status === "completed"
        ? [
            ...(this.plan
              ? [{ type: "item.completed" as const, item: this.plan }]
              : []),
            { type: "turn.completed", usage: this.usage },
          ]
        : [
            {
              type: "turn.failed",
              error: {
                message:
                  string(object(turn.error).message) ||
                  (turn.status === "interrupted"
                    ? "任务被引擎中断。"
                    : "Codex 任务失败。"),
              },
            },
          ];
    }
    if (method === "error")
      return [
        {
          type: "error",
          message:
            string(object(params.error).message) ||
            string(params.message) ||
            "引擎报告错误。",
        },
      ];
    return [];
  }
}

export async function* runAppServer(options: {
  executable: string;
  env: NodeJS.ProcessEnv;
  input: AgentInput;
  developerInstructions?: string;
  baseInstructions: string;
  runtimeHome: string;
  config: Record<string, unknown>;
  nativeTools?: NativeToolRegistry;
}): AsyncIterable<ThreadEvent> {
  const { input } = options;
  input.signal.throwIfAborted();
  let activeThreadId = input.threadId ?? "";
  let activeTurnId = "";
  const connection = new AppServerConnection(
    options.executable,
    options.env,
    options.runtimeHome,
    input.cwd,
    options.nativeTools ? params => {
      if (string(params.threadId) !== activeThreadId || (activeTurnId && string(params.turnId) !== activeTurnId))
        return Promise.resolve({ success: false, contentItems: [{ type: "inputText" as const, text: "原生工具请求不属于当前任务。" }] });
      return options.nativeTools!.call(string(params.namespace), string(params.tool), params.arguments);
    } : undefined,
  );
  const abort = () => {
    options.nativeTools?.close();
    void connection.close();
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    await connection.request("initialize", {
      clientInfo: { name: "nexiom", title: "NEXIOM", version: "0.6.25" },
      capabilities: { experimentalApi: true },
    });
    connection.notify("initialized");
    const params = {
      // Resolve the thread's configuration only from NEXIOM's private home.
      // The turn below retargets execution to the project without reloading
      // project/ancestor .codex configuration, instructions, hooks or MCPs.
      cwd: options.runtimeHome,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      config: options.config,
      baseInstructions: options.baseInstructions,
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(!input.threadId && options.nativeTools ? { dynamicTools: options.nativeTools.specs } : {}),
      ...(input.provider.model ? { model: input.provider.model } : {}),
    };
    const result = await connection.request(
      input.threadId ? "thread/resume" : "thread/start",
      input.threadId
        ? {
            ...params,
            threadId: input.threadId,
            excludeTurns: true,
            initialTurnsPage: {
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            },
          }
        : params,
    );
    const threadId = string(object(result.thread).id);
    if (!threadId) throw new Error("Codex 未返回会话标识。");
    activeThreadId = threadId;
    yield { type: "thread.started", thread_id: threadId };
    const started = await connection.request("turn/start", {
      threadId,
      cwd: input.cwd,
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [input.cwd],
        networkAccess: input.settings.network,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      summary: "none",
      ...(input.settings.effort !== "default"
        ? { effort: input.settings.effort }
        : {}),
    });
    const turnId = string(object(started.turn).id);
    if (!turnId) throw new Error("Codex 未返回任务标识。");
    activeTurnId = turnId;
    yield { type: "turn.started", thread_id: threadId, turn_id: turnId };
    const adapter = new AppServerEvents(turnId, !input.threadId);
    for await (const event of connection.notifications()) {
      input.signal.throwIfAborted();
      if (event.params.threadId && event.params.threadId !== threadId) continue;
      for (const mapped of adapter.map(event.method, event.params))
        yield mapped;
      if (adapter.complete) break;
    }
  } finally {
    options.nativeTools?.close();
    input.signal.removeEventListener("abort", abort);
    await connection.close();
  }
}
