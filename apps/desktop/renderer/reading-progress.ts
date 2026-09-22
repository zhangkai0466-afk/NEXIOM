import type { AgentItem, Run } from "../../../packages/contracts";
import { nextReadingPhases, parseReadingProgress, type ReadingProgress } from "../../../packages/contracts/reading-workflow";
import { getAgentItemOutcome, type AgentTaskKind, type AgentTaskOutcome } from "./agent-task-state";

export interface ReadingStep { id: string; kind: AgentTaskKind; status: AgentTaskOutcome }

// Work objectives, not individual calls. Retries and revisits update these
// bounded slots; the complete event history remains in the run.
const slots = ["initial-thinking", "reading", "analyzing", "review", "searching", "verification", "writing"] as const;
type Slot = typeof slots[number];

export function readingSteps(items: AgentItem[], run: Run): ReadingStep[] {
  const records = items.filter(record => record.runId === run.id).sort((a, b) => a.sequence - b.sequence);
  const stages = new Map<string, ReadingProgress>();
  for (const record of records) {
    const item = record.item;
    // Main phases and their internal tools/reasoning are different levels.
    // Only accepted phase reports belong in this serial workflow.
    if (item.type !== "native_tool_call" || item.namespace !== "nexiom_reading" || item.tool !== "set_reading_stage" ||
        getAgentItemOutcome(record) !== "completed") continue;
    const progress = parseReadingProgress(item.arguments);
    if (!progress) continue;
    const previous = stages.get(progress.stepId);
    // A durable snapshot may contain only completion. Keep its phase identity,
    // but never let a stale start or conflicting callback reopen it.
    if (!previous || previous.phase === progress.phase && previous.status === "running")
      stages.set(progress.stepId, progress);
  }

  const visible = new Map<Slot, ReadingStep>();
  const completed: ReadingProgress[] = [];
  let searched = false;
  let readingStarted = false;
  for (const stage of stages.values()) {
    // Also guard old/imported or partially delivered snapshots in the renderer.
    // A later completion is not proof that an earlier running phase finished.
    if (!nextReadingPhases(completed, true).includes(stage.phase)) break;
    const hasRead = completed.some(step => step.phase === "reading");
    const hasAnalyzed = completed.some(step => step.phase === "analyzing");
    let slot: Slot;
    if (stage.phase === "thinking" && !hasRead) slot = readingStarted ? "reading" : "initial-thinking";
    else if (stage.phase === "reading" && !hasRead) slot = "reading";
    else if (stage.phase === "analyzing" && !hasAnalyzed) slot = "analyzing";
    else if (stage.phase === "writing") slot = "writing";
    else if (stage.phase === "searching") { slot = "searching"; searched = true; }
    else slot = searched ? "verification" : "review";
    if (stage.phase === "reading") readingStarted = true;

    // A new search is the current action. Hide the previous review until this
    // pass reports its own thinking; do not invent a pending step.
    if (slot === "searching") visible.delete("verification");
    visible.set(slot, { id: `${slot}:${run.id}`, kind: stage.phase, status: stage.status });
    if (stage.status === "running") break;
    if (stage.status === "completed") completed.push(stage);
  }

  if (!visible.has("initial-thinking")) {
    // Native thinking is evidence only before actual work begins. Later
    // reasoning belongs inside the current objective, never a new node.
    let initial: AgentItem | undefined;
    for (const record of records) {
      if (record.item.type === "reasoning" || record.item.type === "agent_activity" && record.item.phase === "thinking") initial = record;
      else if (record.item.type !== "todo_list") break;
    }
    if (initial) {
      const status = getAgentItemOutcome(initial);
      // A missing completion cannot become a green check just because reading
      // started. Explicit phase reports supersede an unfinished startup signal.
      if (!visible.size || status !== "running")
        visible.set("initial-thinking", { id: `initial-thinking:${run.id}`, kind: "thinking", status });
    }
  }

  const result = slots.flatMap(slot => visible.has(slot) ? [visible.get(slot)!] : []);
  if (run.status !== "running") {
    for (const step of result) {
      if (step.status === "running")
        step.status = run.status === "succeeded" ? "interrupted" : run.status;
    }
  }
  return result;
}

export function readingCanViewReport(steps: ReadingStep[], run: Run) {
  return run.status === "running" && steps.some(step => step.kind === "writing" && step.status === "completed");
}

export function readingProgressNotice(steps: ReadingStep[], run: Run): string | undefined {
  if (run.status === "failed") return "研读失败";
  if (run.status === "cancelled") return "研读已停止";
  if (run.status === "interrupted") return "研读已中断";
  if (!steps.length) {
    if (run.status === "running") return "等待模型报告研读阶段…";
    return "研读已结束，未记录详细阶段";
  }
  // Keep the chain in place between phase reports; a reporting gap is not a
  // separate waiting phase. The next real action connects to the same chain.
  if (run.status === "succeeded" && (steps.at(-1)?.kind !== "writing" || steps.some(step => step.status !== "completed")))
    return "研读已结束，部分阶段记录不完整";
}

export function latestFormalReadingRun<T extends { id: string; createdAt: string }>(runs: T[], items: AgentItem[]): T | undefined {
  const formalIds = new Set(items.flatMap(record => {
    const item = record.item;
    return item.type === "native_tool_call" && item.namespace === "nexiom_reading" && item.tool === "set_reading_stage" && getAgentItemOutcome(record) === "completed"
      ? [record.runId]
      : [];
  }));
  return [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).reverse().find(run => formalIds.has(run.id));
}
