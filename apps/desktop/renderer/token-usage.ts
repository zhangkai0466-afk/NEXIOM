import type { Run } from "../../../packages/contracts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  ordinaryInputTokens: number;
  totalTokens: number;
}

export interface UsageDay extends TokenUsage {
  date: string;
  knownRuns: number;
  unknownRuns: number;
}

type UsageRun = Pick<Run, "id" | "createdAt" | "kind" | "usage" | "runtimeConfig">;
type CacheThreadState = "new_thread" | "continuation" | "unknown";
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function tokenRate(numerator: number, denominator: number): number | null {
  if (!validCount(numerator) || !validCount(denominator) || numerator > denominator || denominator === 0)
    return null;
  return numerator / denominator;
}

function cacheThreadState(raw: string | null | undefined): CacheThreadState {
  if (!raw) return "unknown";
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const state = (value as Record<string, unknown>).cacheThreadState;
    return state === "new_thread" || state === "continuation" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

/** Run usage is a per-turn delta. Cached input is already included in input. */
export function parseTokenUsage(raw: string | null | undefined): TokenUsage | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const usage = value as Record<string, unknown>;
    if (!validCount(usage.input_tokens) || !validCount(usage.output_tokens)) return null;
    const cachedInputTokens = usage.cached_input_tokens ?? 0;
    const cacheWriteInputTokens = usage.cache_write_input_tokens ?? 0;
    if (
      !validCount(cachedInputTokens) ||
      !validCount(cacheWriteInputTokens) ||
      cachedInputTokens + cacheWriteInputTokens > usage.input_tokens
    ) return null;
    const totalTokens = usage.input_tokens + usage.output_tokens;
    if (!Number.isSafeInteger(totalTokens)) return null;
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      ordinaryInputTokens: usage.input_tokens - cachedInputTokens - cacheWriteInputTokens,
      totalTokens,
    };
  } catch {
    return null;
  }
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const emptyTokens = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  ordinaryInputTokens: 0,
  totalTokens: 0,
});

export function aggregateTokenUsage(runs: readonly UsageRun[], now = new Date(), days = 365) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  const daily: UsageDay[] = [];
  const byDate = new Map<string, UsageDay>();
  // Calendar arithmetic keeps one cell per local day through DST changes.
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const day = { date: localDateKey(date), ...emptyTokens(), knownRuns: 0, unknownRuns: 0 };
    daily.push(day);
    byDate.set(day.date, day);
  }
  const seen = new Set<string>();
  let invalidDateRuns = 0;
  const cache = {
    newThreadRuns: 0,
    continuationRuns: 0,
    unknownStateRuns: 0,
    continuationInputTokens: 0,
    continuationCachedInputTokens: 0,
  };
  const allTimeTotals = { ...emptyTokens(), knownRuns: 0, unknownRuns: 0 };
  for (const run of runs) {
    if (run.kind !== "agent" || seen.has(run.id)) continue;
    seen.add(run.id);
    const createdAt = new Date(run.createdAt);
    if (!Number.isFinite(createdAt.getTime())) {
      invalidDateRuns += 1;
      continue;
    }
    const parsed = parseTokenUsage(run.usage);
    if (createdAt < new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1)) {
      if (parsed) {
        allTimeTotals.knownRuns++;
        for (const key of Object.keys(parsed) as (keyof TokenUsage)[]) allTimeTotals[key] += parsed[key];
      } else allTimeTotals.unknownRuns++;
    }
    const day = byDate.get(localDateKey(createdAt));
    if (!day) continue;
    const usage = parsed;
    if (!usage) {
      day.unknownRuns += 1;
      continue;
    }
    day.knownRuns += 1;
    day.inputTokens += usage.inputTokens;
    day.outputTokens += usage.outputTokens;
    day.cachedInputTokens += usage.cachedInputTokens;
    day.cacheWriteInputTokens += usage.cacheWriteInputTokens;
    day.ordinaryInputTokens += usage.ordinaryInputTokens;
    day.totalTokens += usage.totalTokens;
    const state = cacheThreadState(run.runtimeConfig);
    if (state === "new_thread") cache.newThreadRuns += 1;
    else if (state === "continuation") {
      cache.continuationRuns += 1;
      cache.continuationInputTokens += usage.inputTokens;
      cache.continuationCachedInputTokens += usage.cachedInputTokens;
    } else cache.unknownStateRuns += 1;
  }
  const totals = daily.reduce(
    (sum, day) => ({
      inputTokens: sum.inputTokens + day.inputTokens,
      outputTokens: sum.outputTokens + day.outputTokens,
      cachedInputTokens: sum.cachedInputTokens + day.cachedInputTokens,
      cacheWriteInputTokens: sum.cacheWriteInputTokens + day.cacheWriteInputTokens,
      ordinaryInputTokens: sum.ordinaryInputTokens + day.ordinaryInputTokens,
      totalTokens: sum.totalTokens + day.totalTokens,
      knownRuns: sum.knownRuns + day.knownRuns,
      unknownRuns: sum.unknownRuns + day.unknownRuns,
    }),
    { ...emptyTokens(), knownRuns: 0, unknownRuns: 0 },
  );
  return { daily, totals, allTimeTotals, cache, start, end, invalidDateRuns };
}

export function usageLevel(tokens: number, maximum: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((tokens / maximum) * 4))) as 1 | 2 | 3 | 4;
}
