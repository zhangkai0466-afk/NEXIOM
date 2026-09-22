import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

async function moduleFor(file) {
  const result = await build({ entryPoints: [file], bundle: true, platform: "node", format: "esm", write: false, target: "node24" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { TokenActivityLedger } = await moduleFor("packages/core/token-activity.ts");
const { readNativeUsageHistory } = await moduleFor("packages/core/native-usage-history.ts");
const date = "2026-09-21T12:00:00.000Z";
const counts = (input = 100, output = 20) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: 0 });
const entry = (id = randomUUID(), value = counts()) => ({
  id: `run:${id}`, runId: id, source: "run", kind: "agent", createdAt: date, finishedAt: null,
  usage: value ? JSON.stringify(value) : null, runtimeConfig: null, nativeThreadId: null, nativeTurnId: null,
});
const total = ledger => ledger.activities().reduce((sum, activity) => {
  const usage = JSON.parse(activity.usage ?? "null");
  return sum + (usage ? usage.input_tokens + usage.output_tokens : 0);
}, 0);
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "nexiom-token-"));
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE runs (id TEXT, threadId TEXT, projectId TEXT, createdAt TEXT, finishedAt TEXT);
    CREATE TABLE agent_runs (runId TEXT, usage TEXT, runtimeConfig TEXT, activityId TEXT);
    CREATE TABLE projects (id TEXT, root TEXT);
    CREATE TABLE agent_threads (threadId TEXT, engineThreadId TEXT);`);
  const ledger = new TokenActivityLedger(db, dir);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, ledger };
}
function log(dir, name, rows) {
  mkdirSync(path.join(dir, "sessions"), { recursive: true });
  writeFileSync(path.join(dir, "sessions", name + ".jsonl"), rows.map(row => JSON.stringify({ timestamp: date, ...row })).join("\n") + '\n{"partial":');
}
const meta = (id, originator = "nexiom") => ({ type: "session_meta", payload: { id, originator } });
const start = turn_id => ({ type: "event_msg", payload: { type: "task_started", turn_id } });
const context = (turn_id, cwd) => ({ type: "turn_context", payload: { turn_id, cwd } });
const report = (thread_id, turn_id, input, output) => ({ type: "token_usage_record", payload: { thread_id, turn_id, turn_token_usage: counts(input, output) } });
const legacy = (input, output) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counts(input, output), last_token_usage: counts(99, 99) } } });
const finish = turn_id => ({ type: "event_msg", timestamp: "2026-09-21T12:00:30.000Z", payload: { type: "task_complete", turn_id } });

test("native recovery deduplicates cumulative snapshots, fork history and legacy reports", t => {
  const { dir } = fixture(t);
  log(dir, "01-original", [meta("original"), start("turn1"), context("turn1", dir), report("original", "turn1", 40, 2), legacy(40, 2), report("original", "turn1", 100, 20), legacy(100, 20), finish("turn1"), start("turn2"), legacy(150, 25), finish("turn2")]);
  log(dir, "02-fork", [meta("fork"), start("turn1"), report("original", "turn1", 100, 20), legacy(100, 20), finish("turn1"), start("turn2"), legacy(150, 25), finish("turn2"), start("turn3"), report("fork", "turn3", 10, 1)]);
  log(dir, "03-personal", [meta("personal", "codex_cli_rs"), start("private"), report("personal", "private", 999, 99)]);
  const { activities, warnings } = readNativeUsageHistory(dir);
  assert.deepEqual(warnings, []);
  assert.equal(activities.length, 3);
  assert.equal(activities.reduce((sum, x) => { const u = JSON.parse(x.usage); return sum + u.input_tokens + u.output_tokens; }, 0), 186);
  assert.equal(activities.find(x => x.nativeTurnId === "turn1").finishedAt, "2026-09-21T12:00:30.000Z");
  assert.equal(activities.find(x => x.nativeTurnId === "turn2").nativeThreadId, "original");
});

test("recovery never follows a sessions directory junction", t => {
  const { dir } = fixture(t);
  const outside = path.join(dir, "outside");
  mkdirSync(outside);
  log(outside, "private", [meta("external"), start("turn"), report("external", "turn", 100, 20)]);
  symlinkSync(path.join(outside, "sessions"), path.join(dir, "sessions"), "junction");
  assert.deepEqual(readNativeUsageHistory(dir).activities, []);
});

test("backup merge is idempotent, atomic, monotonic, and strips private configuration", t => {
  const { ledger } = fixture(t);
  const first = { ...entry(), runtimeConfig: JSON.stringify({ cacheThreadState: "continuation", apiKey: "SECRET" }) };
  // Internal callers can supply configuration; the persisted backup retains only cache state.
  ledger.put(first);
  const backup = ledger.export();
  assert.equal(backup.includes("SECRET"), false);
  assert.equal(ledger.import(backup), 0);
  assert.equal(total(ledger), 120);
  ledger.put({ ...first, usage: null });
  ledger.put({ ...first, usage: JSON.stringify(counts(20, 1)) });
  assert.equal(total(ledger), 120);
  const invalid = JSON.parse(backup);
  invalid.activities = [entry(), { ...entry(), usage: '{"input_tokens":-1,"output_tokens":0}' }];
  assert.throws(() => ledger.import(JSON.stringify(invalid)), /无效计数/);
  assert.equal(ledger.all().length, 1);
  assert.equal(total(ledger), 120);
  const unknown = entry(randomUUID(), null);
  ledger.put(unknown);
  assert.equal(ledger.activities().find(x => x.id === unknown.id).usage, null);
});

test("automatic backups restore independently of deleted project/run tables and tolerate corrupt current backup", t => {
  const { db, ledger, dir } = fixture(t);
  const first = entry(); ledger.put(first); ledger.saveBackup();
  ledger.put(entry()); ledger.saveBackup();
  const recovered = readFileSync(path.join(dir, "usage", "token-activity.json"), "utf8");
  writeFileSync(path.join(dir, "usage", "token-activity.recovered.json"), recovered);
  writeFileSync(path.join(dir, "usage", "token-activity.json"), "damaged");
  db.exec("DELETE FROM token_activity; DROP TABLE runs; DROP TABLE agent_runs; DROP TABLE projects;");
  const restored = new TokenActivityLedger(db, dir);
  restored.restoreBackups();
  assert.equal(total(restored), 240);
  assert.match(restored.warning, /无法读取/);
});

test("native turns replace summaries only when at least as complete, retaining partial failed usage", t => {
  const { ledger } = fixture(t);
  const run = entry(); ledger.put(run);
  const native = (turn, input, output) => ({ ...run, id: `native:engine:${turn}`, source: "native", nativeThreadId: "engine", nativeTurnId: turn, usage: JSON.stringify(counts(input, output)) });
  ledger.put(native("one", 40, 10));
  assert.equal(total(ledger), 120);
  assert.equal(ledger.activities()[0].source, "run");
  ledger.put(native("two", 60, 10));
  assert.equal(total(ledger), 120);
  assert.equal(ledger.activities().length, 2);
  ledger.put(native("three-failed", 10, 1));
  assert.equal(total(ledger), 131);
  const backup = ledger.export();
  const restored = new DatabaseSync(":memory:");
  try {
    const imported = new TokenActivityLedger(restored, "unused");
    assert.equal(imported.import(backup), 3); // Only visible activities, not their redundant summary.
    assert.equal(total(imported), 131);
  } finally { restored.close(); }
});

test("backfill and local recovery link one historical task without double counting copied runs", t => {
  const { db, ledger, dir } = fixture(t);
  const runId = randomUUID(), forkId = randomUUID();
  db.prepare("INSERT INTO projects VALUES ('project', ?)").run(dir);
  for (const id of [runId, forkId]) {
    db.prepare("INSERT INTO runs VALUES (?, 'thread', 'project', ?, ?)").run(id, date, "2026-09-21T12:00:40.000Z");
    db.prepare("INSERT INTO agent_runs VALUES (?, ?, NULL, ?)").run(id, JSON.stringify(counts()), runId);
  }
  db.prepare("INSERT INTO agent_threads VALUES ('thread', 'original')").run();
  log(dir, "01-run", [meta("original"), start("one"), context("one", dir), report("original", "one", 100, 20), finish("one")]);
  assert.equal(ledger.recover(dir), 1);
  assert.equal(ledger.recover(dir), 0);
  assert.equal(total(ledger), 120);
  assert.equal(ledger.activities().length, 1);
  assert.equal(ledger.activities()[0].runId, runId);
  db.exec("DELETE FROM runs; DELETE FROM agent_runs; DELETE FROM projects;");
  ledger.recover(dir);
  assert.equal(total(ledger), 120);
});
