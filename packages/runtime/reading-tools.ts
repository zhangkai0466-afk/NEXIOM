import type { AgentInput } from "./index";
import type { NativeToolRegistry } from "./visual-design";
import { isReadingDiscussionPrompt, nextReadingPhases, parseReadingProgress, type ReadingProgress } from "../contracts/reading-workflow";

export function readingWebSearchMode(input: Pick<AgentInput, "stageId" | "settings">): "live" | "disabled" {
  return input.stageId === "reading" && input.settings.network ? "live" : "disabled";
}

export function createReadingTools(input: AgentInput): NativeToolRegistry | undefined {
  if (input.stageId !== "reading") return;
  const steps = new Map<string, ReadingProgress>();
  let closed = false;
  return {
    specs: [{ type: "namespace", name: "nexiom_reading", description: "赛题研读实际工作阶段。只记录状态，不接收内部推理。", tools: [{
      type: "function", name: "set_reading_stage", description: "开始、完成或失败一段有明确目标的研读工作。顺序为思考（可选，仅理解任务与选择读取方式）→阅读原题→分析→思考复核→检索（按需）→思考核验→编写；首个实质工作是完整阅读，无需检索可从复核进入编写。分批读文件、逐问分析、内部思考、多次搜索、多来源阅读和局部回看都在所属阶段内完成，不按工具次数拆分。达到工作完成条件才结束，工具返回不代表阶段完成；未发生阶段不补。实际目标切换才报新阶段，真实回访、失败重试使用新 stepId；真实重读仍经阅读→分析→思考，检索后仍须思考核验。界面汇总为最多 7 个节点，不限制实际工作次数。完成前必须先开始，同一时刻只记录一个主阶段。",
      inputSchema: { type: "object", properties: {
        stepId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" },
        phase: { type: "string", enum: ["thinking", "reading", "analyzing", "searching", "writing"] },
        status: { type: "string", enum: ["running", "completed", "failed"] },
      }, required: ["stepId", "phase", "status"], additionalProperties: false }, deferLoading: false,
    }] }],
    close() { closed = true; },
    async call(namespace, tool, args) {
      const progress = parseReadingProgress(args);
      let error = "";
      if (isReadingDiscussionPrompt(input.prompt)) error = "当前是研读完成后的讨论，不能上报或重开研读阶段。不要再次调用本工具，请直接用文字回应。";
      else if (closed || input.signal.aborted) error = "研读任务已停止。";
      else if (namespace !== "nexiom_reading" || tool !== "set_reading_stage" || !progress) error = "无效的研读阶段事件。";
      else {
        const prior = steps.get(progress.stepId);
        if (prior && (prior.phase !== progress.phase || prior.status !== "running")) error = "已结束阶段不能重写；重新研读请使用新 stepId。";
        else if (!prior && progress.status !== "running") error = "阶段尚未开始，不能标记为完成或失败。";
        else if (progress.status === "running" && [...steps.values()].some(step => step.stepId !== progress.stepId && step.status === "running")) error = "请先结束当前阶段，再开始下一阶段。";
        else if (progress.status === "running" && !prior) {
          const history = [...steps.values()];
          const allowed = nextReadingPhases(history.filter(step => step.status === "completed"), input.settings.network);
          if (!allowed.includes(progress.phase)) error = `当前不能进入 ${progress.phase}；下一阶段应为 ${allowed.join("、") || "结束研读"}。请遵守阅读、分析、思考核验后才编写的流程。`;
          else steps.set(progress.stepId, progress);
        } else steps.set(progress.stepId, progress);
      }
      return { success: !error, contentItems: [{ type: "inputText", text: error || JSON.stringify({ accepted: true, ...progress }) }] };
    },
  };
}
