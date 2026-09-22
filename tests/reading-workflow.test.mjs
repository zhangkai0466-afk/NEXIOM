import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { createReadingTools, readingWebSearchMode } = await load("../packages/runtime/reading-tools.ts");
const { readingSteps, readingProgressNotice, readingCanViewReport, latestFormalReadingRun } = await load("../apps/desktop/renderer/reading-progress.ts");
const { readingWorkflowInstructions, readingReportStructure, readingDiscussionInstructions, readingDeveloperInstructions, buildReadingDiscussionPrompt, parseReadingDiscussion, readingDiscussionBounds, isReadingDiscussionSequence, latestReadingTurnIsDiscussion, READING_CORRECTION_MARKER } = await load("../packages/contracts/reading-workflow.ts");
const { readingProseTables } = await load("../apps/desktop/renderer/reading-prose-tables.ts");
const { getCurrentAgentTaskKind } = await load("../apps/desktop/renderer/agent-task-state.ts");
const input = { stageId: "reading", signal: new AbortController().signal, settings: { network: true } };
const run = { id: "r1", status: "running" };
const progress = (sequence, phase, status, stepId = phase) => ({
  id: `call-${sequence}`, runId: "r1", sequence, status: "completed",
  item: { type: "native_tool_call", namespace: "nexiom_reading", tool: "set_reading_stage", status: "completed", arguments: { stepId, phase, status } },
});
const action = (sequence, id, item, status = "completed") => ({
  id, sequence, runId: run.id, status, item: { id, ...item },
});
const step = (id, kind, status) => ({ id: `${id}:${run.id}`, kind, status });
const phaseSequence = phases => phases.map((phase, index) => progress(index + 1, phase, "completed", `step-${index}`));

test("reading web search honors network permission and does not enable unrelated stages", () => {
  assert.equal(readingWebSearchMode(input), "live");
  assert.equal(readingWebSearchMode({ ...input, settings: { network: false } }), "disabled");
  assert.equal(readingWebSearchMode({ ...input, stageId: "model" }), "disabled");
  assert.equal(createReadingTools({ ...input, stageId: "attachments" }), undefined);
});
test("reading progress requires starts, matching identities and actual phase completion", async () => {
  const tools = createReadingTools(input);
  const call = (phase, status, stepId = phase) => tools.call("nexiom_reading", "set_reading_stage", { phase, status, stepId });
  assert.equal((await call("reading", "completed")).success, false);
  assert.equal((await call("reading", "running")).success, true);
  assert.equal((await call("analyzing", "running")).success, false);
  assert.equal((await call("analyzing", "completed", "reading")).success, false);
  assert.equal((await call("reading", "completed")).success, true);
  assert.equal((await call("reading", "running")).success, false);
  assert.equal((await call("reading", "running", "reading-2")).success, false);
  assert.equal((await call("writing", "running")).success, false);
  assert.equal((await call("analyzing", "running")).success, true);
  assert.equal((await call("analyzing", "completed")).success, true);
  assert.equal((await call("thinking", "running")).success, true);
  assert.equal((await call("thinking", "completed")).success, true);
  assert.equal((await call("reading", "running", "reading-2")).success, true);
  tools.close();
  assert.equal((await call("reading", "completed", "reading-2")).success, false);
});
test("chain aggregates rereading into review and ignores other runs and failed calls", () => {
  const items = [progress(1, "reading", "running"), progress(2, "reading", "completed"), progress(3, "analyzing", "running"),
    progress(4, "analyzing", "completed"), progress(5, "thinking", "completed"), progress(6, "reading", "running", "reading-2"),
    { ...progress(7, "searching", "running"), runId: "other" },
    { ...progress(8, "writing", "running"), status: "failed" }];
  assert.deepEqual(readingSteps(items, run), [
    step("reading", "reading", "completed"),
    step("analyzing", "analyzing", "completed"),
    step("review", "reading", "running"),
  ]);
  assert.equal(getCurrentAgentTaskKind(items, run.id), "reading");
});
test("waiting without evidence never fabricates thinking, preparation, or completed work", () => {
  const noise = [
    action(1, "command", { type: "command_execution", command: "python inspect_pdf.py", status: "completed", exit_code: 0 }),
    action(2, "plan", { type: "todo_list", items: [] }),
    action(3, "answer", { type: "agent_message", text: "report" }),
    action(4, "activity", { type: "agent_activity", phase: "reading" }),
  ];
  for (const status of ["running", "succeeded", "cancelled", "failed"]) {
    assert.deepEqual(readingSteps([], { ...run, status }), []);
    assert.deepEqual(readingSteps(noise, { ...run, status }), []);
  }
  assert.deepEqual(readingSteps([progress(1, "reading", "running")], run), [step("reading", "reading", "running")]);
});

test("run termination preserves completed work and never invents active-phase completion", () => {
  const items = [progress(1, "reading", "running")];
  assert.equal(readingSteps(items, { ...run, status: "cancelled" }).at(-1).status, "cancelled");
  assert.equal(readingSteps(items, { ...run, status: "succeeded" }).at(-1).status, "interrupted");
  assert.equal(readingSteps(items, { ...run, status: "failed" }).at(-1).status, "failed");
  assert.equal(readingSteps(items, { ...run, status: "interrupted" }).at(-1).status, "interrupted");
});

test("waiting and missing-record notices are separate from the action chain", () => {
  assert.equal(readingProgressNotice([], run), "等待模型报告研读阶段…");
  assert.equal(readingProgressNotice([step("reading", "reading", "completed")], run), undefined);
  assert.equal(readingProgressNotice([step("reading", "reading", "running")], run), undefined);
  const succeeded = { ...run, status: "succeeded" };
  assert.equal(readingProgressNotice([], succeeded), "研读已结束，未记录详细阶段");
  assert.equal(readingProgressNotice([step("reading", "reading", "completed")], succeeded), "研读已结束，部分阶段记录不完整");
  const complete = readingSteps(phaseSequence(["reading", "analyzing", "thinking", "writing"]), succeeded);
  assert.equal(readingProgressNotice(complete, succeeded), undefined);
});

test("a live writing completion offers the report without treating the run as finished", () => {
  const items = phaseSequence(["reading", "analyzing", "thinking", "writing"]);
  assert.equal(readingCanViewReport(readingSteps(items, run), run), true);
  assert.equal(readingCanViewReport(readingSteps(phaseSequence(["reading", "analyzing", "thinking"]), run), run), false);
  assert.equal(readingCanViewReport(readingSteps([progress(1, "writing", "running")], run), run), false);
  for (const status of ["succeeded", "cancelled", "failed", "interrupted"]) {
    const ended = { ...run, status };
    assert.equal(readingCanViewReport(readingSteps(items, ended), ended), false);
  }
});

test("a terminated run still reports its outcome when every recorded phase completed", () => {
  for (const phases of [["reading"], ["reading", "analyzing", "thinking", "writing"]]) {
    const items = phaseSequence(phases);
    for (const [status, notice] of [["cancelled", "研读已停止"], ["failed", "研读失败"], ["interrupted", "研读已中断"]]) {
      const endedRun = { ...run, status };
      const chain = readingSteps(items, endedRun);
      assert.ok(chain.every(step => step.status === "completed"), "run termination must preserve actual completed phases");
      assert.equal(readingProgressNotice(chain, endedRun), notice);
    }
  }
});

test("initial thinking requires a real event and keeps its identity when reading starts", () => {
  for (const item of [{ type: "agent_activity", phase: "thinking" }, { type: "reasoning", text: "" }]) {
    const started = action(1, "think-1", item, "running");
    const completed = { ...started, status: "completed" };
    assert.deepEqual(readingSteps([started], run), [step("initial-thinking", "thinking", "running")]);
    assert.deepEqual(readingSteps([completed], run), [step("initial-thinking", "thinking", "completed")]);
    assert.deepEqual(readingSteps([completed, progress(2, "reading", "running")], run), [
      step("initial-thinking", "thinking", "completed"), step("reading", "reading", "running"),
    ]);
    assert.deepEqual(readingSteps([started, progress(2, "reading", "running")], run), [
      step("reading", "reading", "running"),
    ], "an incomplete startup signal cannot invent completion or block the real reading phase");
    assert.equal(readingSteps([started], { ...run, status: "succeeded" })[0].status, "interrupted");
    assert.equal(readingSteps([started], { ...run, status: "cancelled" })[0].status, "cancelled");
    assert.equal(readingSteps([started], { ...run, status: "failed" })[0].status, "failed");
  }
});

test("reported initial thinking and its internal activity share one node", () => {
  const items = [action(1, "think-1", { type: "reasoning", text: "" }),
    progress(2, "thinking", "running", "initial"),
    action(3, "think-2", { type: "agent_activity", phase: "thinking" }, "running")];
  assert.deepEqual(readingSteps(items, run), [step("initial-thinking", "thinking", "running")]);
  assert.deepEqual(readingSteps([...items, progress(4, "thinking", "completed", "initial"), progress(5, "reading", "running")], run), [
    step("initial-thinking", "thinking", "completed"), step("reading", "reading", "running"),
  ]);
});

test("internal reasoning, tool calls and report streaming cannot create main-phase nodes", () => {
  const first = action(1, "think-1", { type: "agent_activity", phase: "thinking" });
  const command = (sequence, id) => action(sequence, id, { type: "command_execution", command: "python inspect_pdf.py", status: "completed", exit_code: 0 });
  const initial = [first, command(2, "cmd-1"), command(3, "cmd-2")];
  assert.deepEqual(readingSteps(initial, run), [step("initial-thinking", "thinking", "completed")]);
  const report = action(10, "answer", { type: "agent_message", text: "partial" }, "running");
  const mixed = [...initial, progress(4, "reading", "running"), command(5, "cmd-3"),
    action(6, "think-2", { type: "agent_activity", phase: "thinking" }),
    progress(7, "reading", "completed"), progress(8, "analyzing", "running"), report];
  const chain = readingSteps(mixed, run);
  assert.deepEqual(chain.map(step => step.kind), ["thinking", "reading", "analyzing"]);
  assert.equal(chain.filter(step => step.status === "running").length, 1);
  assert.equal(chain.find(step => step.id === "reading:r1").status, "completed");
  const updated = mixed.map(item => item.id === "answer" ? { ...item, item: { ...item.item, text: "fuller output" } } : item);
  assert.deepEqual(readingSteps(updated, run), chain);
  const cancelled = readingSteps(updated, { ...run, status: "cancelled" });
  assert.deepEqual(cancelled.map(step => step.id), chain.map(step => step.id));
  assert.equal(cancelled.at(-1).status, "cancelled");
  assert.equal(cancelled[1].status, "completed");
  const serialized = JSON.parse(JSON.stringify(updated));
  assert.deepEqual(readingSteps(serialized, { ...run, status: "cancelled" }), cancelled);
  assert.deepEqual(readingSteps(mixed, { ...run, id: "new" }), []);
});

test("coalesced completed stage events remain visible when the start snapshot was replaced", () => {
  const completedOnly = [progress(4, "reading", "completed")];
  assert.deepEqual(readingSteps(completedOnly, run), [step("reading", "reading", "completed")]);
});

test("a later phase is withheld until its predecessor explicitly completes, including out-of-order snapshots", () => {
  const before = [progress(1, "reading", "completed"), progress(2, "analyzing", "running"), progress(3, "thinking", "completed")];
  assert.deepEqual(readingSteps(before, run).map(step => [step.kind, step.status]), [
    ["reading", "completed"], ["analyzing", "running"],
  ]);
  const after = [...before, progress(4, "analyzing", "completed"), progress(5, "writing", "running")];
  assert.deepEqual(readingSteps(after, run).map(step => [step.kind, step.status]), [
    ["reading", "completed"], ["analyzing", "completed"], ["thinking", "completed"], ["writing", "running"],
  ]);
  assert.deepEqual(readingSteps([...after].reverse(), run), readingSteps(after, run));
  const ended = readingSteps(before, { ...run, status: "succeeded" });
  assert.equal(ended.at(-1).status, "interrupted", "run success cannot fabricate missing phase completion");
});

test("the screenshot's repeated reasoning and completed commands do not overtake analyzing", () => {
  const items = [progress(1, "reading", "completed"), progress(3, "analyzing", "running")];
  for (let sequence = 4; sequence < 60; sequence++) items.push({
    id: `internal-${sequence}`, runId: run.id, sequence, status: "completed",
    item: sequence % 2 ? { type: "agent_activity", phase: "thinking" } : { type: "command_execution", command: "python inspect.py", status: "completed" },
  });
  assert.deepEqual(readingSteps(items, run).map(step => [step.title ?? step.kind, step.status]), [
    ["reading", "completed"], ["analyzing", "running"],
  ]);
});

test("optional initial thinking and the two reviews are distinct, all use the normal thinking label", () => {
  const kinds = ["thinking", "reading", "analyzing", "thinking", "searching", "thinking", "writing"];
  const items = kinds.map((kind, index) => progress(index, kind, index === 6 ? "running" : "completed", `step-${index}`));
  const chain = readingSteps(items, run);
  assert.equal(chain.length, 7);
  assert.deepEqual(chain.map(step => step.id), ["initial-thinking:r1", "reading:r1", "analyzing:r1", "review:r1", "searching:r1", "verification:r1", "writing:r1"]);
  assert.ok(chain.every(step => step.title === undefined));
  assert.equal(new Set(chain.map(step => step.id)).size, chain.length);
});

test("initial thinking and external research are omitted when they did not happen", () => {
  const required = ["reading", "analyzing", "thinking", "writing"];
  for (const phases of [required, ["thinking", ...required]]) {
    const chain = readingSteps(phaseSequence(phases), { ...run, status: "succeeded" });
    assert.deepEqual(chain.map(step => step.kind), phases);
    assert.equal(chain.length, phases.length);
    assert.ok(chain.every(step => step.status === "completed"));
    assert.ok(chain.every(step => step.id !== "searching:r1" && step.id !== "verification:r1"));
  }
});

test("rereading and analysis update the same review node without reopening the first reading", () => {
  const items = phaseSequence(["reading", "analyzing", "thinking"]);
  for (const [index, phase] of ["reading", "analyzing", "thinking"].entries()) {
    const current = progress(items.length + 1, phase, "running", `revisit-${index}`);
    const chain = readingSteps([...items, current], run);
    assert.deepEqual(chain.slice(0, 2), [step("reading", "reading", "completed"), step("analyzing", "analyzing", "completed")]);
    assert.deepEqual(chain.at(-1), step("review", phase, "running"));
    assert.equal(chain.length, 3);
    items.push({ ...current, item: { ...current.item, arguments: { ...current.item.arguments, status: "completed" } } });
  }
});

test("another search reuses its node and hides verification until a real review occurs", () => {
  const items = phaseSequence(["reading", "analyzing", "thinking", "searching", "thinking"]);
  const startSearch = progress(6, "searching", "running", "search-2");
  const duringSearch = readingSteps([...items, startSearch], run);
  assert.deepEqual(duringSearch.at(-1), step("searching", "searching", "running"));
  assert.equal(duringSearch.some(step => step.id.startsWith("verification") || step.status === "pending"), false);
  assert.equal(duringSearch.filter(step => step.status === "running").length, 1);
  const afterSearch = [...items, progress(6, "searching", "completed", "search-2")];
  assert.deepEqual(readingSteps(afterSearch, run).at(-1), step("searching", "searching", "completed"));
  assert.equal(readingSteps(afterSearch, run).some(step => step.id.startsWith("verification")), false);
  for (const [status, outcome] of [["cancelled", "cancelled"], ["failed", "failed"], ["interrupted", "interrupted"], ["succeeded", "interrupted"]]) {
    const ended = readingSteps([...items, startSearch], { ...run, status });
    assert.equal(ended.at(-1).status, outcome);
    assert.equal(ended.at(-1).kind, "searching");
    assert.ok(ended.slice(0, -1).every(step => step.status === "completed"));
    assert.equal(ended.some(step => step.id.startsWith("verification")), false);
  }
  assert.deepEqual(readingSteps([...afterSearch, progress(7, "thinking", "running", "verify-2")], run).at(-1), step("verification", "thinking", "running"));
  assert.deepEqual(readingSteps([...afterSearch, progress(7, "thinking", "completed", "verify-2")], run).at(-1), step("verification", "thinking", "completed"));
});

test("long research cycles stay within seven nodes and preserve the actual current action", () => {
  const items = [];
  const phases = ["thinking", "reading", "analyzing", "thinking", "searching", "thinking"];
  for (let iteration = 0; iteration < 20; iteration++) phases.push("reading", "analyzing", "thinking", "searching", "thinking");
  phases.push("writing");
  let sequence = 0;
  for (const [index, phase] of phases.entries()) {
    const stepId = `phase-${index}`;
    items.push(progress(++sequence, phase, "running", stepId));
    const running = readingSteps(items, run);
    assert.ok(running.length <= 7);
    assert.equal(new Set(running.map(step => step.id)).size, running.length);
    const active = running.filter(step => step.status === "running");
    assert.equal(active.length, 1);
    assert.equal(active[0].kind, phase);
    if (index >= 6 && ["reading", "analyzing", "thinking"].includes(phase)) assert.equal(active[0].id, "verification:r1");
    items.push(action(++sequence, `internal-${index}`, { type: "reasoning", text: "" }));
    assert.deepEqual(readingSteps(items, run), running);
    items.push(progress(++sequence, phase, "completed", stepId));
  }
  const completed = readingSteps(items, { ...run, status: "succeeded" });
  assert.equal(completed.length, 7);
  assert.ok(completed.every(step => step.status === "completed"));
  assert.deepEqual(readingSteps([...items].reverse(), { ...run, status: "succeeded" }), completed);
});

test("invalid jumps, rejected calls and stale starts never advance or reopen phases", () => {
  const complete = progress(1, "reading", "completed");
  const items = [complete, progress(2, "reading", "running"), { ...progress(3, "analyzing", "running"), item: { ...progress(3, "analyzing", "running").item, result: { success: false } } }, progress(4, "writing", "completed")];
  assert.deepEqual(readingSteps(items, run).map(step => step.kind), ["reading"]);
  assert.ok(readingSteps(items, run).every(step => step.status === "completed"));
});

test("failed phases remain failed until a confirmed retry updates the same work node", () => {
  const failed = [progress(1, "reading", "failed")];
  assert.deepEqual(readingSteps(failed, run), [step("reading", "reading", "failed")]);
  const items = [...failed, progress(2, "reading", "running", "retry-reading")];
  assert.deepEqual(readingSteps(items, run), [step("reading", "reading", "running")]);
  assert.equal(readingSteps(items, { ...run, status: "cancelled" }).at(-1).status, "cancelled");
  assert.deepEqual(readingSteps([...items, progress(3, "reading", "completed", "retry-reading")], run), [step("reading", "reading", "completed")]);
  assert.deepEqual(readingSteps([...failed, progress(2, "analyzing", "running")], run), [step("reading", "reading", "failed")]);
});

test("thinking after failed reading stays in the reading objective before its retry", async () => {
  const tools = createReadingTools(input);
  const items = [];
  const report = async (phase, status, stepId = phase) => {
    const event = progress(items.length + 1, phase, status, stepId);
    const result = await tools.call("nexiom_reading", "set_reading_stage", event.item.arguments);
    assert.equal(result.success, true, `${phase} ${status} is a valid runtime transition`);
    items.push(event);
  };
  await report("reading", "running");
  await report("reading", "failed");
  assert.deepEqual(readingSteps(items, run), [step("reading", "reading", "failed")]);
  await report("thinking", "running", "resolve-reading-failure");
  assert.deepEqual(readingSteps(items, run), [step("reading", "thinking", "running")]);
  await report("thinking", "completed", "resolve-reading-failure");
  assert.deepEqual(readingSteps(items, run), [step("reading", "thinking", "completed")]);
  await report("reading", "running", "retry-reading");
  assert.deepEqual(readingSteps(items, run), [step("reading", "reading", "running")]);
  tools.close();
});

test("research must follow review and must be reviewed before writing; offline cannot pretend search", async () => {
  for (const network of [true, false]) {
    const tools = createReadingTools({ ...input, settings: { network } });
    let id = 0;
    const start = phase => tools.call("nexiom_reading", "set_reading_stage", { phase, stepId: `step-${++id}`, status: "running" });
    const complete = phase => tools.call("nexiom_reading", "set_reading_stage", { phase, stepId: `step-${id}`, status: "completed" });
    assert.equal((await start("writing")).success, false);
    assert.equal((await start("searching")).success, false);
    for (const phase of ["thinking", "reading", "analyzing", "thinking"]) {
      assert.equal((await start(phase)).success, true);
      assert.equal((await complete(phase)).success, true);
    }
    assert.equal((await start("searching")).success, network);
    if (network) {
      assert.equal((await complete("searching")).success, true);
      assert.equal((await start("writing")).success, false);
      assert.equal((await start("thinking")).success, true);
      assert.equal((await complete("thinking")).success, true);
    }
    assert.equal((await start("writing")).success, true);
    assert.equal((await complete("writing")).success, true);
    assert.equal((await start("reading")).success, false);
  }
});

test("reading report prohibits modeling advice and does not require wide evidence tables", () => {
  assert.match(readingReportStructure, /严禁输出可行路线、建模建议/);
  assert.doesNotMatch(readingReportStructure, /### 可行路线|按推荐顺序列出路线|列固定为/);
  assert.match(readingReportStructure, /长篇证据与解释不用表格/);
  assert.match(readingWorkflowInstructions, /旧报告包含这些内容，更新报告时也须移除/);
});

test("wide narrative tables become prose without losing links, equations or short comparison tables", () => {
  const text = value => ({ type: "text", value });
  const cell = (...children) => ({ type: "tableCell", children });
  const row = (...children) => ({ type: "tableRow", children });
  const link = { type: "link", url: "https://example.org/source", children: [text("原文")] };
  const math = { type: "inlineMath", value: "a/b" };
  const table = { type: "table", children: [row(...["词", "来源", "定义", "依据", "待确认"].map(value => cell(text(value)))), row(cell(text("术语")), cell(link), cell(math), cell(text("需要对照原文核验的长段解释。".repeat(12))), cell(text("边界")))] };
  const compact = { type: "table", children: [row(cell(text("量")), cell(text("单位"))), row(cell(text("能量")), cell(text("kWh")))] };
  const tree = { type: "root", children: [table, compact] };
  readingProseTables()(tree);
  assert.equal(tree.children[0].type, "heading");
  assert.equal(tree.children.at(-1), compact);
  assert.ok(tree.children.some(node => node.children?.includes(link)));
  assert.ok(tree.children.some(node => node.children?.includes(math)));
});
test("workflow covers key terminology, source verification, leakage, dependencies and human choice", () => {
  for (const text of ["背景知识", "国家/行业标准", "DOI/URL", "测试期数据", "单程还是往返效率", "继承、修改、不适用、待核实", "人工纠偏", "共同讨论", "不能假定当前赛题就是某届C题", "不能提前一次性打完全部阶段标记", "同一时刻只推进一个主阶段", "不要为这些内部事件反复创建节点"])
    assert.ok(readingWorkflowInstructions.includes(text), text);
});

test("completed reading discussion rejects stage tools and does not replace the report", async () => {
  const legacy = READING_CORRECTION_MARKER + "\n\n【目标板块】\nID: question-1\n标题: 问题一\n\n【人工纠偏】\n效率应按单程理解\n\n【更新要求】\n重新输出完整报告";
  assert.deepEqual(parseReadingDiscussion(legacy), { id: "question-1", title: "问题一", opinion: "效率应按单程理解" });
  const prompt = buildReadingDiscussionPrompt("这里不该写成往返效率", {
    id: "terms",
    title: "名词、符号与数据口径",
    body: "正文里出现【人工意见】和【讨论要求】也不该截断。往返效率尚未证实。",
  });
  assert.match(prompt, /【人工意见】/);
  assert.match(prompt, /往返效率尚未证实/);
  assert.equal(parseReadingDiscussion(prompt)?.opinion, "这里不该写成往返效率");
  assert.doesNotMatch(prompt, /重新输出完整报告|沿用研读阶段顺序|set_reading_stage/);
  const wrapped = "请直接完成任务并验证结果。\n\n" + prompt;
  const tools = createReadingTools({ ...input, prompt: wrapped });
  const rejected = await tools.call("nexiom_reading", "set_reading_stage", { phase: "thinking", status: "running", stepId: "again" });
  assert.equal(rejected.success, false);
  assert.match(rejected.contentItems[0].text, /不能上报或重开研读阶段/);
  assert.match(prompt, /打招呼/);
  assert.match(prompt, /不要复述、改写、总结或分析当前内容/);
  assert.match(readingDiscussionInstructions, /禁止调用 nexiom_reading\.set_reading_stage/);
  assert.match(readingDiscussionInstructions, /禁止重新输出整份赛题研读报告/);
  assert.match(readingDiscussionInstructions, /不要把寒暄展开成题面分析/);
  assert.match(readingDeveloperInstructions(wrapped, true), /禁止调用 nexiom_reading\.set_reading_stage/);
  assert.doesNotMatch(readingDeveloperInstructions(wrapped, true), /文献联网检索/);
  assert.match(readingDeveloperInstructions("正式研读", true), /每段实际工作开始前调用 nexiom_reading\.set_reading_stage/);
  assert.match(readingWorkflowInstructions, /不得借纠偏重开阶段/);
  assert.doesNotMatch(readingWorkflowInstructions, /每轮人工纠偏也先核对/);
  const messages = [
    { sequence: 1, role: "user", text: "[NEXIOM赛题研读任务]" },
    { sequence: 5, role: "user", text: prompt },
    { sequence: 9, role: "assistant", text: "# 赛题研读报告\n## 赛题概览\n讨论不该替换报告" },
    { sequence: 12, role: "user", text: "[NEXIOM赛题研读任务]\n重新研读" },
  ];
  const bounds = readingDiscussionBounds(messages, 1);
  assert.deepEqual(bounds, [{ start: 5, end: 12 }]);
  assert.equal(isReadingDiscussionSequence(9, bounds), true);
  assert.equal(isReadingDiscussionSequence(13, bounds), false);
  assert.equal(latestReadingTurnIsDiscussion(messages, 1), false);
  assert.equal(latestReadingTurnIsDiscussion(messages.slice(0, 3), 1), true);
  const formal = { id: "formal", createdAt: "2026-09-22T00:00:00.000Z", status: "succeeded" };
  const discussion = { id: "discussion", createdAt: "2026-09-22T00:10:00.000Z", status: "succeeded" };
  const accepted = { id: "stage", runId: "formal", sequence: 2, status: "completed", item: { type: "native_tool_call", namespace: "nexiom_reading", tool: "set_reading_stage", status: "completed", arguments: { stepId: "read", phase: "reading", status: "completed" } } };
  const denied = { id: "denied", runId: "discussion", sequence: 8, status: "completed", item: { type: "native_tool_call", namespace: "nexiom_reading", tool: "set_reading_stage", status: "completed", arguments: { stepId: "again", phase: "thinking", status: "running" }, error: { message: "不能重开" } } };
  assert.equal(latestFormalReadingRun([discussion, formal], [accepted, denied])?.id, "formal");
});
