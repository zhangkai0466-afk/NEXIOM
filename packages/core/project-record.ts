import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import path from "node:path";
import type { Project, Thread } from "../contracts";

const format = "nexiom.project";
const version = 1;
const maximumRecordBytes = 128 * 1024 * 1024;
export const projectRecordRelativePath = path.join(".nexiom", "project.json");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const threadStages = new Set([
  "overview",
  "reading",
  "attachments",
  "model",
  "validation",
  "chart",
  "paper",
  "delivery",
]);
const messageRoles = new Set(["user", "assistant"]);
const messageKinds = new Set(["note", "progress", "answer"]);
const runStatuses = new Set(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const agentModes = new Set(["plan", "execute"]);
const agentItemStatuses = new Set(["running", "completed", "interrupted"]);
const conversationStages = new Set(["model", "validation", "chart", "paper"]);
const agentItemTypes = new Set([
  "agent_message",
  "agent_activity",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "native_tool_call",
  "web_search",
  "todo_list",
  "error",
]);

type Row = Record<string, unknown>;
type ProjectIdentity = Pick<Project, "id" | "name" | "createdAt">;

export interface ProjectRecord {
  format: typeof format;
  version: typeof version;
  savedAt: string;
  project: ProjectIdentity;
  records: {
    questions: Row[];
    threads: Row[];
    messages: Row[];
    requests: Row[];
    runs: Row[];
    events: Row[];
    agentRuns: Row[];
    agentRequests: Row[];
    agentItems: Row[];
    agentContexts: Row[];
  };
}

export interface ImportedProjectRecord {
  project: Project;
  thread?: Thread;
  relocated: boolean;
}

function rows(db: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): Row[] {
  return db.prepare(sql).all(...parameters) as Row[];
}

function safeProjectRoot(root: string): string {
  const configured = path.resolve(root);
  const resolved = realpathSync(configured);
  if (!statSync(resolved).isDirectory())
    throw new Error("项目工作路径不是文件夹，无法保存项目记录。");
  if (path.relative(path.parse(resolved).root, resolved) === "")
    throw new Error("不能在磁盘或文件系统根目录保存项目记录。");
  if (path.relative(configured, resolved) !== "")
    throw new Error("项目工作文件夹已被链接到其他位置，已停止写入项目记录。");
  return resolved;
}

function projectRecordDirectory(root: string, create: boolean): string | null {
  const expected = path.join(root, ".nexiom");
  if (create) mkdirSync(expected, { recursive: true });
  let resolved: string;
  try {
    resolved = realpathSync(expected);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!statSync(resolved).isDirectory())
    throw new Error("项目中的 .nexiom 路径不是文件夹。");
  if (path.relative(expected, resolved) !== "")
    throw new Error("项目中的 .nexiom 文件夹已被链接到其他位置，已停止访问项目记录。");
  return resolved;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`项目记录中的 ${field} 无效。`);
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    throw new Error(`项目记录中的 ${field} 无效。`);
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!uuidPattern.test(result))
    throw new Error(`项目记录中的 ${field} 不是有效的 UUID。`);
  return result;
}

function optionalUuid(value: unknown, field: string): string | null {
  const result = optionalString(value, field);
  if (result === null) return null;
  if (!uuidPattern.test(result))
    throw new Error(`项目记录中的 ${field} 不是有效的 UUID。`);
  return result;
}

function requiredEnum(value: unknown, field: string, allowed: ReadonlySet<string>): string {
  const result = requiredString(value, field);
  if (!allowed.has(result))
    throw new Error(`项目记录中的 ${field} 取值无效。`);
  return result;
}

function requiredFlag(value: unknown, field: string): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`项目记录中的 ${field} 无效。`);
}

function requiredJsonObject(value: unknown, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredString(value, field));
  } catch {
    throw new Error(`项目记录中的 ${field} 不是有效的 JSON 对象。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`项目记录中的 ${field} 不是有效的 JSON 对象。`);
  return parsed as Record<string, unknown>;
}

function uniqueIds(
  table: Row[],
  name: string,
  readId: (row: Row) => string = (row) => requiredUuid(row.id, `${name}.id`),
): Set<string> {
  const result = new Set<string>();
  for (const row of table) {
    const id = readId(row);
    if (result.has(id))
      throw new Error(`项目记录中的 ${name} 包含重复标识。`);
    result.add(id);
  }
  return result;
}

function requiredSequence(value: unknown, field: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error(`项目记录中的 ${field} 无效。`);
  return sequence;
}

function requiredRows(value: unknown, field: string): Row[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item)))
    throw new Error(`项目记录中的 ${field} 无效。`);
  return value as Row[];
}

function parseRecord(value: unknown): ProjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("项目记录格式无效。");
  const source = value as Record<string, unknown>;
  if (source.format !== format)
    throw new Error("项目记录格式不受支持。");
  const sourceVersion = Number(source.version);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1)
    throw new Error("项目记录版本无效。");
  if (sourceVersion > version)
    throw new Error("项目记录由更高版本的 NEXIOM 创建，请先升级应用。");
  if (!source.project || typeof source.project !== "object" || Array.isArray(source.project))
    throw new Error("项目记录缺少项目信息。");
  if (!source.records || typeof source.records !== "object" || Array.isArray(source.records))
    throw new Error("项目记录缺少工作内容。");
  const project = source.project as Record<string, unknown>;
  const records = source.records as Record<string, unknown>;
  return {
    format,
    version,
    savedAt: typeof source.savedAt === "string" ? source.savedAt : "",
    project: {
      id: requiredUuid(project.id, "project.id"),
      name: requiredString(project.name, "project.name"),
      createdAt: requiredString(project.createdAt, "project.createdAt"),
    },
    records: {
      questions: requiredRows(records.questions, "questions"),
      threads: requiredRows(records.threads, "threads"),
      messages: requiredRows(records.messages, "messages"),
      requests: requiredRows(records.requests, "requests"),
      runs: requiredRows(records.runs, "runs"),
      events: requiredRows(records.events, "events"),
      agentRuns: requiredRows(records.agentRuns, "agentRuns"),
      agentRequests: requiredRows(records.agentRequests, "agentRequests"),
      agentItems: requiredRows(records.agentItems, "agentItems"),
      agentContexts: requiredRows(records.agentContexts, "agentContexts"),
    },
  };
}

function readRecordTarget(target: string): ProjectRecord | null {
  let size: number;
  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
      throw new Error("项目记录路径不是普通文件，已停止访问。");
    if (path.relative(target, realpathSync(target)) !== "")
      throw new Error("项目记录文件已被链接到其他位置，已停止访问。");
    size = stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (size > maximumRecordBytes)
    throw new Error("项目记录超过 128 MB，无法安全载入。");
  try {
    return parseRecord(JSON.parse(readFileSync(target, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("项目记录不是有效的 JSON，未覆盖原文件。");
    throw error;
  }
}

function portableContextPayload(payload: unknown, threadId?: string): string {
  const parsed = requiredJsonObject(payload, "agentContexts.payload");
  return JSON.stringify({
    ...parsed,
    ...(threadId ? { threadId } : {}),
    engineThreadId: "",
  });
}

function projectRecordFromDatabase(
  db: DatabaseSync,
  projectId: string,
  savedAt: string,
): ProjectRecord | null {
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Row | undefined;
  if (!project) return null;
  const threadIds = "SELECT id FROM threads WHERE projectId=?";
  const runIds = `SELECT id FROM runs WHERE projectId=? OR threadId IN (${threadIds})`;
  const agentContexts = rows(
    db,
    `SELECT * FROM agent_contexts WHERE threadId IN (${threadIds}) ORDER BY rowid`,
    projectId,
  ).map((row) => {
    const threadId = requiredUuid(row.threadId, "agentContexts.threadId");
    return { ...row, payload: portableContextPayload(row.payload, threadId) };
  });
  return {
    format,
    version,
    savedAt,
    project: {
      id: requiredUuid(project.id, "project.id"),
      name: requiredString(project.name, "project.name"),
      createdAt: requiredString(project.createdAt, "project.createdAt"),
    },
    records: {
      questions: rows(db, "SELECT * FROM questions WHERE projectId=? ORDER BY createdAt, rowid", projectId),
      threads: rows(db, "SELECT * FROM threads WHERE projectId=? ORDER BY createdAt, rowid", projectId),
      messages: rows(db, `SELECT * FROM messages WHERE threadId IN (${threadIds}) ORDER BY rowid`, projectId),
      requests: rows(db, `SELECT * FROM requests WHERE threadId IN (${threadIds}) ORDER BY rowid`, projectId),
      runs: rows(db, `SELECT * FROM runs WHERE projectId=? OR threadId IN (${threadIds}) ORDER BY rowid`, projectId, projectId),
      events: rows(db, `SELECT * FROM events WHERE projectId=? OR runId IN (${runIds}) ORDER BY sequence`, projectId, projectId, projectId),
      agentRuns: rows(
        db,
        `SELECT runId, mode, usage, NULL AS providerId, NULL AS providerFingerprint, NULL AS runtimeConfig
         FROM agent_runs WHERE runId IN (${runIds}) ORDER BY rowid`,
        projectId,
        projectId,
      ),
      agentRequests: rows(db, `SELECT * FROM agent_requests WHERE runId IN (${runIds}) ORDER BY rowid`, projectId, projectId),
      agentItems: rows(db, `SELECT * FROM agent_items WHERE runId IN (${runIds}) OR threadId IN (${threadIds}) ORDER BY sequence, rowid`, projectId, projectId, projectId),
      agentContexts,
    },
  };
}

function comparableProjectRecord(record: ProjectRecord): Omit<ProjectRecord, "savedAt"> {
  return {
    format: record.format,
    version: record.version,
    project: record.project,
    records: {
      ...record.records,
      events: record.records.events.filter((row) => row.type !== "project.record_failed"),
      agentRuns: record.records.agentRuns.map((row) => ({
        ...row,
        providerId: null,
        providerFingerprint: null,
        runtimeConfig: null,
      })),
      agentContexts: record.records.agentContexts.map((row) => {
        const threadId = requiredUuid(row.threadId, "agentContexts.threadId");
        return { ...row, payload: portableContextPayload(row.payload, threadId) };
      }),
    },
  };
}

function matchesLocalProjectRecord(
  db: DatabaseSync,
  projectId: string,
  record: ProjectRecord,
): boolean {
  const local = projectRecordFromDatabase(db, projectId, "");
  return !!local && JSON.stringify(comparableProjectRecord(local)) === JSON.stringify(comparableProjectRecord(record));
}

export function readProjectRecord(root: string): ProjectRecord | null {
  const directory = projectRecordDirectory(safeProjectRoot(root), false);
  if (!directory) return null;
  return readRecordTarget(path.join(directory, "project.json"));
}

export function writeProjectRecord(db: DatabaseSync, projectId: string): boolean {
  const project = db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as Row | undefined;
  if (!project) return false;
  const root = safeProjectRoot(requiredString(project.root, "project.root"));
  const record = projectRecordFromDatabase(db, projectId, new Date().toISOString())!;
  const directory = projectRecordDirectory(root, true)!;
  const target = path.join(directory, "project.json");
  const temporary = path.join(directory, `project.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > maximumRecordBytes)
    throw new Error("项目记录超过 128 MB，无法安全保存。");
  try {
    const existing = readRecordTarget(target);
    if (existing && existing.project.id !== record.project.id)
      throw new Error("此工作文件夹已包含另一个 NEXIOM 项目的记录，已停止覆盖。");
    writeFileSync(temporary, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

function validateRelationships(record: ProjectRecord) {
  const projectId = requiredUuid(record.project.id, "project.id");
  const questionIds = uniqueIds(record.records.questions, "questions");
  const threadIds = uniqueIds(record.records.threads, "threads");
  uniqueIds(record.records.messages, "messages");
  uniqueIds(record.records.requests, "requests");
  const runIds = uniqueIds(record.records.runs, "runs");
  uniqueIds(record.records.events, "events");
  uniqueIds(
    record.records.agentRuns,
    "agentRuns",
    (row) => requiredUuid(row.runId, "agentRuns.runId"),
  );
  uniqueIds(record.records.agentRequests, "agentRequests");
  uniqueIds(
    record.records.agentItems,
    "agentItems",
    (row) => requiredString(row.id, "agentItems.id"),
  );
  uniqueIds(
    record.records.agentContexts,
    "agentContexts",
    (row) => requiredUuid(row.threadId, "agentContexts.threadId"),
  );
  for (const row of record.records.questions)
    if (requiredUuid(row.projectId, "questions.projectId") !== projectId)
      throw new Error("项目记录包含其他项目的问题记录。");
  for (const row of record.records.threads) {
    if (requiredUuid(row.projectId, "threads.projectId") !== projectId)
      throw new Error("项目记录包含其他项目的会话记录。");
    const stageId = requiredEnum(row.stageId, "threads.stageId", threadStages);
    const questionId = optionalUuid(row.questionId, "threads.questionId");
    if (questionId && !questionIds.has(questionId))
      throw new Error("项目记录中的会话关联了不存在的问题。");
    if (!conversationStages.has(stageId) && questionId)
      throw new Error("项目记录中的固定项目对话不能关联赛题。");
    requiredFlag(row.unread, "threads.unread");
  }
  for (const row of record.records.messages) {
    if (!threadIds.has(requiredUuid(row.threadId, "messages.threadId")))
      throw new Error("项目记录中的消息关联了不存在的会话。");
    requiredEnum(row.role, "messages.role", messageRoles);
    requiredEnum(row.kind, "messages.kind", messageKinds);
  }
  for (const row of record.records.requests)
    if (!threadIds.has(requiredUuid(row.threadId, "requests.threadId")))
      throw new Error("项目记录中的请求关联了不存在的会话。");
  const runThreads = new Map<string, string>();
  for (const row of record.records.runs) {
    const runId = requiredUuid(row.id, "runs.id");
    if (requiredUuid(row.projectId, "runs.projectId") !== projectId)
      throw new Error("项目记录包含其他项目的运行记录。");
    const threadId = requiredUuid(row.threadId, "runs.threadId");
    if (!threadIds.has(threadId))
      throw new Error("项目记录中的运行关联了不存在的会话。");
    requiredEnum(row.status, "runs.status", runStatuses);
    runThreads.set(runId, threadId);
  }
  for (const row of record.records.agentRuns) {
    if (!runIds.has(requiredUuid(row.runId, "agentRuns.runId")))
      throw new Error("项目记录中的 agentRuns 关联了不存在的运行。");
    requiredEnum(row.mode, "agentRuns.mode", agentModes);
    const usage = optionalString(row.usage, "agentRuns.usage");
    if (usage !== null) requiredJsonObject(usage, "agentRuns.usage");
    const fingerprint = optionalString(row.providerFingerprint, "agentRuns.providerFingerprint");
    if (fingerprint !== null && !/^[0-9a-f]{64}$/i.test(fingerprint))
      throw new Error("项目记录中的 agentRuns.providerFingerprint 无效。");
    const runtimeConfig = optionalString(row.runtimeConfig, "agentRuns.runtimeConfig");
    if (runtimeConfig !== null) requiredJsonObject(runtimeConfig, "agentRuns.runtimeConfig");
  }
  for (const row of record.records.agentRequests) {
    if (!runIds.has(requiredUuid(row.runId, "agentRequests.runId")))
      throw new Error("项目记录中的 agentRequests 关联了不存在的运行。");
    if (!/^[0-9a-f]{64}$/i.test(requiredString(row.digest, "agentRequests.digest")))
      throw new Error("项目记录中的 agentRequests.digest 无效。");
  }
  for (const row of record.records.agentItems) {
    const runId = requiredUuid(row.runId, "agentItems.runId");
    const threadId = requiredUuid(row.threadId, "agentItems.threadId");
    if (!runIds.has(runId) || !threadIds.has(threadId))
      throw new Error("项目记录中的 Agent 条目关联无效。");
    if (runThreads.get(runId) !== threadId)
      throw new Error("项目记录中的 Agent 条目关联了其他会话的运行。");
    requiredEnum(row.status, "agentItems.status", agentItemStatuses);
    const item = requiredJsonObject(row.payload, "agentItems.payload");
    requiredString(item.id, "agentItems.payload.id");
    requiredEnum(item.type, "agentItems.payload.type", agentItemTypes);
  }
  for (const row of record.records.agentContexts) {
    const threadId = requiredUuid(row.threadId, "agentContexts.threadId");
    if (!threadIds.has(threadId))
      throw new Error("项目记录中的 Agent 上下文关联无效。");
    const context = requiredJsonObject(row.payload, "agentContexts.payload");
    if (requiredUuid(context.threadId, "agentContexts.payload.threadId") !== threadId)
      throw new Error("项目记录中的 Agent 上下文关联了其他会话。");
    if (context.engine !== "codex" || context.transport !== "app-server")
      throw new Error("项目记录中的 Agent 上下文类型无效。");
  }
  const eventSequences = new Set<number>();
  for (const row of record.records.events) {
    if (requiredUuid(row.projectId, "events.projectId") !== projectId)
      throw new Error("项目记录包含其他项目的事件记录。");
    const runId = optionalUuid(row.runId, "events.runId");
    if (runId && !runIds.has(runId))
      throw new Error("项目记录中的事件关联了不存在的运行。");
    const sequence = requiredSequence(row.sequence, "events.sequence");
    if (eventSequences.has(sequence))
      throw new Error("项目记录中的 events.sequence 包含重复值。");
    eventSequences.add(sequence);
  }
}

function mapped(map: Map<string, string>, value: unknown, field: string): string {
  const source = requiredString(value, field);
  const result = map.get(source);
  if (!result) throw new Error(`项目记录中的 ${field} 关联无效。`);
  return result;
}

function remapContext(payload: unknown, threadId: string): string {
  return portableContextPayload(payload, threadId);
}

export function importProjectRecord(
  db: DatabaseSync,
  root: string,
  record: ProjectRecord,
): ImportedProjectRecord {
  root = safeProjectRoot(root);
  validateRelationships(record);
  const matchingIdentity = db.prepare("SELECT * FROM projects WHERE id=?").get(record.project.id) as Row | undefined;
  if (matchingIdentity) {
    const previousRoot = requiredString(matchingIdentity.root, "projects.root");
    let previousRootExists = false;
    try {
      previousRootExists = statSync(previousRoot).isDirectory();
    } catch {
      previousRootExists = false;
    }
    if (!previousRootExists) {
      if (!matchesLocalProjectRecord(db, record.project.id, record))
        throw new Error(
          "此文件夹中的项目记录与本机同一项目的记录不一致。为避免覆盖较新的工作内容，已停止重新关联。",
        );
      db.prepare("UPDATE projects SET root=? WHERE id=?").run(root, record.project.id);
      const project = { ...matchingIdentity, root } as unknown as Project;
      const threadRow = db.prepare("SELECT * FROM threads WHERE projectId=? ORDER BY createdAt, rowid LIMIT 1")
        .get(project.id) as Row | undefined;
      return {
        project,
        thread: threadRow ? ({ ...threadRow, unread: Boolean(threadRow.unread) } as unknown as Thread) : undefined,
        relocated: true,
      };
    }
    throw new Error("同一 NEXIOM 项目标识已关联到另一个仍存在的工作文件夹，无法重复导入副本。");
  }

  const projectId = requiredUuid(record.project.id, "project.id");
  const questionMap = new Map<string, string>();
  const threadMap = new Map<string, string>();
  const runMap = new Map<string, string>();
  for (const row of record.records.questions)
    questionMap.set(requiredUuid(row.id, "questions.id"), requiredUuid(row.id, "questions.id"));
  for (const row of record.records.threads)
    threadMap.set(requiredUuid(row.id, "threads.id"), requiredUuid(row.id, "threads.id"));
  for (const row of record.records.runs)
    runMap.set(requiredUuid(row.id, "runs.id"), requiredUuid(row.id, "runs.id"));

  const sequenceValues = [
    ...record.records.events.map((row) => requiredSequence(row.sequence, "events.sequence")),
    ...record.records.messages.map((row) => requiredSequence(row.sequence, "messages.sequence")),
    ...record.records.agentItems.map((row) => requiredSequence(row.sequence, "agentItems.sequence")),
  ];
  const orderedSequences = [...new Set(sequenceValues)].sort((a, b) => a - b);
  const maximum = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM events").get() as Row).maximum);
  const sequenceMap = new Map(orderedSequences.map((value, index) => [value, maximum + index + 1]));
  const sequence = (value: unknown, field: string) => {
    const result = sequenceMap.get(requiredSequence(value, field));
    if (!result) throw new Error(`项目记录中的 ${field} 无效。`);
    return result;
  };

  const project: Project = {
    id: projectId,
    name: record.project.name,
    root,
    createdAt: record.project.createdAt,
  };
  db.prepare("INSERT INTO projects (id,name,root,createdAt) VALUES (?, ?, ?, ?)")
    .run(project.id, project.name, project.root, project.createdAt);
  const insertQuestion = db.prepare("INSERT INTO questions (id,projectId,name,createdAt) VALUES (?, ?, ?, ?)");
  for (const row of record.records.questions)
    insertQuestion.run(
      mapped(questionMap, row.id, "questions.id"),
      projectId,
      requiredString(row.name, "questions.name"),
      requiredString(row.createdAt, "questions.createdAt"),
    );
  const insertThread = db.prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId,unread,archivedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const row of record.records.threads) {
    const questionId = optionalString(row.questionId, "threads.questionId");
    insertThread.run(
      mapped(threadMap, row.id, "threads.id"),
      projectId,
      requiredString(row.title, "threads.title"),
      requiredString(row.createdAt, "threads.createdAt"),
      requiredString(row.stageId, "threads.stageId"),
      questionId ? mapped(questionMap, questionId, "threads.questionId") : null,
      requiredFlag(row.unread, "threads.unread") ? 1 : 0,
      optionalString(row.archivedAt, "threads.archivedAt"),
    );
  }
  if (!threadMap.size) {
    const id = randomUUID();
    threadMap.set(id, id);
    insertThread.run(id, projectId, "研究笔记", new Date().toISOString(), "model", null, 0, null);
  }
  const insertMessage = db.prepare("INSERT INTO messages (id,threadId,role,kind,text,createdAt,sequence) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of record.records.messages)
    insertMessage.run(
      requiredUuid(row.id, "messages.id"),
      mapped(threadMap, row.threadId, "messages.threadId"),
      requiredString(row.role, "messages.role"),
      requiredString(row.kind, "messages.kind"),
      typeof row.text === "string" ? row.text : (() => { throw new Error("项目记录中的 messages.text 无效。"); })(),
      requiredString(row.createdAt, "messages.createdAt"),
      sequence(row.sequence, "messages.sequence"),
    );
  const insertRequest = db.prepare("INSERT INTO requests (id,threadId,text) VALUES (?, ?, ?)");
  for (const row of record.records.requests)
    insertRequest.run(
      requiredUuid(row.id, "requests.id"),
      mapped(threadMap, row.threadId, "requests.threadId"),
      typeof row.text === "string" ? row.text : (() => { throw new Error("项目记录中的 requests.text 无效。"); })(),
    );
  const insertRun = db.prepare("INSERT INTO runs (id,threadId,projectId,status,createdAt,finishedAt) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of record.records.runs) {
    const status = requiredString(row.status, "runs.status");
    insertRun.run(
      mapped(runMap, row.id, "runs.id"),
      mapped(threadMap, row.threadId, "runs.threadId"),
      projectId,
      status === "running" ? "interrupted" : status,
      requiredString(row.createdAt, "runs.createdAt"),
      status === "running" ? new Date().toISOString() : optionalString(row.finishedAt, "runs.finishedAt"),
    );
  }
  const insertAgentRun = db.prepare("INSERT INTO agent_runs (runId,mode,usage,providerId,providerFingerprint,runtimeConfig) VALUES (?, ?, ?, ?, ?, ?)");
  for (const row of record.records.agentRuns) {
    const runId = mapped(runMap, row.runId, "agentRuns.runId");
    insertAgentRun.run(
      runId,
      requiredString(row.mode, "agentRuns.mode"),
      optionalString(row.usage, "agentRuns.usage"),
      null,
      null,
      null,
    );
  }
  const insertAgentRequest = db.prepare("INSERT INTO agent_requests (id,digest,runId) VALUES (?, ?, ?)");
  for (const row of record.records.agentRequests)
    insertAgentRequest.run(
      requiredUuid(row.id, "agentRequests.id"),
      requiredString(row.digest, "agentRequests.digest"),
      mapped(runMap, row.runId, "agentRequests.runId"),
    );
  const insertEvent = db.prepare("INSERT INTO events (sequence,id,projectId,type,runId,summary,createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of record.records.events) {
    const runId = optionalString(row.runId, "events.runId");
    insertEvent.run(
      sequence(row.sequence, "events.sequence"),
      requiredUuid(row.id, "events.id"),
      projectId,
      requiredString(row.type, "events.type"),
      runId ? mapped(runMap, runId, "events.runId") : null,
      typeof row.summary === "string" ? row.summary : (() => { throw new Error("项目记录中的 events.summary 无效。"); })(),
      requiredString(row.createdAt, "events.createdAt"),
    );
  }
  const insertItem = db.prepare("INSERT INTO agent_items (id,runId,threadId,sequence,status,payload,updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const row of record.records.agentItems)
    insertItem.run(
      requiredString(row.id, "agentItems.id"),
      mapped(runMap, row.runId, "agentItems.runId"),
      mapped(threadMap, row.threadId, "agentItems.threadId"),
      sequence(row.sequence, "agentItems.sequence"),
      row.status === "running" ? "interrupted" : requiredString(row.status, "agentItems.status"),
      requiredString(row.payload, "agentItems.payload"),
      requiredString(row.updatedAt, "agentItems.updatedAt"),
    );
  const insertContext = db.prepare("INSERT INTO agent_contexts (threadId,payload) VALUES (?, ?)");
  for (const row of record.records.agentContexts) {
    const threadId = mapped(threadMap, row.threadId, "agentContexts.threadId");
    insertContext.run(threadId, remapContext(row.payload, threadId));
  }
  const firstThreadRow = db.prepare("SELECT * FROM threads WHERE projectId=? ORDER BY createdAt, rowid LIMIT 1")
    .get(projectId) as Row | undefined;
  return {
    project,
    thread: firstThreadRow ? ({ ...firstThreadRow, unread: Boolean(firstThreadRow.unread) } as unknown as Thread) : undefined,
    relocated: false,
  };
}
