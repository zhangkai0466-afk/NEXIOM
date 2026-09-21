import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const result = await build({
  entryPoints: [fileURLToPath(new URL("../apps/desktop/renderer/reading-progress-motion.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { advanceReadingScroll, readingArrivalDelay } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("chain scrolling converges without overshooting or dropping frames to a timer restart", () => {
  let state = { position: 0, velocity: 0 };
  for (let frame = 0; frame < 180; frame++) {
    const previous = state;
    state = advanceReadingScroll(state, 1000, 1000 / 60);
    assert.ok(state.position >= previous.position);
    assert.ok(state.position <= 1000);
    assert.ok(Number.isFinite(state.velocity));
  }
  assert.deepEqual(state, { position: 1000, velocity: 0 });
});

test("new actions retarget an in-flight scroll without resetting its velocity", () => {
  let state = { position: 0, velocity: 0 };
  for (let frame = 0; frame < 8; frame++) state = advanceReadingScroll(state, 100, 1000 / 60);
  assert.ok(state.velocity > 0);
  assert.deepEqual(advanceReadingScroll(state, 300, 0), state);
  const next = advanceReadingScroll(state, 300, 1000 / 60);
  const restarted = advanceReadingScroll({ ...state, velocity: 0 }, 300, 1000 / 60);
  assert.ok(next.position > restarted.position);
  for (let frame = 0; frame < 180; frame++) state = advanceReadingScroll(state, 300, 1000 / 60);
  assert.deepEqual(state, { position: 300, velocity: 0 });
});

test("background-tab delays are bounded and high-refresh displays converge", () => {
  const state = { position: 0, velocity: 0 };
  assert.deepEqual(advanceReadingScroll(state, 500, 10_000), advanceReadingScroll(state, 500, 64));
  let smooth = state;
  for (let frame = 0; frame < 240; frame++) smooth = advanceReadingScroll(smooth, 500, 1000 / 120);
  assert.deepEqual(smooth, { position: 500, velocity: 0 });
});

test("batch arrivals have a short bounded stagger, never a growing playback backlog", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 100].map(index => readingArrivalDelay(index)), [0, 55, 110, 165, 220, 220]);
  assert.equal(readingArrivalDelay(0, 130), 130, "a later batch waits for the preceding arrivals");
  assert.equal(readingArrivalDelay(100, 130), 220);
  assert.equal(readingArrivalDelay(0, -500), 0);
});
