import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { TokenActivity } from "../contracts";
import { checkedFile, checkedRoot } from "../filesystem/safe-files";

const counts = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"] as const;
export type UsageCounts = Record<typeof counts[number], number>;
export function validUsage(value: unknown): UsageCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.input_tokens === undefined || record.output_tokens === undefined) return null;
  const result = Object.fromEntries(counts.map(key => [key, record[key] ?? 0])) as UsageCounts;
  if (!Object.values(result).every(value => Number.isSafeInteger(value) && value >= 0) ||
    result.cached_input_tokens + result.cache_write_input_tokens > result.input_tokens ||
    !Number.isSafeInteger(result.input_tokens + result.output_tokens)) return null;
  return result;
}
export function parseUsage(text: string | null | undefined): UsageCounts | null {
  try { return validUsage(JSON.parse(text ?? "null")); } catch { return null; }
}
export const nativeActivityId = (threadId: string, turnId: string) => `native:${threadId}:${turnId}`;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
export interface RecoveredActivity extends TokenActivity { cwd: string | null }

// Read only NEXIOM's own rollout directory. Never inspect the personal Codex home.
// token_usage_record.turn_token_usage is cumulative within one native turn;
// token_count is a legacy fallback, never an additional amount to add to it.
export function readNativeUsageHistory(runtimeHome: string): { activities: RecoveredActivity[]; warnings: string[] } {
  const activities = new Map<string, RecoveredActivity>();
  const nativeTurns = new Set<string>();
  const legacyTurns = new Map<string, string>();
  const warnings: string[] = [];
  let root: string;
  try { root = checkedRoot(runtimeHome); } catch { return { activities: [], warnings }; }
  const files: string[] = [];
  const visit = (relative: string, depth: number) => {
    if (depth > 6 || files.length >= 10000) { warnings.push("部分较深或数量过多的引擎日志未扫描。"); return; }
    let target: string;
    try { target = checkedFile(root, relative); if (!lstatSync(target).isDirectory()) return; }
    catch { return; }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (files.length >= 10000) { warnings.push("部分数量过多的引擎日志未扫描。"); break; }
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
    }
  };
  visit("sessions", 0); visit("archived_sessions", 0);
  for (const file of files.sort()) {
    try {
      const target = checkedFile(root, file);
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) { warnings.push("部分引擎日志过大或不是普通文件，已保留并跳过。"); continue; }
      let threadId = "";
      let currentTurn = "";
      let baseline: UsageCounts = Object.fromEntries(counts.map(key => [key, 0])) as UsageCounts;
      let cumulative = baseline;
      const started = new Map<string, string>();
      const cwd = new Map<string, string>();
      const finished = new Map<string, string>();
      const canonicalTurns = new Map<string, string>();
      const nativeReported = new Set<string>();
      let turnIndex = 0;
      const save = (nativeThreadId: string, turnId: string, date: string, usage: UsageCounts | null) => {
        const id = nativeActivityId(nativeThreadId, turnId);
        const previous = activities.get(id);
        const oldUsage = parseUsage(previous?.usage);
        if (oldUsage && (!usage || counts.some(key => usage[key] < oldUsage[key]))) return;
        activities.set(id, {
          id, runId: previous?.runId ?? null, source: "native", kind: "agent",
          createdAt: started.get(turnId) ?? previous?.createdAt ?? date,
          finishedAt: finished.get(turnId) ?? previous?.finishedAt ?? null,
          usage: usage ? JSON.stringify(usage) : null,
          runtimeConfig: JSON.stringify({ cacheThreadState: turnIndex > 1 ? "continuation" : "new_thread" }),
          nativeThreadId, nativeTurnId: turnId, cwd: cwd.get(turnId) ?? previous?.cwd ?? null,
        });
        canonicalTurns.set(turnId, id);
      };
      for (const line of readFileSync(target, "utf8").split("\n")) {
        if (!line || line.length > 2 * 1024 * 1024) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; } // A running engine may have a partial trailing line.
        const payload = row.payload;
        if (!payload || typeof payload !== "object") continue;
        if (row.type === "session_meta") {
          if (payload.originator !== "nexiom" || !identifier(payload.id)) break;
          threadId = payload.id;
        }
        if (!threadId) continue;
        if (!timestamp(row.timestamp)) continue;
        const date = new Date(row.timestamp).toISOString();
        if (row.type === "event_msg" && payload.type === "task_started" && identifier(payload.turn_id)) {
          currentTurn = payload.turn_id;
          started.set(currentTurn, date);
          baseline = cumulative;
          turnIndex++;
        } else if (row.type === "turn_context" && identifier(payload.turn_id)) {
          if (typeof payload.cwd === "string") cwd.set(payload.turn_id, payload.cwd);
        } else if (row.type === "token_usage_record" && identifier(payload.turn_id) && identifier(payload.thread_id)) {
          const usage = validUsage(payload.turn_token_usage);
          if (usage) {
            nativeReported.add(payload.turn_id);
            nativeTurns.add(payload.turn_id);
            const legacyId = legacyTurns.get(payload.turn_id);
            if (legacyId && legacyId !== nativeActivityId(payload.thread_id, payload.turn_id)) activities.delete(legacyId);
            const total = validUsage(payload.thread_token_usage);
            if (total) cumulative = total;
            // Inherited history keeps its original thread/turn identity and deduplicates across forks.
            save(payload.thread_id, payload.turn_id, date, usage);
          }
        } else if (row.type === "event_msg" && payload.type === "token_count") {
          const total = validUsage(payload.info?.total_token_usage);
          if (!total) continue;
          cumulative = total;
          if (currentTurn && !nativeReported.has(currentTurn) && !nativeTurns.has(currentTurn)) {
            const delta = validUsage(Object.fromEntries(counts.map(key => [key, total[key] - baseline[key]])));
            if (delta) {
              // A legacy turn id also survives fork replay. Keep its first identity.
              const original = activities.get(legacyTurns.get(currentTurn) ?? "")?.nativeThreadId ?? threadId;
              save(original, currentTurn, date, delta);
              legacyTurns.set(currentTurn, nativeActivityId(original, currentTurn));
            }
          }
        } else if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(payload.type)) {
          const turn = identifier(payload.turn_id) ? payload.turn_id : currentTurn;
          if (!turn) continue;
          finished.set(turn, date);
          const activity = activities.get(canonicalTurns.get(turn) ?? nativeActivityId(threadId, turn));
          if (activity) { activity.finishedAt = date; activity.cwd = cwd.get(turn) ?? activity.cwd; }
        }
      }
    } catch { warnings.push("部分引擎日志无法读取，现有活动记录已保留。"); }
  }
  return { activities: [...activities.values()], warnings: [...new Set(warnings)] };
}
