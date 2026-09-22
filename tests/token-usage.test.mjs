import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../apps/desktop/renderer/token-usage.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`;
const { parseTokenUsage, aggregateTokenUsage, localDateKey, tokenRate, usageLevel } = await import(moduleUrl);
const usage = (input = 100, output = 20, cached = 70, written = 10) => JSON.stringify({
  input_tokens: input,
  output_tokens: output,
  cached_input_tokens: cached,
  cache_write_input_tokens: written,
});
const run = (id, createdAt, value = usage(), kind = "agent", cacheThreadState) => ({
  id,
  createdAt,
  usage: value,
  kind,
  runtimeConfig: cacheThreadState ? JSON.stringify({ cacheThreadState }) : null,
});

test("run token counts include cached input only once and preserve known zero", () => {
  assert.deepEqual(parseTokenUsage(usage()), {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 70,
    cacheWriteInputTokens: 10,
    ordinaryInputTokens: 20,
    totalTokens: 120,
  });
  assert.equal(parseTokenUsage(usage(0, 0, 0, 0)).totalTokens, 0);
  assert.equal(parseTokenUsage('{"input_tokens":9,"output_tokens":3}').totalTokens, 12);
  assert.equal(tokenRate(70, 100), 0.7);
  assert.equal(tokenRate(0, 0), null);
});

test("missing or invalid token reports stay unknown", () => {
  for (const value of [
    null, undefined, "", "null", "[]", "{}", "not JSON",
    '{"input_tokens":100}', '{"input_tokens":"100","output_tokens":20}',
    usage(-1, 20, 0, 0), usage(1.5, 20, 0, 0), usage(100, 20, 101, 0),
    usage(100, 20, 70, 31), usage(Number.MAX_SAFE_INTEGER, 1, 0, 0),
  ]) assert.equal(parseTokenUsage(value), null, String(value));
});

test("daily totals aggregate each agent run once, isolate unreported usage, and ignore inspections", () => {
  const date = new Date(2026, 8, 19, 12);
  const created = date.toISOString();
  const report = aggregateTokenUsage([
    run("one", created, usage(), "agent", "continuation"),
    run("one", created, usage(), "agent", "continuation"),
    run("two", created, usage(40, 10, 10, 5), "agent", "new_thread"),
    run("missing", created, null),
    run("broken", created, "bad"),
    run("inspection", created, null, "inspection"),
    run("zero", created, usage(0, 0, 0, 0)),
  ], date);
  assert.equal(report.daily.length, 365);
  assert.equal(report.totals.totalTokens, 170);
  assert.equal(report.totals.inputTokens, 140);
  assert.equal(report.totals.outputTokens, 30);
  assert.equal(report.totals.cachedInputTokens, 80);
  assert.equal(report.totals.cacheWriteInputTokens, 15);
  assert.equal(report.totals.ordinaryInputTokens, 45);
  assert.equal(report.totals.knownRuns, 3);
  assert.equal(report.totals.unknownRuns, 2);
  assert.deepEqual(report.cache, {
    newThreadRuns: 1,
    continuationRuns: 1,
    unknownStateRuns: 1,
    continuationInputTokens: 100,
    continuationCachedInputTokens: 70,
  });
  assert.equal(report.daily.at(-1).date, "2026-09-19");
  assert.equal(report.daily.at(-1).totalTokens, 170);
  assert.equal(report.daily.at(-2).knownRuns, 0);
});

test("date window uses local calendar dates, excludes old/future days, and reports invalid dates", () => {
  const now = new Date(2026, 8, 19, 12);
  const report = aggregateTokenUsage([
    run("start", new Date(2026, 8, 17, 0, 1).toISOString()),
    run("end", new Date(2026, 8, 19, 23, 59).toISOString()),
    run("old", new Date(2026, 8, 16, 23, 59).toISOString()),
    run("future", new Date(2026, 8, 20, 0, 1).toISOString()),
    run("invalid", "broken-date"),
  ], now, 3);
  assert.deepEqual(report.daily.map((day) => day.date), ["2026-09-17", "2026-09-18", "2026-09-19"]);
  assert.equal(report.totals.totalTokens, 240);
  assert.equal(report.allTimeTotals.totalTokens, 360);
  assert.equal(report.invalidDateRuns, 1);
  assert.equal(localDateKey(new Date(2026, 0, 2)), "2026-01-02");
});

test("lifetime usage retains older years but excludes tomorrow midnight", () => {
  const now = new Date(2026, 8, 22, 12);
  const report = aggregateTokenUsage([
    run("old", new Date(2024, 0, 1).toISOString()),
    run("today", now.toISOString()),
    run("tomorrow", new Date(2026, 8, 23).toISOString()),
  ], now);
  assert.equal(report.totals.totalTokens, 120);
  assert.equal(report.allTimeTotals.totalTokens, 240);
});

test("calendar grid keeps every date across daylight-saving transitions and leap day", () => {
  const source = `
    import { aggregateTokenUsage } from ${JSON.stringify(moduleUrl)};
    const spring = aggregateTokenUsage([], new Date(2026, 2, 10, 12), 5);
    const autumn = aggregateTokenUsage([], new Date(2026, 10, 3, 12), 5);
    const leap = aggregateTokenUsage([], new Date(2024, 2, 1, 12), 3);
    process.stdout.write(JSON.stringify([spring, autumn, leap].map(x => x.daily.map(d => d.date))));
  `;
  const dates = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, TZ: "America/New_York" },
    encoding: "utf8",
  }));
  assert.deepEqual(dates[0], ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  assert.deepEqual(dates[1], ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(dates[2], ["2024-02-28", "2024-02-29", "2024-03-01"]);
});

test("blue intensity increases with daily token usage", () => {
  assert.deepEqual([0, 1, 25, 26, 50, 51, 75, 76, 100].map((n) => usageLevel(n, 100)), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(usageLevel(0, 0), 0);
});
