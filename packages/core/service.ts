import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  readdir,
  lstat,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import {
  accountProfileSchema,
  commandSchema,
  type CoreResponse,
  type Project,
  type Thread,
  type Question,
  type AccountProfile,
  type Run,
  type Message,
  type CoreEvent,
  type ProjectFile,
} from "../contracts";
import { acquireLease } from "./lease";
import { AgentCoordinator } from "./agent";
import type { AgentRunner } from "../runtime";
import { CodexRuntime } from "../runtime/codex";
import { readProjectMemory, writeProjectMemory } from "./memory";
import { readVisualCatalog, readVisualAsset } from "./visual-library";
import { getVisualDesignRuntimeStatus } from "../runtime/visual-design";
import { listVisualWorkspace, readVisualAsset as readAgentVisualAsset, saveVisualAsset, validateVisualEdit } from "../visualization/store";
import { renderVisualFigure } from "../visualization/render";
import {
  importProjectRecord,
  readProjectRecord,
  writeProjectRecord,
} from "./project-record";

const now = () => new Date().toISOString();
const schemaVersionCurrent = 9;
const projectChatNames = {
  reading: "赛题研读",
  attachments: "附件分析",
  delivery: "检查交付",
} as const;
type ThreadRow = Omit<Thread, "unread"> & { unread: boolean | number };
const readThread = (row: ThreadRow): Thread => ({ ...row, unread: Boolean(row.unread) });
const conversationStages = new Set(["model", "validation", "chart", "paper"]);
export function projectNameFromRoot(root: string): string {
  const basename = path.basename(root).trim();
  if (basename) return basename;
  return path.parse(root).root.replace(/[\\/]+$/, "").trim() || root.trim() || "未命名项目";
}
export function isFilesystemRoot(root: string): boolean {
  const resolved = path.resolve(root);
  return path.relative(path.parse(resolved).root, resolved) === "";
}
const ignored = new Set([
  ".git",
  ".nexiom",
  "node_modules",
  ".local",
  ".build",
  "dist",
  ".venv",
]);

function columns(db: DatabaseSync, table: string) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
}

function initializeSchema(db: DatabaseSync, schemaVersion: number) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(projectId, name));
    CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, createdAt TEXT NOT NULL, stageId TEXT NOT NULL DEFAULT 'model' CHECK(stageId IN ('overview','reading','attachments','model','validation','chart','paper','delivery')), questionId TEXT REFERENCES questions(id), unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN (0,1)), archivedAt TEXT, CHECK(stageId IN ('model','validation','chart','paper') OR questionId IS NULL));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id), role TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, threadId TEXT NOT NULL REFERENCES threads(id), projectId TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL, createdAt TEXT NOT NULL, finishedAt TEXT);
    CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, projectId TEXT NOT NULL REFERENCES projects(id), type TEXT NOT NULL, runId TEXT, summary TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_runs (runId TEXT PRIMARY KEY REFERENCES runs(id), mode TEXT NOT NULL, usage TEXT, providerId TEXT, providerFingerprint TEXT, runtimeConfig TEXT);
    CREATE TABLE IF NOT EXISTS agent_requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, runId TEXT NOT NULL REFERENCES runs(id));
    CREATE TABLE IF NOT EXISTS agent_threads (threadId TEXT NOT NULL REFERENCES threads(id), engineThreadId TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(threadId, fingerprint));
    CREATE TABLE IF NOT EXISTS agent_items (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), threadId TEXT NOT NULL REFERENCES threads(id), sequence INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_contexts (threadId TEXT PRIMARY KEY REFERENCES threads(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, endpoint TEXT NOT NULL, modelName TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, auth TEXT NOT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
  `);
  const providerColumns = columns(db, "model_providers");
  if (!providerColumns.has("modelName")) {
    db.exec("ALTER TABLE model_providers ADD COLUMN modelName TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE model_providers SET modelName=model WHERE modelName='' AND model<>''");
  }
  const navigationColumns = columns(db, "threads");
  if (!navigationColumns.has("stageId"))
    db.exec("ALTER TABLE threads ADD COLUMN stageId TEXT NOT NULL DEFAULT 'model' CHECK(stageId IN ('overview','reading','attachments','model','validation','chart','paper','delivery'))");
  if (!navigationColumns.has("questionId"))
    db.exec("ALTER TABLE threads ADD COLUMN questionId TEXT REFERENCES questions(id)");
  if (schemaVersion < 7) {
    // Rebuild only the parent table, retaining its name and IDs for all history
    // and runtime bindings. Renaming the old table would rewrite child FKs.
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE threads_v7 (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, createdAt TEXT NOT NULL, stageId TEXT NOT NULL DEFAULT 'model' CHECK(stageId IN ('overview','reading','attachments','model','validation','chart','paper','delivery')), questionId TEXT REFERENCES questions(id), unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN (0,1)), archivedAt TEXT, CHECK(stageId IN ('model','validation','chart','paper') OR questionId IS NULL));
        INSERT INTO threads_v7 (id,projectId,title,createdAt,stageId,questionId,unread,archivedAt)
          SELECT id,projectId,title,createdAt,stageId,questionId,0,NULL FROM threads;
        DROP TABLE threads;
        ALTER TABLE threads_v7 RENAME TO threads;
      `);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("工作空间升级时检测到无效的记录关联，原会话数据已保留。");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }
  const threadStateColumns = columns(db, "threads");
  if (!threadStateColumns.has("unread")) db.exec("ALTER TABLE threads ADD COLUMN unread INTEGER NOT NULL DEFAULT 0 CHECK(unread IN (0,1))");
  if (!threadStateColumns.has("archivedAt")) db.exec("ALTER TABLE threads ADD COLUMN archivedAt TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS threads_project_stage ON threads(projectId, stageId);
    CREATE UNIQUE INDEX IF NOT EXISTS threads_project_single_chat ON threads(projectId, stageId)
      WHERE stageId IN ('overview','reading','attachments','delivery');
  `);
  const runColumns = columns(db, "agent_runs");
  if (!runColumns.has("providerId"))
    db.exec("ALTER TABLE agent_runs ADD COLUMN providerId TEXT");
  if (!runColumns.has("providerFingerprint"))
    db.exec("ALTER TABLE agent_runs ADD COLUMN providerFingerprint TEXT");
  if (!runColumns.has("runtimeConfig"))
    db.exec("ALTER TABLE agent_runs ADD COLUMN runtimeConfig TEXT");
  const threadInfo = db.prepare("PRAGMA table_info(agent_threads)").all();
  const compositeBinding = threadInfo.some(
    (row) => String(row.name) === "fingerprint" && Number(row.pk) > 0,
  );
  if (!compositeBinding) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE agent_threads RENAME TO agent_threads_v3;
      CREATE TABLE agent_threads (threadId TEXT NOT NULL REFERENCES threads(id), engineThreadId TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(threadId, fingerprint));
      INSERT INTO agent_threads (threadId, engineThreadId, fingerprint) SELECT threadId, engineThreadId, fingerprint FROM agent_threads_v3;
      DROP TABLE agent_threads_v3;
      COMMIT;
    `);
  }
  const renameProject = db.prepare("UPDATE projects SET name=? WHERE id=?");
  for (const row of db.prepare("SELECT id, name, root FROM projects").all()) {
    if (!String(row.name).trim())
      renameProject.run(projectNameFromRoot(String(row.root)), String(row.id));
  }
}

function initializeProviders(db: DatabaseSync, schemaVersion: number) {
  const saved = db
    .prepare("SELECT value FROM settings WHERE key='agent'")
    .get();
  let legacy: Record<string, unknown> = {};
  try {
    legacy = saved ? JSON.parse(String(saved.value)) : {};
  } catch {
    legacy = {};
  }
  const timestamp = now();
  const oldConnection = legacy.connection === "custom" ? "custom" : "local";
  const oldEndpoint = typeof legacy.endpoint === "string" ? legacy.endpoint : "";
  const oldModel = typeof legacy.model === "string" ? legacy.model : "";
  db.prepare(
    `INSERT OR IGNORE INTO model_providers
      (id,name,kind,endpoint,modelName,model,auth,revision,createdAt,updatedAt)
     VALUES ('nexiom-default','NEXIOM API','responses','https://api.openai.com/v1','','','bearer',1,?,?)`,
  ).run(timestamp, timestamp);
  if (oldConnection === "custom")
    db.prepare(
      `INSERT OR IGNORE INTO model_providers
        (id,name,kind,endpoint,modelName,model,auth,revision,createdAt,updatedAt)
       VALUES ('legacy-custom','原有自定义 API','responses',?,?,?,'bearer',1,?,?)`,
    ).run(oldEndpoint, oldModel, oldModel, timestamp, timestamp);
  const requestedActive =
    typeof legacy.activeProviderId === "string"
      ? legacy.activeProviderId
      : oldConnection === "custom"
        ? "legacy-custom"
        : "nexiom-default";
  // Shared runtime sessions must never be resumed from the private runtime.
  // Only the bindings and live context are removed; messages, runs and files remain.
  if (schemaVersion < 6) {
    db.exec("DELETE FROM agent_threads; DELETE FROM agent_contexts;");
  }
  db.exec("DELETE FROM model_providers WHERE kind='local_codex' OR id='local-codex'");
  const active = db
    .prepare("SELECT id FROM model_providers WHERE id=? AND kind='responses'")
    .get(requestedActive)
    ? requestedActive
    : "nexiom-default";
  const settings = {
    activeProviderId: active,
    effort: ["default", "low", "medium", "high", "xhigh"].includes(
      String(legacy.effort),
    )
      ? legacy.effort
      : "default",
    network: legacy.network === true,
  };
  db.prepare(
    "INSERT INTO settings VALUES ('agent', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(JSON.stringify(settings));
  db.exec(`PRAGMA user_version=${schemaVersionCurrent}`);
}

export class CoreService {
  private db!: DatabaseSync;
  private releaseLease: () => void;
  private closed = false;
  private agent!: AgentCoordinator;
  private dirtyProjectRecords = new Set<string>();
  private projectRecordFailures = new Map<string, string>();
  private projectRecordTimer: NodeJS.Timeout | undefined;
  constructor(
    private dataDir: string,
    private notify: () => void = () => {},
    options: { runner?: AgentRunner } = {},
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.releaseLease = acquireLease(dataDir);
    try {
      this.db = new DatabaseSync(path.join(dataDir, "workspace.sqlite"));
      const version = this.db.prepare("PRAGMA user_version").get();
      const schemaVersion = Number(version?.user_version);
      if (schemaVersion > schemaVersionCurrent)
        throw new Error("工作空间版本高于当前应用，无法写入。");
      initializeSchema(this.db, schemaVersion);
      this.transaction(() => initializeProviders(this.db, schemaVersion));
      this.agent = new AgentCoordinator(
        this.db,
        {
          notify: this.publish.bind(this),
          changed: this.projectChanged.bind(this),
          event: this.event.bind(this),
          message: this.message.bind(this),
          transaction: this.transaction.bind(this),
        },
        options.runner ?? new CodexRuntime({ runtimeHome: path.resolve(dataDir, "runtime") }),
      );
      const interrupted = this.db
        .prepare("SELECT * FROM runs WHERE status = 'running'")
        .all() as unknown as Run[];
      this.transaction(() => {
        for (const run of interrupted) {
          this.db
            .prepare(
              "UPDATE runs SET status='interrupted', finishedAt=? WHERE id=?",
            )
            .run(now(), run.id);
          this.event(
            run.projectId,
            "run.interrupted",
            "上次任务因核心退出而中断，未自动重新执行。",
            run.id,
          );
        }
        this.db
          .prepare(
            "UPDATE agent_items SET status='interrupted' WHERE status='running'",
          )
          .run();
      });
      for (const row of this.db.prepare("SELECT id FROM projects").all())
        this.projectChanged(String(row.id));
      this.flushProjectRecords();
    } catch (error) {
      this.db?.close();
      this.releaseLease();
      throw error;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private projectChanged(projectId: string) {
    this.dirtyProjectRecords.add(projectId);
  }
  private flushProjectRecords() {
    clearTimeout(this.projectRecordTimer);
    this.projectRecordTimer = undefined;
    for (const projectId of [...this.dirtyProjectRecords]) {
      try {
        if (!writeProjectRecord(this.db, projectId)) {
          this.dirtyProjectRecords.delete(projectId);
          this.projectRecordFailures.delete(projectId);
          continue;
        }
        this.dirtyProjectRecords.delete(projectId);
        this.projectRecordFailures.delete(projectId);
      } catch (error) {
        const message = (error as Error).message || "未知错误";
        if (this.projectRecordFailures.get(projectId) !== message) {
          this.projectRecordFailures.set(projectId, message);
          console.error(`无法保存项目记录 ${projectId}: ${message}`);
          if (this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId))
            this.db.prepare(
              "INSERT INTO events (id,projectId,type,runId,summary,createdAt) VALUES (?, ?, 'project.record_failed', NULL, ?, ?)",
            ).run(randomUUID(), projectId, `无法将项目记录保存到工作文件夹：${message}`, now());
        }
      }
    }
  }
  private publish(options: { deferProjectRecord?: boolean } = {}) {
    // SQLite contains the live state. The portable project record is a mirror:
    // streaming must not synchronously rewrite all history for every delta.
    // Do not reset this timer on updates: continuous output still checkpoints.
    if (options.deferProjectRecord && !this.closed) {
      if (this.dirtyProjectRecords.size && !this.projectRecordTimer) {
        this.projectRecordTimer = setTimeout(() => {
          this.projectRecordTimer = undefined;
          if (this.closed) return;
          this.flushProjectRecords();
          this.notify();
        }, 1000);
        this.projectRecordTimer.unref();
      }
    } else {
      // Commands, run completion/cancellation and close retain a flush barrier.
      this.flushProjectRecords();
    }
    this.notify();
  }
  private project(id: string): Project {
    const project = this.db
      .prepare("SELECT * FROM projects WHERE id=?")
      .get(id) as unknown as Project | undefined;
    if (!project) throw new Error("项目不存在。");
    return project;
  }
  private async projectWorkspace(id: string): Promise<Project> {
    const project = this.project(id);
    const configuredRoot = path.resolve(project.root);
    let root: string;
    try {
      root = await realpath(configuredRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new Error("项目工作文件夹不存在。请重新选择文件夹，或从 NEXIOM 中移除该项目。");
      throw new Error("无法访问项目工作文件夹。请检查文件夹权限或重新选择文件夹。");
    }
    let stat;
    try {
      stat = await lstat(root);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new Error("项目工作文件夹不存在。请重新选择文件夹，或从 NEXIOM 中移除该项目。");
      throw new Error("无法访问项目工作文件夹。请检查文件夹权限或重新选择文件夹。");
    }
    if (!stat.isDirectory())
      throw new Error("项目工作路径不是文件夹。请重新选择文件夹，或从 NEXIOM 中移除该项目。");
    if (isFilesystemRoot(root))
      throw new Error(`当前项目工作路径“${root}”是磁盘或文件系统根目录，不能用作赛题工作区。请返回“所有赛题”，点击“选择赛题工作文件夹”，选择存放本题资料的具体文件夹（例如 ${path.join(root, "赛题", "A题")}）。`);
    if (path.relative(configuredRoot, root) !== "")
      throw new Error("项目工作文件夹已被链接到其他位置。请移除该项目，再选择实际的赛题工作文件夹。");
    return { ...project, root };
  }
  private thread(id: string): Thread {
    const thread = this.db
      .prepare("SELECT * FROM threads WHERE id=?")
      .get(id) as unknown as ThreadRow | undefined;
    if (!thread) throw new Error("会话不存在。");
    return readThread(thread);
  }
  private editableConversation(thread: Thread) {
    if (!conversationStages.has(thread.stageId))
      throw new Error("项目固定对话不能执行此操作。");
    if (this.db.prepare("SELECT id FROM runs WHERE threadId=? AND status='running'").get(thread.id))
      throw new Error("此对话仍有任务正在运行，请等待任务结束或先停止任务。");
  }
  private questionForProject(questionId: string | null, projectId: string): string | null {
    if (!questionId) return null;
    const source = this.db.prepare("SELECT name FROM questions WHERE id=?").get(questionId);
    if (!source) return null;
    const name = String(source.name);
    const existing = this.db.prepare("SELECT id FROM questions WHERE projectId=? AND name=?")
      .get(projectId, name);
    if (existing) return String(existing.id);
    const id = randomUUID();
    this.db.prepare("INSERT INTO questions (id,projectId,name,createdAt) VALUES (?, ?, ?, ?)")
      .run(id, projectId, name, now());
    return id;
  }
  private deleteConversationRecords(thread: Thread) {
    const runs = "SELECT id FROM runs WHERE threadId=?";
    this.db.prepare(`DELETE FROM agent_items WHERE runId IN (${runs}) OR threadId=?`).run(thread.id, thread.id);
    this.db.prepare(`DELETE FROM agent_requests WHERE runId IN (${runs})`).run(thread.id);
    this.db.prepare(`DELETE FROM agent_runs WHERE runId IN (${runs})`).run(thread.id);
    this.db.prepare(`DELETE FROM events WHERE runId IN (${runs})`).run(thread.id);
    this.db.prepare("DELETE FROM agent_contexts WHERE threadId=?").run(thread.id);
    this.db.prepare("DELETE FROM agent_threads WHERE threadId=?").run(thread.id);
    this.db.prepare("DELETE FROM messages WHERE threadId=?").run(thread.id);
    this.db.prepare("DELETE FROM requests WHERE threadId=?").run(thread.id);
    this.db.prepare("DELETE FROM runs WHERE threadId=?").run(thread.id);
    this.db.prepare("DELETE FROM threads WHERE id=?").run(thread.id);
    if (thread.questionId)
      this.db.prepare("DELETE FROM questions WHERE id=? AND NOT EXISTS (SELECT 1 FROM threads WHERE questionId=?)")
        .run(thread.questionId, thread.questionId);
  }
  private account(): AccountProfile {
    const saved = this.db.prepare("SELECT value FROM settings WHERE key='account'").get();
    try {
      return accountProfileSchema.parse(saved ? JSON.parse(String(saved.value)) : {});
    } catch {
      return accountProfileSchema.parse({});
    }
  }
  private message(
    threadId: string,
    role: Message["role"],
    kind: Message["kind"],
    text: string,
  ) {
    const sequence = this.event(
      this.thread(threadId).projectId,
      "message.created",
      role === "user" ? "研究笔记已保存。" : "核心反馈已保存。",
    );
    this.db
      .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), threadId, role, kind, text, now(), sequence);
  }
  private event(
    projectId: string,
    type: string,
    summary: string,
    runId: string | null = null,
  ) {
    const sequence = Number(
      this.db
        .prepare(
          "INSERT INTO events (id, projectId, type, runId, summary, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(randomUUID(), projectId, type, runId, summary, now())
        .lastInsertRowid,
    );
    this.projectChanged(projectId);
    return sequence;
  }
  snapshot(): CoreResponse {
    return {
      snapshot: {
        projects: this.db
          .prepare("SELECT * FROM projects ORDER BY createdAt")
          .all() as unknown as Project[],
        questions: this.db
          .prepare("SELECT * FROM questions ORDER BY createdAt")
          .all() as unknown as Question[],
        threads: (this.db
          .prepare("SELECT * FROM threads ORDER BY createdAt")
          .all() as unknown as ThreadRow[]).map(readThread),
        messages: this.db
          .prepare("SELECT * FROM messages ORDER BY rowid")
          .all() as unknown as Message[],
        runs: this.db
          .prepare(
            "SELECT runs.*, CASE WHEN agent_runs.runId IS NULL THEN 'inspection' ELSE 'agent' END AS kind, agent_runs.mode, agent_runs.usage, agent_runs.providerId, agent_runs.providerFingerprint, agent_runs.runtimeConfig FROM runs LEFT JOIN agent_runs ON agent_runs.runId=runs.id ORDER BY runs.rowid",
          )
          .all() as unknown as Run[],
        events: this.db
          .prepare(
            "SELECT * FROM (SELECT * FROM events ORDER BY sequence DESC LIMIT 500) ORDER BY sequence",
          )
          .all() as unknown as CoreEvent[],
        runtime: this.agent.state,
        settings: this.agent.settings,
        providers: this.agent.providers(),
        items: this.agent.items(),
        contexts: this.agent.contexts(),
        account: this.account(),
      },
    };
  }
  async openProject(root: string, name?: string): Promise<CoreResponse> {
    const resolved = await realpath(root);
    if (!(await lstat(resolved)).isDirectory())
      throw new Error("请选择文件夹。");
    if (isFilesystemRoot(resolved))
      throw new Error(`所选路径“${resolved}”是磁盘或文件系统根目录。请选择具体的赛题工作文件夹（例如 ${path.join(resolved, "赛题", "A题")}）。`);
    const existing = this.db
      .prepare("SELECT * FROM projects WHERE root=?")
      .get(resolved) as unknown as Project | undefined;
    if (existing) {
      if (!existing.name.trim()) {
        existing.name = projectNameFromRoot(resolved);
        this.db.prepare("UPDATE projects SET name=? WHERE id=?").run(existing.name, existing.id);
        this.projectChanged(existing.id);
        this.publish();
      } else {
        this.projectChanged(existing.id);
        this.flushProjectRecords();
      }
      return { ...this.snapshot(), project: existing };
    }
    let savedRecord;
    try {
      savedRecord = readProjectRecord(resolved);
    } catch (error) {
      throw new Error(`无法载入此文件夹中的 NEXIOM 项目记录：${(error as Error).message}`);
    }
    if (savedRecord) {
      let imported!: ReturnType<typeof importProjectRecord>;
      try {
        this.transaction(() => {
          imported = importProjectRecord(this.db, resolved, savedRecord);
          this.event(
            imported.project.id,
            imported.relocated ? "project.relocated" : "project.restored",
            imported.relocated
              ? `已在新位置重新关联项目「${imported.project.name}」。`
              : `已从工作文件夹恢复项目「${imported.project.name}」。`,
          );
        });
      } catch (error) {
        throw new Error(`无法恢复此文件夹中的 NEXIOM 项目记录：${(error as Error).message}`);
      }
      this.publish();
      return {
        ...this.snapshot(),
        project: imported.project,
        ...(imported.thread ? { thread: imported.thread } : {}),
      };
    }
    const project = {
      id: randomUUID(),
      name: name?.trim() || projectNameFromRoot(resolved),
      root: resolved,
      createdAt: now(),
    };
    const thread: Thread = {
      id: randomUUID(),
      projectId: project.id,
      title: "研究笔记",
      createdAt: now(),
      stageId: "model",
      questionId: null,
      unread: false,
      archivedAt: null,
    };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO projects VALUES (?, ?, ?, ?)")
        .run(project.id, project.name, project.root, project.createdAt);
      this.db
        .prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId) VALUES (?, ?, ?, ?, ?, ?)")
        .run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.stageId, thread.questionId);
      this.event(
        project.id,
        "project.opened",
        `已打开项目「${project.name}」。`,
      );
    });
    this.publish();
    return { ...this.snapshot(), project, thread };
  }

  private async contained(
    project: Project,
    relativePath: string,
  ): Promise<string> {
    const target = await realpath(path.resolve(project.root, relativePath));
    const root = await realpath(project.root);
    const relative = path.relative(root, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error("文件路径超出项目范围。");
    if (
      relative.split(path.sep).some((part) => ignored.has(part.toLowerCase()))
    )
      throw new Error("该目录不对工作区开放。");
    return target;
  }
  private async files(project: Project): Promise<ProjectFile[]> {
    const result: ProjectFile[] = [];
    const visit = async (relative: string, depth: number) => {
      if (depth > 8) return;
      const directory = await this.contained(project, relative);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (ignored.has(entry.name.toLowerCase()) || entry.isSymbolicLink())
          continue;
        if (result.length >= 1000)
          throw new Error("项目文件超过 1000 个，请选择更小的研究目录。");
        const child = path.join(relative, entry.name);
        if (entry.isDirectory()) await visit(child, depth + 1);
        else if (entry.isFile()) {
          const target = await this.contained(project, child);
          const stat = await lstat(target);
          result.push({
            path: child.replaceAll("\\", "/"),
            name: entry.name,
            size: stat.size,
            extension: path.extname(entry.name).toLowerCase(),
          });
        }
      }
    };
    await visit("", 0);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async request(input: unknown): Promise<CoreResponse> {
    if (this.closed) throw new Error("核心已关闭。");
    const command = commandSchema.parse(input);
    switch (command.type) {
      case "visual.catalog":
        return { visualCatalog: await readVisualCatalog() };
      case "visual.palettes":
        return { visualPalettes: (await readVisualCatalog()).palettes };
      case "visual.workspace": {
        const project = await this.projectWorkspace(command.projectId);
        return { visualWorkspace: await listVisualWorkspace(project.root) };
      }
      case "visual.figure.read": {
        const project = await this.projectWorkspace(command.projectId);
        return { visualFigure: await readAgentVisualAsset(project.root, command.library, command.id) };
      }
      case "visual.figure.preview": {
        const project = await this.projectWorkspace(command.projectId);
        const asset = await readAgentVisualAsset(project.root, command.library, command.id);
        return { visualPreview: renderVisualFigure(validateVisualEdit(asset.figure, command.figure)) };
      }
      case "visual.figure.save": {
        const project = await this.projectWorkspace(command.projectId);
        const visualFigure = await saveVisualAsset(project.root, command);
        this.event(project.id, "visual.figure.saved", `已保存${command.library === "modeling" ? "建模过程" : "论文论述"}素材「${visualFigure.title}」第 ${visualFigure.revision} 版。`);
        this.publish();
        return { visualFigure, savedPath: visualFigure.imagePath };
      }
      case "visual.asset":
        return { file: await readVisualAsset(command.assetId) };
      case "visual.status": {
        const { available, label, python, bundleVersion } = await getVisualDesignRuntimeStatus();
        return { visualStatus: { available, label, python, bundleVersion } };
      }
      case "visual.image.read": {
        const target = await this.contained(
          await this.projectWorkspace(command.projectId),
          command.path,
        );
        const stat = await lstat(target);
        if (!stat.isFile()) throw new Error("目标不是图片文件。");
        if (stat.size > 20 * 1024 * 1024)
          throw new Error("图片换色支持不超过 20 MB 的项目图片。");
        const mime = (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
          } as Record<string, string>
        )[path.extname(target).toLowerCase()];
        if (!mime) throw new Error("图片换色仅支持 PNG、JPEG 和 WebP。");
        return {
          file: {
            path: command.path,
            text: null,
            mime,
            size: stat.size,
            base64: (await readFile(target)).toString("base64"),
          },
        };
      }
      case "visual.image.save": {
        const project = await this.projectWorkspace(command.projectId);
        if (
          command.name !== path.basename(command.name) ||
          /[<>:"/\\|?*\x00-\x1f]/.test(command.name) ||
          /[. ]$/.test(command.name) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(command.name)
        )
          throw new Error("导出文件名无效。");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(command.base64))
          throw new Error("导出的 PNG 数据无效。");
        const buffer = Buffer.from(command.base64, "base64");
        if (buffer.length > 20 * 1024 * 1024)
          throw new Error("导出的 PNG 上限为 20 MB。");
        const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        if (
          buffer.length < 33 ||
          !buffer.subarray(0, 8).equals(pngSignature) ||
          buffer.readUInt32BE(8) !== 13 ||
          buffer.subarray(12, 16).toString("ascii") !== "IHDR" ||
          buffer.subarray(-8, -4).toString("ascii") !== "IEND"
        )
          throw new Error("导出内容不是有效的 PNG 图片。");
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000)
          throw new Error("导出图片尺寸无效或过大。");

        const directory = path.join(project.root, "outputs", "visual-design", "edits");
        mkdirSync(directory, { recursive: true });
        const safeDirectory = await this.contained(project, "outputs/visual-design/edits");
        const extension = path.extname(command.name);
        const stem = path.basename(command.name, extension).trim() || "edited";
        let savedName = `${stem}.png`;
        for (let suffix = 1; suffix <= 999; suffix += 1) {
          try {
            await writeFile(path.join(safeDirectory, savedName), buffer, { flag: "wx" });
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (suffix === 999) throw new Error("同名导出文件过多，请修改文件名。");
            savedName = `${stem}-${suffix + 1}.png`;
          }
        }
        const savedPath = `outputs/visual-design/edits/${savedName}`;
        this.event(project.id, "visual.image.saved", `已导出 ${savedPath}。`);
        this.publish();
        return { savedPath };
      }
      case "snapshot":
        return this.snapshot();
      case "runtime.check":
        await this.agent.check();
        return this.snapshot();
      case "memory.read":
        return { memory: readProjectMemory(await this.projectWorkspace(command.projectId)) };
      case "memory.write": {
        const project = await this.projectWorkspace(command.projectId);
        if (
          this.db
            .prepare(
              "SELECT id FROM runs WHERE projectId=? AND status='running'",
            )
            .get(project.id)
        )
          throw new Error("请先等待当前任务完成，再更新项目记忆。");
        const memory = writeProjectMemory(
          project,
          command.text,
          command.expectedRevision,
        );
        this.event(
          project.id,
          "memory.updated",
          "项目记忆已更新，下次任务将使用此版本。",
        );
        this.publish();
        return { memory };
      }
      case "runtime.configure":
        await this.agent.configure(command.settings);
        return this.snapshot();
      case "account.update":
        this.db.prepare(
          "INSERT INTO settings (key,value) VALUES ('account', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(JSON.stringify(command.profile));
        this.publish();
        return this.snapshot();
      case "provider.upsert": {
        const provider = this.agent.upsertProvider(command);
        return { ...this.snapshot(), provider };
      }
      case "provider.delete":
        this.agent.deleteProvider(command.providerId);
        return this.snapshot();
      case "provider.activate":
        await this.agent.activateProvider(command.providerId);
        return this.snapshot();
      case "provider.models":
        return {
          models: await this.agent.listProviderModels(command.providerId),
        };
      case "provider.test":
        return {
          connectionCheck: await this.agent.testProvider(command.providerId),
        };
      case "agent.submit": {
        const thread = this.thread(command.threadId);
        const project = await this.projectWorkspace(thread.projectId);
        const runId = this.agent.start(command, project.root);
        return { ...this.snapshot(), runId };
      }
      case "project.create": {
        const root = path.join(this.dataDir, "projects", randomUUID());
        mkdirSync(path.join(root, "inputs"), { recursive: true });
        return this.openProject(root, command.name);
      }
      case "project.rename": {
        const project = this.project(command.projectId);
        const renamed = { ...project, name: command.name };
        this.transaction(() => {
          this.db
            .prepare("UPDATE projects SET name=? WHERE id=?")
            .run(command.name, project.id);
          this.event(
            project.id,
            "project.renamed",
            `项目已重命名为「${command.name}」。`,
          );
        });
        this.publish();
        return { ...this.snapshot(), project: renamed };
      }
      case "project.remove": {
        const project = this.project(command.projectId);
        const projectThreads = "SELECT id FROM threads WHERE projectId=?";
        if (
          this.db
            .prepare(`SELECT id FROM runs WHERE status='running' AND (projectId=? OR threadId IN (${projectThreads}))`)
            .get(project.id, project.id)
        )
          throw new Error("项目仍有任务正在运行，请等待任务结束或先停止任务。");
        if (!command.discardUnsavedRecord) {
          try {
            if (!writeProjectRecord(this.db, project.id))
              throw new Error("项目不存在。");
          } catch (error) {
            throw new Error(
              `无法安全移除项目：最新项目记录未能保存，NEXIOM 中的数据已保留。${(error as Error).message}`,
            );
          }
        }
        this.transaction(() => {
          const projectRuns = `SELECT id FROM runs WHERE projectId=? OR threadId IN (${projectThreads})`;
          this.db.prepare(`DELETE FROM agent_items WHERE runId IN (${projectRuns}) OR threadId IN (${projectThreads})`)
            .run(project.id, project.id, project.id);
          this.db.prepare(`DELETE FROM agent_requests WHERE runId IN (${projectRuns})`)
            .run(project.id, project.id);
          this.db.prepare(`DELETE FROM agent_runs WHERE runId IN (${projectRuns})`)
            .run(project.id, project.id);
          this.db.prepare(`DELETE FROM events WHERE projectId=? OR runId IN (${projectRuns})`)
            .run(project.id, project.id, project.id);
          this.db.prepare(`DELETE FROM agent_contexts WHERE threadId IN (${projectThreads})`).run(project.id);
          this.db.prepare(`DELETE FROM agent_threads WHERE threadId IN (${projectThreads})`).run(project.id);
          this.db.prepare(`DELETE FROM messages WHERE threadId IN (${projectThreads})`).run(project.id);
          this.db.prepare(`DELETE FROM requests WHERE threadId IN (${projectThreads})`).run(project.id);
          this.db.prepare(`DELETE FROM runs WHERE projectId=? OR threadId IN (${projectThreads})`)
            .run(project.id, project.id);
          this.db.prepare("DELETE FROM threads WHERE projectId=?").run(project.id);
          this.db.prepare("DELETE FROM questions WHERE projectId=?").run(project.id);
          this.db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
        });
        this.dirtyProjectRecords.delete(project.id);
        this.projectRecordFailures.delete(project.id);
        this.publish();
        return this.snapshot();
      }
      case "thread.create": {
        this.project(command.projectId);
        if (command.questionId && command.questionName)
          throw new Error("请选择已有问题，或填写新问题名称。");
        const thread: Thread = {
          id: randomUUID(),
          projectId: command.projectId,
          title: command.title ?? "新会话",
          createdAt: now(),
          stageId: command.stageId ?? "model",
          questionId: null,
          unread: false,
          archivedAt: null,
        };
        this.transaction(() => {
          let question: Question | undefined;
          if (command.questionId) {
            question = this.db.prepare("SELECT * FROM questions WHERE id=? AND projectId=?")
              .get(command.questionId, command.projectId) as unknown as Question | undefined;
            if (!question) throw new Error("问题不存在，或不属于当前赛题项目。");
          } else if (command.questionName) {
            question = this.db.prepare("SELECT * FROM questions WHERE projectId=? AND name=?")
              .get(command.projectId, command.questionName) as unknown as Question | undefined;
            if (!question) {
              question = { id: randomUUID(), projectId: command.projectId, name: command.questionName, createdAt: now() };
              this.db.prepare("INSERT INTO questions (id,projectId,name,createdAt) VALUES (?, ?, ?, ?)")
                .run(question.id, question.projectId, question.name, question.createdAt);
            }
          }
          thread.questionId = question?.id ?? null;
          thread.title = command.title ?? question?.name ?? "新会话";
          this.db
            .prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId) VALUES (?, ?, ?, ?, ?, ?)")
            .run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.stageId, thread.questionId);
          this.event(thread.projectId, "thread.created", "已创建新会话。");
        });
        this.publish();
        return { ...this.snapshot(), thread };
      }
      case "thread.ensure": {
        this.project(command.projectId);
        let created = false;
        const thread = this.transaction(() => {
          const existing = this.db
            .prepare("SELECT * FROM threads WHERE projectId=? AND stageId=?")
            .get(command.projectId, command.stageId) as unknown as ThreadRow | undefined;
          if (existing) return readThread(existing);
          const thread: Thread = {
            id: randomUUID(),
            projectId: command.projectId,
            title: projectChatNames[command.stageId],
            createdAt: now(),
            stageId: command.stageId,
            questionId: null,
            unread: false,
            archivedAt: null,
          };
          this.db
            .prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId) VALUES (?, ?, ?, ?, ?, ?)")
            .run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.stageId, thread.questionId);
          this.event(thread.projectId, "thread.created", `已创建${thread.title}会话。`);
          created = true;
          return thread;
        });
        if (created) this.publish();
        return { ...this.snapshot(), thread };
      }
      case "thread.rename": {
        const thread = this.thread(command.threadId);
        this.transaction(() => {
          this.db
            .prepare("UPDATE threads SET title=? WHERE id=?")
            .run(command.title, thread.id);
          this.event(
            thread.projectId,
            "thread.renamed",
            `会话已重命名为「${command.title}」。`,
          );
        });
        this.publish();
        return this.snapshot();
      }
      case "thread.unread": {
        const thread = this.thread(command.threadId);
        this.editableConversation(thread);
        this.db.prepare("UPDATE threads SET unread=? WHERE id=?")
          .run(command.unread ? 1 : 0, thread.id);
        this.projectChanged(thread.projectId);
        this.publish();
        return this.snapshot();
      }
      case "thread.archive": {
        const thread = this.thread(command.threadId);
        this.editableConversation(thread);
        this.db.prepare("UPDATE threads SET archivedAt=? WHERE id=?")
          .run(command.archived ? now() : null, thread.id);
        this.event(thread.projectId, command.archived ? "thread.archived" : "thread.restored", command.archived ? "会话已归档。" : "会话已恢复。");
        this.publish();
        return this.snapshot();
      }
      case "thread.delete": {
        const thread = this.thread(command.threadId);
        this.editableConversation(thread);
        this.transaction(() => this.deleteConversationRecords(thread));
        this.projectChanged(thread.projectId);
        this.publish();
        return this.snapshot();
      }
      case "thread.move": {
        const thread = this.thread(command.threadId);
        this.editableConversation(thread);
        const target = this.project(command.projectId);
        if (target.id === thread.projectId) return { ...this.snapshot(), thread };
        let moved!: Thread;
        this.transaction(() => {
          const questionId = this.questionForProject(thread.questionId, target.id);
          this.db.prepare("UPDATE threads SET projectId=?, questionId=? WHERE id=?")
            .run(target.id, questionId, thread.id);
          this.db.prepare("UPDATE runs SET projectId=? WHERE threadId=?").run(target.id, thread.id);
          this.db.prepare("UPDATE events SET projectId=? WHERE runId IN (SELECT id FROM runs WHERE threadId=?)")
            .run(target.id, thread.id);
          this.db.prepare("DELETE FROM agent_threads WHERE threadId=?").run(thread.id);
          this.db.prepare("DELETE FROM agent_contexts WHERE threadId=?").run(thread.id);
          if (thread.questionId)
            this.db.prepare("DELETE FROM questions WHERE id=? AND NOT EXISTS (SELECT 1 FROM threads WHERE questionId=?)")
              .run(thread.questionId, thread.questionId);
          this.event(target.id, "thread.moved", `会话「${thread.title}」已移入本项目。`);
          moved = { ...thread, projectId: target.id, questionId };
        });
        this.projectChanged(thread.projectId);
        this.publish();
        return { ...this.snapshot(), thread: moved };
      }
      case "thread.fork": {
        const source = this.thread(command.threadId);
        this.editableConversation(source);
        const projectId = command.projectId ?? source.projectId;
        this.project(projectId);
        let fork!: Thread;
        this.transaction(() => {
          const timestamp = now();
          fork = {
            ...source,
            id: randomUUID(),
            projectId,
            questionId: this.questionForProject(source.questionId, projectId),
            title: `${source.title}（分叉）`.slice(0, 80),
            createdAt: timestamp,
            unread: false,
            archivedAt: null,
          };
          this.db.prepare("INSERT INTO threads (id,projectId,title,createdAt,stageId,questionId,unread,archivedAt) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)")
            .run(fork.id, fork.projectId, fork.title, fork.createdAt, fork.stageId, fork.questionId);
          const messages = this.db.prepare("SELECT * FROM messages WHERE threadId=? ORDER BY rowid").all(source.id);
          const insertMessage = this.db.prepare("INSERT INTO messages (id,threadId,role,kind,text,createdAt,sequence) VALUES (?, ?, ?, ?, ?, ?, ?)");
          for (const message of messages)
            insertMessage.run(randomUUID(), fork.id, message.role, message.kind, message.text, message.createdAt, message.sequence);
          const runMap = new Map<string, string>();
          const runs = this.db.prepare("SELECT * FROM runs WHERE threadId=? ORDER BY rowid").all(source.id);
          const insertRun = this.db.prepare("INSERT INTO runs (id,threadId,projectId,status,createdAt,finishedAt) VALUES (?, ?, ?, ?, ?, ?)");
          const insertAgentRun = this.db.prepare("INSERT INTO agent_runs (runId,mode,usage,providerId,providerFingerprint,runtimeConfig) VALUES (?, ?, ?, ?, ?, ?)");
          for (const run of runs) {
            const runId = randomUUID();
            runMap.set(String(run.id), runId);
            insertRun.run(runId, fork.id, projectId, run.status, run.createdAt, run.finishedAt);
            const agentRun = this.db.prepare("SELECT * FROM agent_runs WHERE runId=?").get(run.id);
            if (agentRun) insertAgentRun.run(runId, agentRun.mode, agentRun.usage, agentRun.providerId, agentRun.providerFingerprint, agentRun.runtimeConfig);
          }
          const insertItem = this.db.prepare("INSERT INTO agent_items (id,runId,threadId,sequence,status,payload,updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
          for (const item of this.db.prepare("SELECT * FROM agent_items WHERE threadId=? ORDER BY sequence").all(source.id)) {
            const runId = runMap.get(String(item.runId));
            if (runId) insertItem.run(randomUUID(), runId, fork.id, item.sequence, item.status, item.payload, item.updatedAt);
          }
          const insertEvent = this.db.prepare("INSERT INTO events (id,projectId,type,runId,summary,createdAt) VALUES (?, ?, ?, ?, ?, ?)");
          for (const event of this.db.prepare("SELECT * FROM events WHERE runId IN (SELECT id FROM runs WHERE threadId=?) ORDER BY sequence").all(source.id)) {
            const runId = runMap.get(String(event.runId));
            if (runId) insertEvent.run(randomUUID(), projectId, event.type, runId, event.summary, event.createdAt);
          }
          this.event(projectId, "thread.forked", `已从「${source.title}」分叉新会话。`);
        });
        this.publish();
        return { ...this.snapshot(), thread: fork };
      }
      case "message.submit": {
        const thread = this.thread(command.threadId);
        const existing = this.db
          .prepare("SELECT * FROM requests WHERE id=?")
          .get(command.clientRequestId);
        if (existing) {
          if (existing.threadId !== thread.id || existing.text !== command.text)
            throw new Error("重复请求的内容不一致。");
          return this.snapshot();
        }
        this.transaction(() => {
          this.db
            .prepare("INSERT INTO requests VALUES (?, ?, ?)")
            .run(command.clientRequestId, thread.id, command.text);
          this.message(thread.id, "user", "note", command.text);
          this.message(
            thread.id,
            "assistant",
            "answer",
            "已保存这条研究笔记。模型尚未连接，本轮未执行分析或代码。",
          );
          if (thread.title === "新会话" || thread.title === "研究笔记")
            this.db
              .prepare("UPDATE threads SET title=? WHERE id=?")
              .run(command.text.slice(0, 24), thread.id);
        });
        this.publish();
        return this.snapshot();
      }
      case "project.files":
        return { files: await this.files(await this.projectWorkspace(command.projectId)) };
      case "file.read": {
        const target = await this.contained(
          await this.projectWorkspace(command.projectId),
          command.path,
        );
        const stat = await lstat(target);
        if (!stat.isFile()) throw new Error("目标不是文件。");
        const ext = path.extname(target).toLowerCase();
        if (ext === ".pdf") {
          if (stat.size > 12 * 1024 * 1024)
            return {
              file: {
                path: command.path,
                text: null,
                mime: "large",
                size: stat.size,
              },
            };
          return {
            file: {
              path: command.path,
              text: null,
              mime: "application/pdf",
              size: stat.size,
              base64: (await readFile(target)).toString("base64"),
            },
          };
        }
        if (stat.size > 2 * 1024 * 1024)
          return {
            file: {
              path: command.path,
              text: null,
              mime: "large",
              size: stat.size,
            },
          };
        const mime = (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
          } as Record<string, string>
        )[ext];
        if (mime)
          return {
            file: {
              path: command.path,
              text: null,
              mime,
              size: stat.size,
              base64: (await readFile(target)).toString("base64"),
            },
          };
        const readable = [
          ".txt",
          ".md",
          ".csv",
          ".tsv",
          ".json",
          ".py",
          ".r",
          ".m",
          ".tex",
          ".yaml",
          ".yml",
          ".toml",
          ".log",
          ".ts",
          ".tsx",
          ".js",
          ".css",
          ".html",
          ".xml",
          ".svg",
        ].includes(ext);
        return {
          file: {
            path: command.path,
            text: readable ? await readFile(target, "utf8") : null,
            mime: readable ? "text/plain" : "application/octet-stream",
            size: stat.size,
          },
        };
      }
      case "file.import": {
        const project = await this.projectWorkspace(command.projectId);
        if (
          command.name !== path.basename(command.name) ||
          /[<>:"/\\|?*\x00-\x1f]/.test(command.name) ||
          /[. ]$/.test(command.name) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(command.name)
        )
          throw new Error("附件文件名无效。");
        const buffer = Buffer.from(command.base64, "base64");
        if (buffer.length > 10 * 1024 * 1024)
          throw new Error("附件上限为 10 MB。");
        const directory = path.join(project.root, "inputs");
        mkdirSync(directory, { recursive: true });
        const safeDirectory = await this.contained(project, "inputs");
        try {
          await writeFile(path.join(safeDirectory, command.name), buffer, {
            flag: "wx",
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error("同名附件已存在，请修改文件名后导入。");
          throw error;
        }
        this.event(
          project.id,
          "file.imported",
          `已导入 inputs/${command.name}。`,
        );
        this.publish();
        return { importedPath: `inputs/${command.name}` };
      }
      case "run.cancel": {
        const run = this.db
          .prepare("SELECT * FROM runs WHERE id=?")
          .get(command.runId) as unknown as Run | undefined;
        if (!run) throw new Error("运行不存在。");
        if (run.status === "running") {
          this.agent.cancel(run.id);
        }
        return this.snapshot();
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.agent.close();
    this.flushProjectRecords();
    this.db.close();
    this.releaseLease();
  }
  setRuntimeSecrets(secrets: Record<string, string>) {
    this.agent.setSecrets(secrets);
  }
}
