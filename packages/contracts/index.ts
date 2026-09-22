import { z } from "zod";
import { visualFigureSchema, visualLibrarySchema, type VisualAsset, type VisualWorkspaceState, type VisualElement } from "../visualization/document";
import type { ThreadItem } from "../runtime";

export const settingsSchema = z.object({
  activeProviderId: z.string().min(1).max(80).default("nexiom-default"),
  effort: z
    .enum(["default", "low", "medium", "high", "xhigh"])
    .default("default"),
  network: z.boolean().default(false),
});
export type AgentSettings = z.infer<typeof settingsSchema>;
export const conversationStageSchema = z.enum(["model", "validation", "chart", "paper"]);
export type ConversationStage = z.infer<typeof conversationStageSchema>;
export const projectChatStageSchema = z.enum(["reading", "attachments", "delivery"]);
export type ProjectChatStage = z.infer<typeof projectChatStageSchema>;
export const threadStageSchema = z.enum([
  "overview",
  ...projectChatStageSchema.options,
  ...conversationStageSchema.options,
]);
export type ThreadStage = z.infer<typeof threadStageSchema>;
export const accountProfileSchema = z.object({
  nickname: z.string().trim().min(1).max(40).default("NEXIOM 用户"),
  avatar: z
    .string()
    .max(2800000)
    .regex(/^data:image\/(?:png|jpeg|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
    .nullable()
    .default(null),
});
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export const providerKindSchema = z.enum(["responses"], {
  errorMap: () => ({ message: "请配置 NEXIOM 独立的 Responses API；不再支持本机 Codex 配置。" }),
});
export const providerAuthSchema = z.enum(["bearer", "none"]);
export const providerDraftSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(80),
  kind: providerKindSchema,
  endpoint: z.string().trim().max(500).default(""),
  modelName: z.string().trim().max(80).default(""),
  model: z.string().trim().max(120).default(""),
  auth: providerAuthSchema.default("bearer"),
});
export type ProviderDraft = z.infer<typeof providerDraftSchema>;
export interface ModelProvider extends ProviderDraft {
  id: string;
  revision: number;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ProviderCheck {
  providerId: string;
  ok: boolean;
  label: string;
  latencyMs: number;
  models: string[];
  checkedAt: string;
}
export interface RuntimeState {
  connected: boolean;
  available: boolean;
  authenticated: boolean;
  label: string;
  version: string;
  hasApiKey: boolean;
  activeProviderId: string;
  activeProviderName: string;
  activeModel: string;
  activeModelProvider: string;
}
export interface AgentItem {
  id: string;
  runId: string;
  threadId: string;
  sequence: number;
  status: string;
  item: ThreadItem;
  updatedAt: string;
}
export interface ProjectMemory {
  projectId: string;
  path: string;
  text: string;
  revision: string;
  updatedAt: string | null;
}
export interface ThreadContext {
  threadId: string;
  engine: "codex";
  transport: "app-server";
  engineThreadId: string;
  modelContextWindow: number | null;
  totalTokens: number | null;
  lastInputTokens: number | null;
  lastOutputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  compactions: number;
  updatedAt: string;
}

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot") }),
  z.object({ type: z.literal("usage.export") }),
  z.object({ type: z.literal("usage.import"), data: z.string().max(16 * 1024 * 1024) }),
  z.object({ type: z.literal("usage.recover") }),
  z.object({ type: z.literal("storage.inspect") }),
  z.object({ type: z.literal("storage.clear") }),
  z.object({ type: z.literal("project.reset.preview"), projectId: z.string().uuid() }),
  z.object({
    type: z.literal("project.reset"), projectId: z.string().uuid(),
    revision: z.string().length(64), deleteGenerated: z.boolean().default(false),
    confirmationName: z.string().max(80).default(""),
  }),
  z.object({ type: z.literal("runtime.check") }),
  z.object({ type: z.literal("visual.catalog") }),
  z.object({ type: z.literal("visual.palettes") }),
  z.object({ type: z.literal("visual.workspace"), projectId: z.string().uuid() }),
  z.object({ type: z.literal("visual.figure.read"), projectId: z.string().uuid(), library: visualLibrarySchema, id: z.string().uuid() }),
  z.object({ type: z.literal("visual.figure.preview"), projectId: z.string().uuid(), library: visualLibrarySchema, id: z.string().uuid(), figure: visualFigureSchema }),
  z.object({ type: z.literal("visual.figure.save"), projectId: z.string().uuid(), library: visualLibrarySchema, id: z.string().uuid(), expectedRevision: z.number().int().positive(), figure: visualFigureSchema }),
  z.object({ type: z.literal("visual.status") }),
  z.object({ type: z.literal("visual.asset"), assetId: z.string().min(1).max(160) }),
  z.object({
    type: z.literal("visual.image.read"),
    projectId: z.string().uuid(),
    path: z.string().min(1).max(1000),
  }),
  z.object({
    type: z.literal("visual.image.save"),
    projectId: z.string().uuid(),
    name: z.string().min(1).max(200),
    base64: z.string().min(1).max(28000000),
  }),
  z.object({ type: z.literal("memory.read"), projectId: z.string().uuid() }),
  z.object({
    type: z.literal("memory.write"),
    projectId: z.string().uuid(),
    text: z.string().max(32000),
    expectedRevision: z.string().max(64),
  }),
  z.object({
    type: z.literal("runtime.configure"),
    settings: settingsSchema,
  }),
  z.object({ type: z.literal("account.update"), profile: accountProfileSchema }),
  z.object({
    type: z.literal("provider.upsert"),
    provider: providerDraftSchema,
    apiKey: z.string().max(2000).optional(),
    clearApiKey: z.boolean().default(false),
  }),
  z.object({ type: z.literal("provider.delete"), providerId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("provider.activate"), providerId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("provider.models"), providerId: z.string().min(1).max(80) }),
  z.object({ type: z.literal("provider.test"), providerId: z.string().min(1).max(80) }),
  z.object({
    type: z.literal("agent.submit"),
    threadId: z.string().uuid(),
    text: z.string().trim().min(1).max(20000),
    clientRequestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("project.create"),
    name: z.string().trim().min(1).max(80),
  }),
  z.object({
    type: z.literal("project.rename"),
    projectId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
  }),
  z.object({
    type: z.literal("project.remove"),
    projectId: z.string().uuid(),
    discardUnsavedRecord: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("thread.create"),
    projectId: z.string().uuid(),
    stageId: conversationStageSchema.optional(),
    title: z.string().trim().min(1).max(80).optional(),
    questionId: z.string().uuid().optional(),
    questionName: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({
    type: z.literal("thread.ensure"),
    projectId: z.string().uuid(),
    stageId: projectChatStageSchema,
  }),
  z.object({
    type: z.literal("thread.rename"),
    threadId: z.string().uuid(),
    title: z.string().trim().min(1).max(80),
  }),
  z.object({ type: z.literal("thread.unread"), threadId: z.string().uuid(), unread: z.boolean() }),
  z.object({ type: z.literal("thread.archive"), threadId: z.string().uuid(), archived: z.boolean() }),
  z.object({ type: z.literal("thread.delete"), threadId: z.string().uuid() }),
  z.object({
    type: z.literal("thread.move"),
    threadId: z.string().uuid(),
    projectId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("thread.fork"),
    threadId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal("message.submit"),
    threadId: z.string().uuid(),
    text: z.string().trim().min(1).max(20000),
    clientRequestId: z.string().uuid(),
  }),
  z.object({ type: z.literal("project.files"), projectId: z.string().uuid() }),
  z.object({
    type: z.literal("file.read"),
    projectId: z.string().uuid(),
    path: z.string().min(1).max(1000),
  }),
  z.object({
    type: z.literal("file.import"),
    projectId: z.string().uuid(),
    name: z.string().min(1).max(200),
    base64: z.string().max(14000000),
  }),
  z.object({
    type: z.literal("file.unimport"),
    projectId: z.string().uuid(),
    path: z.string().min(1).max(1000),
  }),
  z.object({ type: z.literal("run.cancel"), runId: z.string().uuid() }),
]);

export type Command = z.infer<typeof commandSchema>;
export interface StorageSummary {
  categories: { id: string; label: string; bytes: number }[];
  warnings: string[];
}
export interface CleanupResult {
  freedBytes: number;
  deletedFiles: number;
  skippedFiles: number;
  warnings: string[];
}
export interface ProjectResetPreview {
  revision: string;
  threads: number;
  messages: number;
  runs: number;
  generatedFiles: { path: string; size: number }[];
  preservedFiles: number;
  warnings: string[];
}
export interface Project {
  id: string;
  name: string;
  root: string;
  createdAt: string;
}
export interface Thread {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  stageId: ThreadStage;
  questionId: string | null;
  unread: boolean;
  archivedAt: string | null;
}
export interface Question {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}
export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  kind: "note" | "progress" | "answer";
  text: string;
  createdAt: string;
  sequence: number;
}
export interface Run {
  id: string;
  threadId: string;
  projectId: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  finishedAt: string | null;
  kind?: "inspection" | "agent";
  mode?: "plan" | "execute";
  usage?: string | null;
  providerId?: string | null;
  providerFingerprint?: string | null;
  runtimeConfig?: string | null;
}
export interface TokenActivity {
  id: string;
  runId: string | null;
  source: "run" | "native";
  kind: "agent";
  createdAt: string;
  finishedAt: string | null;
  usage: string | null;
  runtimeConfig: string | null;
  nativeThreadId: string | null;
  nativeTurnId: string | null;
}
export interface CoreEvent {
  id: string;
  projectId: string;
  sequence: number;
  type: string;
  runId: string | null;
  summary: string;
  createdAt: string;
}
export interface Snapshot {
  tokenActivity: TokenActivity[];
  tokenActivityWarning?: string;
  projects: Project[];
  questions: Question[];
  threads: Thread[];
  messages: Message[];
  runs: Run[];
  events: CoreEvent[];
  runtime: RuntimeState;
  settings: AgentSettings;
  providers: ModelProvider[];
  items: AgentItem[];
  contexts: ThreadContext[];
  account: AccountProfile;
}
export interface ProjectFile {
  path: string;
  name: string;
  size: number;
  extension: string;
}
export interface FileContent {
  path: string;
  text: string | null;
  mime: string;
  base64?: string;
  size: number;
}
export interface CoreResponse {
  usageBackup?: string;
  recoveredActivities?: number;
  storage?: StorageSummary;
  cleanup?: CleanupResult;
  resetPreview?: ProjectResetPreview;
  visualWorkspace?: VisualWorkspaceState;
  visualFigure?: VisualAsset;
  visualPreview?: { svg: string; elements: VisualElement[] };
  visualPalettes?: VisualPalette[];
  visualCatalog?: VisualCatalog;
  visualStatus?: VisualStatus;
  snapshot?: Snapshot;
  project?: Project;
  thread?: Thread;
  files?: ProjectFile[];
  file?: FileContent;
  runId?: string;
  importedPath?: string;
  savedPath?: string;
  memory?: ProjectMemory;
  provider?: ModelProvider;
  models?: string[];
  connectionCheck?: ProviderCheck;
}
export interface VisualTemplate {
  id: string;
  name: string;
  family: string;
  description: string;
  readerQuestion: string;
  requiredColumns: string[];
  preconditions: string[];
  forbiddenUses: string[];
  keywords: string[];
}
export interface VisualPalette {
  id: string;
  name: string;
  description: string;
  colors: string[];
}
export interface VisualReference {
  id: string;
  name: string;
  description: string;
  tags: string[];
  assetId: string | null;
}
export interface VisualGrammarEntry {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  status: "executable" | "name_index_only";
  templateId?: string;
}
export interface VisualCatalog {
  version: string;
  templates: VisualTemplate[];
  palettes: VisualPalette[];
  references: VisualReference[];
  grammar: VisualGrammarEntry[];
  counts: { templates: number; palettes: number; references: number; grammar: number };
}
export interface VisualStatus {
  available: boolean;
  label: string;
  python?: string | null;
  bundleVersion?: string | null;
}
export type ThemeSource = "system" | "light" | "dark";
export interface ThemeState {
  source: ThemeSource;
  resolved: "light" | "dark";
}
export interface DesktopUpdateResult {
  targetVersion: string | null;
}
export interface DesktopBridge {
  request(command: Command): Promise<CoreResponse>;
  subscribe(listener: () => void): () => void;
  openProject(): Promise<CoreResponse | null>;
  chooseProjectFolder?(): Promise<string | null>;
  openSelectedProject?(root: string, name: string): Promise<CoreResponse>;
  openThreadWindow?(threadId: string): Promise<void>;
  getTheme?(): Promise<ThemeState>;
  setTheme?(source: ThemeSource): Promise<ThemeState>;
  onThemeChanged?(listener: (theme: ThemeState) => void): () => void;
  reportReady?(): void;
  whenWindowShown?(): Promise<void>;
  reportStartupComplete?(): void;
  reportFailure?(kind: "react-render" | "script-error" | "unhandled-rejection"): void;
  setWindowModalState?(open: boolean): void;
  openStartupLogs?(): Promise<void>;
  applyUpdate?(): Promise<DesktopUpdateResult>;
}

declare global {
  interface Window {
    nexiom?: DesktopBridge;
  }
}
