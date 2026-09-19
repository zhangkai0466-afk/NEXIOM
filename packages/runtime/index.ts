import type {
  AgentSettings,
  ModelProvider,
  RuntimeState,
  ThreadStage,
} from "../contracts";
import type {
  ThreadEvent as SdkThreadEvent,
  Usage,
  ThreadItem as SdkThreadItem,
} from "../../vendor/codex-sdk/src/index";
export type NativeToolCallItem = {
  id: string;
  type: "native_tool_call";
  namespace: string;
  tool: string;
  arguments: unknown;
  status: "in_progress" | "completed" | "failed";
  result?: unknown;
  error?: { message: string };
};
export type ThreadItem = SdkThreadItem | NativeToolCallItem;
export type ThreadEvent =
  | Exclude<SdkThreadEvent, { type: "turn.completed" | "item.started" | "item.updated" | "item.completed" }>
  | { type: "item.started" | "item.updated" | "item.completed"; item: ThreadItem }
  | { type: "turn.completed"; usage: Usage | null }
  | {
      type: "context.updated";
      modelContextWindow: number | null;
      totalTokens: number;
      lastInputTokens: number;
      lastOutputTokens: number;
      cachedInputTokens: number;
    }
  | { type: "context.compacted"; itemId: string };
export interface AgentInput {
  prompt: string;
  cwd: string;
  threadId?: string;
  mode: "plan" | "execute";
  stageId?: ThreadStage;
  settings: AgentSettings;
  provider: ModelProvider;
  resolvedModelProvider?: string;
  apiKey?: string;
  signal: AbortSignal;
  projectMemory?: string;
}
export interface AgentRunner {
  probe(provider: ModelProvider, apiKey?: string): Promise<RuntimeState>;
  listModels(provider: ModelProvider, apiKey?: string): Promise<string[]>;
  run(input: AgentInput): AsyncIterable<ThreadEvent>;
}
