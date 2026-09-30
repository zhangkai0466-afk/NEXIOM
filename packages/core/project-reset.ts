import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CleanupResult, Project, ProjectResetPreview } from "../contracts";
import { atomicJson, checkedFile, checkedRoot, fileHash } from "../filesystem/safe-files";
import { forgetDeletedGeneratedFiles, generatedFiles, outputPath } from "../filesystem/generated-files";
import { projectRecordFromDatabase, writeProjectRecord } from "./project-record";
import { readProjectMemory } from "./memory";

export function deleteProjectContents(db: DatabaseSync, projectId: string): void {
  const threads = "SELECT id FROM threads WHERE projectId=?";
  const runs = `SELECT id FROM runs WHERE projectId=? OR threadId IN (${threads})`;
  db.prepare(`DELETE FROM agent_items WHERE runId IN (${runs}) OR threadId IN (${threads})`).run(projectId, projectId, projectId);
  for (const table of ["agent_requests", "agent_runs"])
    db.prepare(`DELETE FROM ${table} WHERE runId IN (${runs})`).run(projectId, projectId);
  db.prepare(`DELETE FROM events WHERE projectId=? OR runId IN (${runs})`).run(projectId, projectId, projectId);
  for (const table of ["agent_contexts", "agent_threads", "messages", "requests"])
    db.prepare(`DELETE FROM ${table} WHERE threadId IN (${threads})`).run(projectId);
  db.prepare(`DELETE FROM runs WHERE projectId=? OR threadId IN (${threads})`).run(projectId, projectId);
  db.prepare("DELETE FROM threads WHERE projectId=?").run(projectId);
  db.prepare("DELETE FROM questions WHERE projectId=?").run(projectId);
}

export function previewProjectReset(db: DatabaseSync, project: Project, expectedHashes?: Map<string, string>): ProjectResetPreview {
  const root = checkedRoot(project.root);
  const memory = readProjectMemory(project);
  expectedHashes?.set(".nexiom/MEMORY.md", memory.revision);
  const workflowPath = checkedFile(root, ".nexiom/workflow.json");
  const workflowHash = existsSync(workflowPath) ? fileHash(workflowPath) : "";
  if (workflowHash) expectedHashes?.set(".nexiom/workflow.json", workflowHash);
  const record = projectRecordFromDatabase(db, project.id, "");
  if (!record) throw new Error("项目不存在。");
  const preview: ProjectResetPreview = {
    revision: "", threads: record.records.threads.length, messages: record.records.messages.length,
    runs: record.records.runs.length, generatedFiles: [], preservedFiles: 0, warnings: [],
  };
  const hashes: string[] = [];
  try {
    for (const file of generatedFiles(root)) {
      try {
        const relative = outputPath(root, file.path);
        const target = checkedFile(root, relative);
        if (!existsSync(target)) continue;
        if (fileHash(target) !== file.hash) { preview.preservedFiles++; continue; }
        preview.generatedFiles.push({ path: relative, size: lstatSync(target).size });
        expectedHashes?.set(relative, file.hash);
        hashes.push(`${relative}:${file.hash}`);
      } catch { preview.preservedFiles++; }
    }
  } catch { preview.warnings.push("成果来源清单无法读取，本次仅重置项目记录，磁盘成果全部保留。"); }
  preview.generatedFiles.sort((a, b) => a.path.localeCompare(b.path));
  if (preview.preservedFiles) preview.warnings.push(`${preview.preservedFiles} 个已修改或无法核实的成果文件将保留。`);
  preview.revision = createHash("sha256").update(JSON.stringify([record, memory.revision, workflowHash, hashes.sort(), preview.preservedFiles])).digest("hex");
  return preview;
}

const journalSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), root: z.string(),
  files: z.array(z.string().min(1).max(4096)).max(20002),
});
type Journal = z.infer<typeof journalSchema>;
const journalName = (id: string) => `reset-journals/${id}.json`;
const stageName = (id: string) => `.nexiom/.reset-${id}`;
const marker = (id: string) => `project-reset:${id}`;

function finishJournal(dataDir: string, db: DatabaseSync, journal: Journal, committed: boolean): void {
  const root = checkedRoot(journal.root);
  const stage = checkedFile(root, stageName(journal.id));
  for (const [index, relative] of journal.files.entries()) {
    if (![".nexiom/project.json", ".nexiom/MEMORY.md", ".nexiom/workflow.json"].includes(relative)) outputPath(root, relative);
    const target = checkedFile(root, relative);
    const backup = checkedFile(root, `${stageName(journal.id)}/${index}`);
    if (!existsSync(backup)) continue; // A crash may precede this particular rename.
    if (!lstatSync(backup).isFile() || lstatSync(backup).nlink !== 1) throw new Error("重置暂存文件无法安全恢复。");
    if (committed) unlinkSync(backup);
    else {
      if (existsSync(target)) {
        if (relative !== ".nexiom/project.json") throw new Error(`重置恢复遇到同名文件，已保留暂存内容：${relative}`);
        // Only the uncommitted project mirror may have been newly written.
        const record = JSON.parse(readFileSync(target, "utf8"));
        if (record.project?.id !== journal.projectId) throw new Error("项目记录身份已变化，已停止恢复。");
        unlinkSync(target);
      }
      renameSync(backup, target);
    }
  }
  if (existsSync(stage)) rmdirSync(stage); // Never delete unknown contents recursively.
  if (committed) forgetDeletedGeneratedFiles(root, journal.files.filter(file => !file.startsWith(".nexiom/")));
  unlinkSync(checkedFile(dataDir, journalName(journal.id)));
  db.prepare("DELETE FROM settings WHERE key=?").run(marker(journal.id));
}

// Runs before portable records are flushed on startup, so a pre-commit crash
// restores the previous files while a post-commit crash completes their cleanup.
export function recoverProjectResets(dataDir: string, db: DatabaseSync): void {
  const directory = checkedFile(dataDir, "reset-journals");
  if (!existsSync(directory)) return;
  for (const file of readdirSync(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const target = checkedFile(dataDir, `reset-journals/${file}`);
    if (!lstatSync(target).isFile() || lstatSync(target).size > 8 * 1024 * 1024) throw new Error("重置恢复记录无效。");
    const journal = journalSchema.parse(JSON.parse(readFileSync(target, "utf8")));
    const project = db.prepare("SELECT root FROM projects WHERE id=?").get(journal.projectId);
    if (`${journal.id}.json` !== file || !project || path.resolve(String(project.root)) !== path.resolve(journal.root))
      throw new Error("重置恢复记录与项目文件夹不一致。");
    finishJournal(dataDir, db, journal, !!db.prepare("SELECT key FROM settings WHERE key=?").get(marker(journal.id)));
  }
}

export function resetProject(dataDir: string, db: DatabaseSync, project: Project, options: {
  revision: string; deleteGenerated: boolean; confirmationName: string;
}): CleanupResult {
  recoverProjectResets(dataDir, db);
  if (db.prepare("SELECT id FROM runs WHERE status='running' AND (projectId=? OR threadId IN (SELECT id FROM threads WHERE projectId=?))").get(project.id, project.id))
    throw new Error("项目仍有任务正在运行，请先停止任务后再重置。");
  const expectedHashes = new Map<string, string>();
  const preview = previewProjectReset(db, project, expectedHashes);
  if (preview.revision !== options.revision) throw new Error("项目内容或成果文件已变化，请重新打开重置窗口核对清单。");
  if (options.deleteGenerated && options.confirmationName !== project.name) throw new Error("请输入完整项目名称以确认删除成果文件。");
  // Validate ownership and permissions before moving any file or changing SQL.
  if (!writeProjectRecord(db, project.id)) throw new Error("项目不存在。");
  const root = checkedRoot(project.root);
  expectedHashes.set(".nexiom/project.json", fileHash(checkedFile(root, ".nexiom/project.json"), 128 * 1024 * 1024));
  const files = [".nexiom/project.json", ".nexiom/MEMORY.md", ".nexiom/workflow.json"]
    .filter(relative => existsSync(checkedFile(root, relative)));
  if (options.deleteGenerated) files.push(...preview.generatedFiles.map(file => file.path));
  for (const relative of files) {
    const stat = lstatSync(checkedFile(root, relative));
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`不能清理链接文件：${relative}`);
  }
  const journal: Journal = { id: randomUUID(), projectId: project.id, root, files };
  const result: CleanupResult = { freedBytes: 0, deletedFiles: 0, skippedFiles: 0, warnings: [...preview.warnings] };
  atomicJson(dataDir, journalName(journal.id), journal);
  let committed = false;
  let transactionOpen = false;
  try {
    mkdirSync(checkedFile(root, stageName(journal.id)));
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    for (const [index, relative] of files.entries()) {
      const source = checkedFile(root, relative);
      if (fileHash(source, relative === ".nexiom/project.json" ? 128 * 1024 * 1024 : undefined) !== expectedHashes.get(relative))
        throw new Error(`文件在清理前发生变化，已停止重置：${relative}`);
      result.freedBytes += lstatSync(source).size;
      renameSync(source, checkedFile(root, `${stageName(journal.id)}/${index}`));
    }
    deleteProjectContents(db, project.id);
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?)").run(marker(journal.id), project.id);
    writeProjectRecord(db, project.id);
    db.exec("COMMIT");
    transactionOpen = false;
    committed = true;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    try { finishJournal(dataDir, db, journal, false); }
    catch { throw new Error("重置未完成，原内容已保存在重置暂存目录。请重启应用完成恢复。"); }
    throw error;
  }
  if (committed) {
    try { finishJournal(dataDir, db, journal, true); result.deletedFiles = files.length; }
    catch {
      result.freedBytes = 0;
      result.skippedFiles = files.length;
      result.warnings.push("项目已重置，部分暂存文件尚未释放，将在下次启动时重试清理。");
    }
  }
  return result;
}
