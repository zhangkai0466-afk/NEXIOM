import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { TokenActivity } from "../contracts";
import { atomicJson, checkedFile } from "../filesystem/safe-files";
import { nativeActivityId, parseUsage, readNativeUsageHistory, validUsage } from "./native-usage-history";

const activitySchema = z.object({
  id: z.string().min(1).max(340), runId: z.string().uuid().nullable(),
  source: z.enum(["run", "native"]), kind: z.literal("agent"),
  createdAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  usage: z.string().max(2000).nullable(), runtimeConfig: z.string().max(100).nullable(),
  nativeThreadId: z.string().regex(/^[\w-]{1,160}$/).nullable(), nativeTurnId: z.string().regex(/^[\w-]{1,160}$/).nullable(),
}).strict();
const backupSchema = z.object({ format: z.literal("nexiom.token-activity"), version: z.literal(1), activities: z.array(activitySchema).max(100000) }).strict();
const columns = "id,runId,source,'agent' AS kind,createdAt,finishedAt,usage,runtimeConfig,nativeThreadId,nativeTurnId";
const backupPath = "usage/token-activity.json";

function cacheConfig(raw: string | null): string | null {
  try {
    const state = JSON.parse(raw ?? "null")?.cacheThreadState;
    return state === "new_thread" || state === "continuation" ? JSON.stringify({ cacheThreadState: state }) : null;
  } catch { return null; }
}

export class TokenActivityLedger {
  warning = "";
  private savedRevision = -1;
  constructor(private db: DatabaseSync, private dataDir: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS token_activity (
      id TEXT PRIMARY KEY, runId TEXT, source TEXT NOT NULL,
      createdAt TEXT NOT NULL, finishedAt TEXT, usage TEXT, runtimeConfig TEXT,
      nativeThreadId TEXT, nativeTurnId TEXT, revision INTEGER NOT NULL DEFAULT 1
    ); CREATE INDEX IF NOT EXISTS token_activity_run ON token_activity(runId,source);`);
  }
  all(): TokenActivity[] {
    return this.db.prepare(`SELECT ${columns} FROM token_activity ORDER BY createdAt,id`).all() as unknown as TokenActivity[];
  }
  activities(): TokenActivity[] {
    const entries = this.all();
    const native = new Map<string, { input: number; output: number }>();
    for (const entry of entries) if (entry.source === "native" && entry.runId) {
      const total = native.get(entry.runId) ?? { input: 0, output: 0 };
      const usage = parseUsage(entry.usage);
      total.input += usage?.input_tokens ?? 0;
      total.output += usage?.output_tokens ?? 0;
      native.set(entry.runId, total);
    }
    // Prefer native turns, but retain a more complete old run summary if some
    // native logs are missing. Never add both representations of the same work.
    const summaries = new Set(entries.filter(entry => {
      if (entry.source !== "run" || !entry.runId) return false;
      const total = native.get(entry.runId);
      const usage = parseUsage(entry.usage);
      return !total || (usage && (total.input < usage.input_tokens || total.output < usage.output_tokens));
    }).map(entry => entry.runId));
    return entries.filter(entry => entry.source === "run" ? summaries.has(entry.runId) : !entry.runId || !summaries.has(entry.runId));
  }
  put(candidate: TokenActivity): boolean {
    const entry = activitySchema.parse(candidate);
    if (entry.source === "native" ? (!entry.nativeThreadId || !entry.nativeTurnId || entry.id !== nativeActivityId(entry.nativeThreadId, entry.nativeTurnId))
      : (!entry.runId || entry.id !== `run:${entry.runId}` || entry.nativeThreadId !== null || entry.nativeTurnId !== null)) throw new Error("Token 活动标识无效。");
    const parsed = parseUsage(entry.usage);
    if (entry.usage !== null && !parsed) throw new Error("Token 用量包含无效计数。");
    entry.usage = parsed ? JSON.stringify(parsed) : null;
    entry.runtimeConfig = cacheConfig(entry.runtimeConfig);
    const previous = this.db.prepare(`SELECT ${columns} FROM token_activity WHERE id=?`).get(entry.id) as unknown as TokenActivity | undefined;
    if (previous) {
      const oldUsage = parseUsage(previous.usage);
      if (oldUsage && (!parsed || Object.keys(oldUsage).some(key => parsed[key as keyof typeof parsed] < oldUsage[key as keyof typeof oldUsage]))) entry.usage = previous.usage;
      entry.runId = previous.runId ?? entry.runId;
      entry.createdAt = Date.parse(previous.createdAt) < Date.parse(entry.createdAt) ? previous.createdAt : entry.createdAt;
      entry.finishedAt = previous.finishedAt && (!entry.finishedAt || Date.parse(previous.finishedAt) > Date.parse(entry.finishedAt)) ? previous.finishedAt : entry.finishedAt;
      entry.runtimeConfig ??= previous.runtimeConfig;
      if (Object.keys(entry).every(key => entry[key as keyof TokenActivity] === previous[key as keyof TokenActivity])) return false;
    }
    this.db.prepare(`INSERT INTO token_activity (id,runId,source,createdAt,finishedAt,usage,runtimeConfig,nativeThreadId,nativeTurnId)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET runId=excluded.runId, createdAt=excluded.createdAt,
      finishedAt=excluded.finishedAt, usage=excluded.usage, runtimeConfig=excluded.runtimeConfig, revision=token_activity.revision+1`)
      .run(entry.id, entry.runId, entry.source, entry.createdAt, entry.finishedAt, entry.usage, entry.runtimeConfig, entry.nativeThreadId, entry.nativeTurnId);
    return true;
  }
  recordRun(runId: string): void {
    const run = this.db.prepare(`SELECT r.*,a.usage,a.runtimeConfig,COALESCE(a.activityId,a.runId) AS activityId
      FROM runs r JOIN agent_runs a ON a.runId=r.id WHERE r.id=?`).get(runId);
    if (!run) return;
    if (!Number.isFinite(Date.parse(String(run.createdAt)))) { this.warning = "部分旧运行缺少有效日期，未计入活动统计。"; return; }
    const usage = parseUsage(run.usage as string | null);
    const finishedAt = run.finishedAt && Number.isFinite(Date.parse(String(run.finishedAt))) ? new Date(String(run.finishedAt)).toISOString() : null;
    this.put({ id: `run:${run.activityId}`, runId: String(run.activityId), source: "run", kind: "agent",
      createdAt: new Date(String(run.createdAt)).toISOString(), finishedAt,
      usage: usage ? JSON.stringify(usage) : null, runtimeConfig: cacheConfig(run.runtimeConfig as string | null), nativeThreadId: null, nativeTurnId: null });
    if (finishedAt) {
      const native = this.db.prepare(`SELECT ${columns} FROM token_activity WHERE source='native' AND runId=? AND finishedAt IS NULL`).all(String(run.activityId)) as unknown as TokenActivity[];
      for (const activity of native) this.put({ ...activity, finishedAt });
    }
  }
  recordNative(runId: string, threadId: string, turnId: string, usage: unknown, finished = false): void {
    const run = this.db.prepare("SELECT r.createdAt,a.runtimeConfig,COALESCE(a.activityId,a.runId) AS activityId FROM runs r JOIN agent_runs a ON a.runId=r.id WHERE r.id=?").get(runId);
    if (!run) return;
    const id = nativeActivityId(threadId, turnId);
    const previous = this.db.prepare("SELECT createdAt FROM token_activity WHERE id=?").get(id);
    const parsed = validUsage(usage);
    this.put({ id, runId: String(run.activityId), source: "native", kind: "agent",
      createdAt: previous ? String(previous.createdAt) : new Date().toISOString(), finishedAt: finished ? new Date().toISOString() : null,
      usage: parsed ? JSON.stringify(parsed) : null, runtimeConfig: cacheConfig(run.runtimeConfig as string | null), nativeThreadId: threadId, nativeTurnId: turnId });
  }
  backfill(): void {
    this.db.prepare("UPDATE agent_runs SET activityId=runId WHERE activityId IS NULL").run();
    for (const run of this.db.prepare("SELECT runId FROM agent_runs").all()) this.recordRun(String(run.runId));
  }
  export(): string { return JSON.stringify({ format: "nexiom.token-activity", version: 1, activities: this.all() }, null, 2); }
  import(text: string): number {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("Token 活动备份超过 16 MB。");
    const data = backupSchema.parse(JSON.parse(text));
    const changed = new Set<string>();
    this.db.exec("SAVEPOINT import_token_activity");
    try {
      for (const activity of data.activities) if (this.put(activity)) changed.add(activity.id);
      this.db.exec("RELEASE import_token_activity");
    } catch (error) {
      this.db.exec("ROLLBACK TO import_token_activity; RELEASE import_token_activity");
      throw error;
    }
    return this.activities().filter(activity => changed.has(activity.id)).length;
  }
  restoreBackups(): void {
    for (const relative of ["usage/token-activity.previous.json", backupPath, "usage/token-activity.recovered.json"]) {
      try {
        const target = checkedFile(this.dataDir, relative);
        if (!existsSync(target)) continue;
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error("无效备份文件");
        this.import(readFileSync(target, "utf8"));
      } catch { this.warning = "部分 Token 活动备份无法读取，已保留现有记录；可重新导入有效备份。"; }
    }
  }
  saveBackup(): void {
    const revision = Number(this.db.prepare("SELECT COALESCE(SUM(revision),0) AS revision FROM token_activity").get()?.revision);
    if (revision === this.savedRevision) return;
    try {
      const current = checkedFile(this.dataDir, backupPath);
      if (existsSync(current)) {
        try {
          if (lstatSync(current).size <= 16 * 1024 * 1024) atomicJson(this.dataDir, "usage/token-activity.previous.json", backupSchema.parse(JSON.parse(readFileSync(current, "utf8"))));
        } catch { /* Never replace the previous backup with a damaged current file. */ }
      }
      atomicJson(this.dataDir, backupPath, JSON.parse(this.export()));
      this.savedRevision = revision;
    } catch { this.warning = "Token 活动已记入数据库，但自动备份暂时无法写入。可先导出备份。"; }
  }
  recover(runtimeHome = path.join(this.dataDir, "runtime")): number {
    this.backfill();
    const history = readNativeUsageHistory(runtimeHome);
    const runs = this.db.prepare(`SELECT r.id,r.threadId,r.createdAt,r.finishedAt,p.root,COALESCE(a.activityId,a.runId) AS activityId
      FROM runs r JOIN agent_runs a ON a.runId=r.id JOIN projects p ON p.id=r.projectId`).all();
    const bindings = this.db.prepare("SELECT threadId,engineThreadId FROM agent_threads").all();
    let changed = 0;
    const normalize = (root: string) => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
    for (const recovered of history.activities) {
      const { cwd, ...activity } = recovered;
      // Legacy runs predate native-turn identities. Link only a unique matching
      // workspace/time interval, further restricted by engine binding if known.
      const matching = runs.filter(run => {
        const started = Date.parse(activity.createdAt);
        if (!cwd || normalize(String(run.root)) !== normalize(cwd) || started < Date.parse(String(run.createdAt)) - 1000 ||
          started > (run.finishedAt ? Date.parse(String(run.finishedAt)) : Date.now()) + 1000) return false;
        const engines = bindings.filter(binding => binding.threadId === run.threadId);
        return !engines.length || engines.some(binding => binding.engineThreadId === activity.nativeThreadId);
      });
      const identities = new Set(matching.map(run => String(run.activityId)));
      if (identities.size === 1) activity.runId = [...identities][0];
      else if (identities.size > 1) {
        this.warning = "部分旧用量与多条运行记录重叠，暂未合并，避免重复统计。";
        continue;
      }
      if (this.put(activity)) changed++;
    }
    if (history.warnings.length) this.warning = history.warnings.join(" ");
    this.saveBackup();
    return changed;
  }
}
