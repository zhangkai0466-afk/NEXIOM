import { test } from "node:test";
import assert from "node:assert/strict";
import runtime from "../.build/runtime.cjs";

test("MCP isError results normalize to failed items without discarding result content", () => {
  const events = new runtime.AppServerEvents();
  const content = [{ type: "text", text: "The requested file does not exist." }];
  for (const isError of [true, false]) {
    const [event] = events.map("item/completed", { item: {
      id: "mcp-read", type: "mcpToolCall", server: "files", tool: "read_file",
      arguments: { path: "missing.txt" }, status: "completed", result: { content, isError },
    } });
    assert.equal(event.type, "item.completed");
    assert.equal(event.item.status, isError ? "failed" : "completed");
    assert.deepEqual(event.item.result.content, content);
  }
});

test("native text deltas remain partial until the completed item arrives", () => {
  const events = new runtime.AppServerEvents();
  const started = events.map("item/started", {
    item: { type: "agentMessage", id: "answer", text: "" },
  });
  assert.equal(started[0].type, "item.started");
  assert.equal(
    events.map("item/agentMessage/delta", {
      itemId: "answer",
      delta: "结论：",
    })[0].item.text,
    "结论：",
  );
  const partial = events.map("item/agentMessage/delta", {
    itemId: "answer",
    delta: "2",
  });
  assert.equal(partial[0].type, "item.updated");
  assert.equal(partial[0].item.text, "结论：2");
  const completed = events.map("item/completed", {
    item: { type: "agentMessage", id: "answer", text: "结论：2。" },
  });
  assert.equal(completed[0].type, "item.completed");
  assert.equal(completed[0].item.text, "结论：2。");
});

test("reasoning items, summaries and raw reasoning stay out of the transcript", () => {
  const events = new runtime.AppServerEvents();
  assert.deepEqual(
    events.map("item/reasoning/textDelta", {
      itemId: "r1",
      delta: "private reasoning",
    }),
    [],
  );
  const started = events.map("item/started", {
    item: { id: "r1", type: "reasoning", summary: [] },
  });
  assert.deepEqual(started, [{
    type: "item.started",
    item: { id: "activity:r1", type: "agent_activity", phase: "thinking" },
  }]);
  assert.deepEqual(events.map("item/reasoning/summaryTextDelta", {
    itemId: "r1",
    summaryIndex: 0,
    delta: "检查数据",
  }), []);
  const part = events.map("item/reasoning/summaryTextDelta", {
    itemId: "r1",
    summaryIndex: 1,
    delta: "验证结果",
  });
  assert.deepEqual(part, []);
  const done = events.map("item/completed", {
    item: {
      id: "r1",
      type: "reasoning",
      summary: ["公开摘要"],
      content: ["private reasoning"],
    },
  });
  assert.deepEqual(done, [{ type: "item.completed", item: started[0].item }]);
  assert.ok(!JSON.stringify(done).includes("private reasoning"));
  assert.ok(!JSON.stringify(done).includes("公开摘要"));
});

test("native context metrics and compaction are reported without invented limits", () => {
  const events = new runtime.AppServerEvents();
  const result = events.map("thread/tokenUsage/updated", {
    tokenUsage: {
      modelContextWindow: null,
      total: { totalTokens: 2100 },
      last: {
        inputTokens: 1300,
        outputTokens: 100,
        cachedInputTokens: 400,
        cacheWriteInputTokens: 300,
      },
    },
  });
  assert.equal(result[0].modelContextWindow, null);
  assert.equal(result[0].totalTokens, 2100);
  assert.equal(result[0].lastInputTokens, 1300);
  assert.equal(result[0].cacheWriteInputTokens, 300);
  assert.deepEqual(
    events.map("item/started", {
      item: { type: "contextCompaction", id: "compact1" },
    }),
    [],
  );
  assert.equal(
    events.map("item/completed", {
      item: { type: "contextCompaction", id: "compact1" },
    })[0].type,
    "context.compacted",
  );
  assert.deepEqual(
    events.map("item/completed", {
      item: { type: "contextCompaction", id: "compact1" },
    }),
    [],
  );
  assert.equal(
    new runtime.AppServerEvents().map("turn/completed", {
      turn: { status: "completed" },
    })[0].usage,
    null,
  );
});

test("chats retain thinking lifecycle without retaining any reasoning or summaries", () => {
  const events = new runtime.AppServerEvents("reading-turn", true);
  const raw = { id: "thought-1", type: "reasoning", summary: ["private summary"], content: ["private reasoning"] };
  const start = events.map("item/started", { turnId: "reading-turn", item: raw });
  assert.deepEqual(start, [{ type: "item.started", item: { id: "activity:thought-1", type: "agent_activity", phase: "thinking" } }]);
  assert.deepEqual(events.map("item/reasoning/textDelta", { turnId: "reading-turn", itemId: raw.id, delta: "private reasoning" }), []);
  assert.deepEqual(events.map("item/reasoning/summaryTextDelta", { turnId: "reading-turn", itemId: raw.id, delta: "private summary" }), []);
  const end = events.map("item/completed", { turnId: "reading-turn", item: raw });
  assert.deepEqual(end, [{ type: "item.completed", item: start[0].item }]);
  assert.ok(!JSON.stringify([...start, ...end]).includes("private"));
  assert.deepEqual(events.map("item/started", { turnId: "older-turn", item: raw }), []);
  const plain = new runtime.AppServerEvents().map("item/started", { item: raw });
  assert.deepEqual(plain, [{ type: "item.started", item: { id: "activity:thought-1", type: "agent_activity", phase: "thinking" } }]);
  assert.ok(!JSON.stringify(plain).includes("private"));
});

test("failed native turns are failures and command streams retain their exit result", () => {
  const events = new runtime.AppServerEvents();
  events.map("item/started", {
    item: {
      type: "commandExecution",
      id: "cmd",
      command: "python solve.py",
      status: "inProgress",
      aggregatedOutput: "",
    },
  });
  assert.equal(
    events.map("item/commandExecution/outputDelta", {
      itemId: "cmd",
      delta: "result",
    })[0].item.aggregated_output,
    "result",
  );
  const done = events.map("item/completed", {
    item: {
      type: "commandExecution",
      id: "cmd",
      command: "python solve.py",
      aggregatedOutput: "result",
      status: "failed",
      exitCode: 1,
    },
  });
  assert.equal(done[0].item.exit_code, 1);
  assert.equal(
    events.map("turn/completed", {
      turn: { status: "failed", error: { message: "provider unavailable" } },
    })[0].type,
    "turn.failed",
  );
});

test("turn usage accumulates all model calls while context retains only native last usage", () => {
  const events = new runtime.AppServerEvents("current");
  events.map("turn/started", { turn: { id: "current" } });
  events.map("thread/tokenUsage/updated", {
    turnId: "current",
    tokenUsage: {
      total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 50, cacheWriteInputTokens: 20 },
      last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 50, cacheWriteInputTokens: 20 },
    },
  });
  const context = events.map("thread/tokenUsage/updated", {
    turnId: "current",
    tokenUsage: {
      total: { inputTokens: 250, outputTokens: 30, cachedInputTokens: 150, cacheWriteInputTokens: 40 },
      last: { inputTokens: 150, outputTokens: 20, cachedInputTokens: 100, cacheWriteInputTokens: 20 },
    },
  });
  assert.equal(context[0].lastInputTokens, 150);
  assert.equal(context[0].lastOutputTokens, 20);
  const completed = events.map("turn/completed", {
    turn: { id: "current", status: "completed" },
  });
  assert.equal(completed[0].usage.input_tokens, 250);
  assert.equal(completed[0].usage.output_tokens, 30);
  assert.equal(completed[0].usage.cached_input_tokens, 150);
  assert.equal(completed[0].usage.cache_write_input_tokens, 40);
});

test("resumed usage subtracts the native replay baseline and excludes historical turns", () => {
  const events = new runtime.AppServerEvents("current", false);
  const historical = {
    total: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500, cacheWriteInputTokens: 100 },
    last: { inputTokens: 400, outputTokens: 40, cachedInputTokens: 200, cacheWriteInputTokens: 40 },
  };
  assert.deepEqual(
    events.map("thread/tokenUsage/updated", {
      turnId: "previous",
      tokenUsage: historical,
    }),
    [],
  );
  events.map("turn/started", { turn: { id: "current" } });
  // Rate-limit notifications can repeat old token counts under the new turn id.
  events.map("thread/tokenUsage/updated", {
    turnId: "current",
    tokenUsage: historical,
  });
  events.map("thread/tokenUsage/updated", {
    turnId: "current",
    tokenUsage: {
      total: { inputTokens: 1250, outputTokens: 130, cachedInputTokens: 650, cacheWriteInputTokens: 140 },
      last: { inputTokens: 150, outputTokens: 20, cachedInputTokens: 100, cacheWriteInputTokens: 20 },
    },
  });
  assert.deepEqual(
    events.map("thread/tokenUsage/updated", {
      turnId: "previous",
      tokenUsage: historical,
    }),
    [],
  );
  assert.deepEqual(
    events.map("turn/completed", {
      turn: { id: "previous", status: "completed" },
    }),
    [],
  );
  assert.equal(events.complete, false);
  const completed = events.map("turn/completed", {
    turn: { id: "current", status: "completed" },
  });
  assert.equal(completed[0].usage.input_tokens, 250);
  assert.equal(completed[0].usage.output_tokens, 30);
  assert.equal(completed[0].usage.cached_input_tokens, 150);
  assert.equal(completed[0].usage.cache_write_input_tokens, 40);
});

test("resumed usage remains unknown when native history has no reliable baseline", () => {
  const events = new runtime.AppServerEvents("current", false);
  events.map("turn/started", { turn: { id: "current" } });
  events.map("thread/tokenUsage/updated", {
    turnId: "current",
    tokenUsage: {
      total: { inputTokens: 1250, outputTokens: 130 },
      last: { inputTokens: 150, outputTokens: 20 },
    },
  });
  assert.equal(
    events.map("turn/completed", {
      turn: { id: "current", status: "completed" },
    })[0].usage,
    null,
  );
});
