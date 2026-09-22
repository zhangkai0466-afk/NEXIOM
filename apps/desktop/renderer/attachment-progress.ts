import type { AgentItem, Message, Run } from "../../../packages/contracts";
import { ATTACHMENT_PHASES, ATTACHMENT_TASK_MARKER, attachmentTargets, parseAttachmentStage, parseAttachmentReports, type AttachmentPhase, type AttachmentTarget, type AttachmentReport } from "../../../packages/contracts/attachment-workflow";
import { getAgentItemOutcome, type AgentTaskOutcome } from "./agent-task-state";

export { parseAttachmentReports } from "../../../packages/contracts/attachment-workflow";
export interface AttachmentStep { phase: AttachmentPhase; status: AgentTaskOutcome | "pending" }
export interface AttachmentAnalysis {
  target: AttachmentTarget;
  steps: AttachmentStep[];
  status: AgentTaskOutcome | "pending";
  report?: AttachmentReport;
  runId?: string;
  records: AgentItem[];
}

function accepted(record: AgentItem) {
  return record.item.type === "native_tool_call" && getAgentItemOutcome(record) === "completed" &&
    (record.item.result as { accepted?: boolean } | undefined)?.accepted === true;
}

export function attachmentAnalysis(messages: Message[], items: AgentItem[], runs: Run[]): AttachmentAnalysis[] {
  const start = messages.filter(message => message.role === "user" && message.text.startsWith(ATTACHMENT_TASK_MARKER))
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (!start) return [];
  const targets = attachmentTargets(start.text);
  const records = items.filter(record => record.sequence > start.sequence).sort((a, b) => a.sequence - b.sequence);
  const structuredRuns = new Set(records.filter(record => record.item.type === "native_tool_call" &&
    record.item.namespace === "nexiom_attachments" && record.item.tool === "begin_attachment").map(record => record.runId));
  const reports = new Map<string, AttachmentReport>();
  // Only finished legacy outputs with an explicit attachment heading qualify.
  // Progress messages and errors must never become a one-file report.
  const legacy = [
    ...messages.filter(message => message.sequence > start.sequence && message.role === "assistant" && message.kind === "answer")
      .map(message => ({ sequence: message.sequence, text: message.text })),
    ...records.flatMap(record => !structuredRuns.has(record.runId) && record.item.type === "agent_message" && record.status === "completed" &&
      runs.find(run => run.id === record.runId)?.status !== "running"
      ? [{ sequence: record.sequence, text: record.item.text }] : []),
  ].sort((a, b) => a.sequence - b.sequence);
  for (const candidate of legacy) for (const report of parseAttachmentReports(candidate.text)) reports.set(report.id, report);

  return targets.map(target => {
    const assignments = records.filter(record => record.item.type === "native_tool_call" &&
      record.item.namespace === "nexiom_attachments" && record.item.tool === "begin_attachment" && accepted(record) &&
      (record.item.arguments as Record<string, unknown>)?.attachmentId === target.id &&
      (record.item.arguments as Record<string, unknown>)?.path === target.path);
    const assignment = assignments.at(-1);
    const attempt = assignment ? records.filter(record => record.runId === assignment.runId && record.sequence > assignment.sequence &&
      record.item.id.startsWith(target.id + ":")) : [];
    let report = reports.get(target.id);
    // A later failed attempt keeps the previous report until a replacement arrives.
    for (const record of records) {
      if (record.item.type !== "native_tool_call" || record.item.namespace !== "nexiom_attachments" ||
          record.item.tool !== "publish_attachment_report" || !accepted(record)) continue;
      const data = record.item.arguments as Record<string, unknown>;
      if (data?.attachmentId === target.id && typeof data.body === "string" && data.body.trim())
        report = { id: target.id, title: target.name, body: data.body.trim() };
    }
    const steps: AttachmentStep[] = ATTACHMENT_PHASES.map(phase => ({ phase, status: "pending" }));
    for (const record of attempt) {
      if (record.item.type !== "native_tool_call" || record.item.namespace !== "nexiom_attachments" ||
          record.item.tool !== "set_attachment_stage" || !accepted(record)) continue;
      const stage = parseAttachmentStage(record.item.arguments);
      if (!stage || stage.attachmentId !== target.id) continue;
      const index = ATTACHMENT_PHASES.indexOf(stage.phase);
      if (steps.slice(0, index).some(step => step.status !== "completed")) continue;
      const prior = steps[index].status;
      if (prior === "completed" || stage.status !== "running" && prior !== "running") continue;
      steps[index].status = stage.status;
    }
    const run = runs.find(run => run.id === assignment?.runId);
    const publishedInAttempt = attempt.some(record => record.item.type === "native_tool_call" &&
      record.item.namespace === "nexiom_attachments" && record.item.tool === "publish_attachment_report" && accepted(record) &&
      (record.item.arguments as Record<string, unknown>)?.attachmentId === target.id);
    const complete = steps.every(step => step.status === "completed") && publishedInAttempt && !!report;
    let status: AttachmentAnalysis["status"] = complete || !assignment && report ? "completed" : assignment ? "running" : "pending";
    if (assignment && !complete && run?.status !== "running") {
      status = run?.status && run.status !== "succeeded" ? run.status : "interrupted";
      const unfinished = steps.find(step => step.status === "running" || step.status === "failed") ?? steps.find(step => step.status === "pending");
      if (unfinished) unfinished.status = status;
    } else if (steps.some(step => step.status === "failed")) status = "failed";
    return { target, steps, status, report, runId: assignment?.runId, records: attempt };
  });
}
