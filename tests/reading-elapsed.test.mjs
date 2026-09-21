import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../apps/desktop/renderer/reading-elapsed.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { readingElapsedSeconds, formatReadingElapsed } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const createdAt = "2026-09-21T12:00:00.000Z";
const start = Date.parse(createdAt);
const running = { createdAt, finishedAt: null, status: "running" };

test("reading timer uses the run start, including remounts and delayed background ticks", () => {
  assert.equal(readingElapsedSeconds(running, start), 0);
  assert.equal(readingElapsedSeconds(running, start + 1999), 1);
  assert.equal(readingElapsedSeconds(running, start + 137_000), 137);
});

test("success, cancellation, failure and interruption freeze at the saved finish timestamp", () => {
  for (const status of ["succeeded", "cancelled", "failed", "interrupted"]) {
    const run = { ...running, status, finishedAt: "2026-09-21T12:02:03.000Z" };
    assert.equal(readingElapsedSeconds(run, start + 300_000), 123);
    assert.equal(readingElapsedSeconds(run, start + 86_400_000), 123);
  }
});

test("unknown historical timing stays unknown and clock skew cannot produce negative time", () => {
  assert.equal(readingElapsedSeconds({ ...running, status: "cancelled" }, start), null);
  assert.equal(readingElapsedSeconds({ ...running, createdAt: "invalid" }, start), null);
  assert.equal(readingElapsedSeconds({ ...running, status: "failed", finishedAt: "invalid" }, start), null);
  assert.equal(readingElapsedSeconds(running, start - 5000), 0);
  assert.equal(formatReadingElapsed(null), "--:--");
});

test("reading duration is padded and includes hours for long tasks", () => {
  for (const [seconds, expected] of [[0, "00:00"], [5, "00:05"], [59, "00:59"], [60, "01:00"], [3599, "59:59"], [3600, "01:00:00"], [3723, "01:02:03"], [360_000, "100:00:00"]])
    assert.equal(formatReadingElapsed(seconds), expected);
});
