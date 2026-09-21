import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../apps/desktop/renderer/agent-task-state.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { AGENT_TASK_STATES, getAgentTaskKind, getAgentItemOutcome, getCurrentAgentTaskKind } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const compiledEvents = await build({
  entryPoints: [fileURLToPath(new URL("../packages/runtime/app-server.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { AppServerEvents } =
  await import(`data:text/javascript;base64,${Buffer.from(compiledEvents.outputFiles[0].text).toString("base64")}`);
const record = (item, status = "running", sequence = 1, runId = "current") => ({
  id: `record-${sequence}`, runId, threadId: "thread", sequence, status, item, updatedAt: "2026-09-20T12:00:00Z",
});
const command = (command, overrides = {}) => ({
  id: "command", type: "command_execution", status: "in_progress", aggregated_output: "", command, ...overrides,
});
const tool = (name, overrides = {}) => ({
  id: "tool", type: "native_tool_call", namespace: "nexiom_visual", tool: name,
  arguments: {}, status: "in_progress", ...overrides,
});

test("the activity palette has exactly seven distinct Chinese task states", () => {
  assert.equal(Object.keys(AGENT_TASK_STATES).length, 7);
  assert.equal(new Set(Object.values(AGENT_TASK_STATES).map(value => value.color)).size, 7);
  assert.deepEqual(Object.values(AGENT_TASK_STATES).map(value => value.label), [
    "思考中", "阅读中", "分析中", "检索中", "规划中", "执行中", "编写中",
  ]);
  assert.equal(AGENT_TASK_STATES.thinking.color, "#ffa000");
  assert.equal(AGENT_TASK_STATES.reading.color, "#20ad65");
  assert.equal(AGENT_TASK_STATES.analyzing.color, "#ff6055");
});

test("task types classify without inspecting reasoning, prose, or tool arguments", () => {
  for (const [type, expected] of [
    ["reasoning", "thinking"], ["agent_message", "writing"], ["todo_list", "planning"],
    ["file_change", "writing"], ["web_search", "searching"],
  ]) assert.equal(getAgentTaskKind({ type, text: "read search analyze" }), expected);
  assert.equal(getAgentTaskKind(undefined, "reading"), "reading");
  assert.equal(getAgentTaskKind(tool("unknown_tool", { arguments: { action: "read file" } }), "reading"), "executing");
  assert.equal(getAgentTaskKind(tool("constructor")), "executing");
  assert.equal(getAgentTaskKind(tool("mcp__filesystem__read_file", { type: "mcp_tool_call", server: "filesystem" })), "reading");
  assert.equal(getAgentTaskKind(tool("update_plan")), "planning");
  assert.equal(getAgentTaskKind(tool("analyzeDataFile")), "analyzing");
  assert.equal(getAgentTaskKind(tool("apply_patch")), "writing");
  assert.equal(getAgentTaskKind(tool("search_web")), "searching");
});

test("commands classify only explicit command entry points, including common shell wrappers", () => {
  for (const value of ["cat notes.md", "Get-Content -LiteralPath 'C:\\My Project\\notes.md'", "pdftotext problem.pdf -",
    "powershell.exe -NoProfile -Command \"Get-Content notes.md\"", "/bin/bash -lc 'cat notes.md'",
    '& "C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Get-Content notes.md"'])
    assert.equal(getAgentTaskKind(command(value)), "reading", value);
  for (const value of ["rg --files", "grep needle notes.md", "Select-String -Path notes.md -Pattern needle"])
    assert.equal(getAgentTaskKind(command(value)), "searching", value);
  for (const value of ["python analyze.py", "echo Get-Content", 'echo "rg --files"', "npm run reading",
    "cat notes.md; python work.py", "cat notes.md > copy.md", "bash -lc 'cat notes.md; rm notes.md'", "cat `unknown`"])
    assert.equal(getAgentTaskKind(command(value, { aggregated_output: "read search analyze" })), "executing", value);
});

test("native visual tools classify according to the operations actually registered", () => {
  const names = JSON.parse(readFileSync(new URL("../packages/visualization-engine/native-tools.json", import.meta.url), "utf8"))
    .tools.map(item => item.name);
  const expectations = {
    discover_visual_research_project: "reading", read_visual_research_source: "reading",
    search_visual_research_sources: "searching", search_visual_templates: "searching",
    analyze_data_file: "analyzing", run_visual_research_unit: "analyzing",
    run_visual_design_meeting: "planning", build_paper_visual_inventory: "planning",
    execute_saved_paper_visual_plan: "executing", render_visual_template: "executing",
    generate_principle_figure_prompt: "writing", update_visual_request_fields: "writing",
  };
  for (const [name, expected] of Object.entries(expectations)) {
    assert.ok(names.includes(name), `${name} should exist in the native registry`);
    assert.equal(getAgentTaskKind(tool(name)), expected, name);
  }
  assert.equal(getAgentTaskKind(tool("get_visual_asset")), "reading");
  assert.equal(getAgentTaskKind(tool("create_visual_asset")), "writing");
  assert.equal(getAgentTaskKind(tool("ensure_visual_libraries")), "executing");
});

test("failure, cancellation, and interruption cannot produce a completion check", () => {
  assert.equal(getAgentItemOutcome(record(command("python task.py", { status: "completed", exit_code: 2 }), "completed")), "failed");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "failed" }), "completed")), "failed");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "completed", error: { message: "failed" } }), "completed")), "failed");
  assert.equal(getAgentItemOutcome(record({ type: "error", message: "failed" }, "completed")), "failed");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "completed" }), "interrupted")), "interrupted");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "cancelled" }), "completed")), "cancelled");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "completed" }), "cancelled")), "cancelled");
  for (const result of [{ isError: true }, { success: false }, { ok: false }])
    assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "completed", result }), "completed")), "failed");
  assert.equal(getAgentItemOutcome(record(tool("read_file", {
    type: "mcp_tool_call", server: "filesystem", status: "completed", result: { structured_content: { ok: false } },
  }), "completed")), "failed");
});

test("completion requires a completed record without unresolved inner state", () => {
  assert.equal(getAgentItemOutcome(record(command("cat note", { status: "completed", exit_code: 0 }), "completed")), "completed");
  assert.equal(getAgentItemOutcome(record({ type: "agent_message", text: "done" }, "completed")), "completed");
  assert.equal(getAgentItemOutcome(record(tool("read_file"), "completed")), "running");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "unknown" }), "completed")), "running");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "completed" }), "unknown")), "running");
  assert.equal(getAgentItemOutcome(record(tool("read_file", { status: "completed" }))), "running");
});

test("current task uses the latest running sequence from its run, independent of array order", () => {
  const items = [
    record(tool("analyze_data_file"), "running", 8),
    record(tool("create_visual_asset"), "running", 99, "another-run"),
    record(tool("get_visual_asset", { status: "completed" }), "completed", 100),
    record(tool("render_visual_template", { status: "failed" }), "running", 101),
    record(tool("update_plan"), "running", 3),
    record(tool("read_file"), "interrupted", 102),
  ];
  assert.equal(getCurrentAgentTaskKind(items, "current"), "analyzing");
  assert.equal(getCurrentAgentTaskKind([...items].reverse(), "current"), "analyzing");
  assert.equal(getCurrentAgentTaskKind(items, "missing", "reading"), "reading");
  assert.equal(getCurrentAgentTaskKind([], "current"), "thinking");
});

test("MCP error results preserve failure from the native event through the activity indicator", () => {
  const events = new AppServerEvents("current");
  for (const isError of [true, false]) {
    const event = events.map("item/completed", { turnId: "current", item: {
      id: "read", type: "mcpToolCall", server: "files", tool: "read_file", status: "completed",
      arguments: { path: "input.txt" }, result: { isError, content: [{ type: "text", text: "tool result" }] },
    } })[0];
    assert.equal(event.type, "item.completed");
    assert.equal(getAgentTaskKind(event.item), "reading");
    assert.equal(getAgentItemOutcome(record(event.item, "completed")), isError ? "failed" : "completed");
  }
});

test("ending the native turn does not mark unfinished plan steps as completed", () => {
  for (const stepStatus of ["pending", "in_progress", "completed"]) {
    const events = new AppServerEvents("current");
    const started = events.map("turn/plan/updated", { turnId: "current", plan: [
      { step: "Read source", status: "completed" }, { step: "Analyze source", status: stepStatus },
    ] })[0];
    assert.equal(getAgentItemOutcome(record(started.item)), "running");
    const completed = events.map("turn/completed", { turn: { id: "current", status: "completed" } })[0];
    assert.equal(completed.type, "item.completed");
    assert.equal(getAgentItemOutcome(record(completed.item, "completed")), stepStatus === "completed" ? "completed" : "interrupted");
  }
});

test("a persistent native plan does not reclaim activity after its tool finishes", () => {
  const events = new AppServerEvents("current");
  const planEvent = events.map("turn/plan/updated", { turnId: "current", plan: [{ step: "Read source", status: "pending" }] })[0];
  const plan = record(planEvent.item, "running", 1);
  assert.equal(getCurrentAgentTaskKind([plan], "current"), "planning");
  const rawCommand = { id: "read", type: "commandExecution", command: "cat input.txt", aggregatedOutput: "" };
  const runningCommand = events.map("item/started", { turnId: "current", item: { ...rawCommand, status: "inProgress" } })[0];
  assert.equal(getCurrentAgentTaskKind([plan, record(runningCommand.item, "running", 2)], "current"), "reading");
  const doneCommand = events.map("item/completed", { turnId: "current", item: { ...rawCommand, status: "completed", exitCode: 0 } })[0];
  const items = [plan, record(doneCommand.item, "completed", 2)];
  assert.equal(getCurrentAgentTaskKind(items, "current"), "thinking");
  assert.equal(getCurrentAgentTaskKind(items, "current", "planning"), "planning");
  assert.equal(getCurrentAgentTaskKind([...items].reverse(), "current"), "thinking");
  assert.equal(getCurrentAgentTaskKind([plan, record(doneCommand.item, "completed", 99, "another-run")], "current"), "planning");
});
