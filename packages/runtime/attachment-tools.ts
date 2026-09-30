import type { AgentInput } from "./index";
import type { NativeToolRegistry } from "./visual-design";
import { writeWorkflowFile } from "../core/workflow";
import { ATTACHMENT_PHASES, parseAttachmentStage, type AttachmentPhase } from "../contracts/attachment-workflow";

export function createAttachmentTools(input: AgentInput): NativeToolRegistry | undefined {
  if (input.stageId !== "attachments" || !input.attachmentTarget) return;
  const target = input.attachmentTarget;
  let index = 0;
  let active: AttachmentPhase | undefined;
  let published = false;
  let closed = false;
  return {
    specs: [{ type: "namespace", name: "nexiom_attachments", description: "当前附件的四阶段进度和独立报告。", tools: [
      { type: "function", name: "set_attachment_stage", description: "开始或结束当前附件的阅读、分析、思考、输出阶段。内部命令及复核不拆成新阶段。", inputSchema: {
        type: "object", properties: {
          attachmentId: { type: "string", enum: [target.id] },
          phase: { type: "string", enum: [...ATTACHMENT_PHASES] },
          status: { type: "string", enum: ["running", "completed", "failed"] },
        }, required: ["attachmentId", "phase", "status"], additionalProperties: false,
      }, deferLoading: false },
      { type: "function", name: "publish_attachment_report", description: "在输出阶段保存当前附件的完整报告正文。保存成功后才结束输出阶段。", inputSchema: {
        type: "object", properties: {
          attachmentId: { type: "string", enum: [target.id] },
          body: { type: "string", description: "完整独立报告，正文从 ### 文件概况 开始，保留证据和未核实项。", minLength: 1, maxLength: 120000 },
        }, required: ["attachmentId", "body"], additionalProperties: false,
      }, deferLoading: false },
    ] }],
    close() { closed = true; },
    async call(namespace, tool, args) {
      const data = args && typeof args === "object" ? args as Record<string, unknown> : {};
      let error = "";
      if (closed || input.signal.aborted) error = "附件任务已停止。";
      else if (namespace !== "nexiom_attachments" || data.attachmentId !== target.id) error = "只能更新当前目标附件。";
      else if (tool === "publish_attachment_report") {
        if (active !== "writing") error = "请完成阅读、分析、思考并开始输出，再保存报告。";
        else if (typeof data.body !== "string" || !data.body.trim() || data.body.length > 120000) error = "报告正文为空或超过长度限制。";
        else {
          try { writeWorkflowFile(input.cwd, `attachments/reports/${target.id}.md`, `# ${target.name}\n\n来源：${target.path}\n\n${data.body}`); published = true; }
          catch (failure) { error = `报告保存失败：${(failure as Error).message}`; }
        }
      } else if (tool === "set_attachment_stage") {
        const stage = parseAttachmentStage(args);
        if (!stage || stage.phase !== ATTACHMENT_PHASES[index]) error = `当前应推进 ${ATTACHMENT_PHASES[index] ?? "任务结束"}，不能跳过阶段。`;
        else if (stage.status === "running") active = stage.phase;
        else if (active !== stage.phase) error = "请先开始当前阶段，再报告结果。";
        else if (stage.status === "completed" && stage.phase === "writing" && !published) error = "请先保存当前附件报告，再完成输出。";
        else {
          active = undefined;
          if (stage.status === "completed") index++;
        }
      } else error = "未知的附件工具。";
      return { success: !error, contentItems: [{ type: "inputText", text: error || JSON.stringify({ accepted: true, attachmentId: target.id }) }] };
    },
  };
}
