import type { Snapshot, Run, ThreadStage } from "../../../packages/contracts";

export const overviewStages = [
  { id: "reading", label: "赛题研读" }, { id: "attachments", label: "附件分析" },
  { id: "model", label: "开始建模" }, { id: "validation", label: "模型检验" },
  { id: "chart", label: "图表设计" }, { id: "paper", label: "论文写作" },
  { id: "delivery", label: "检查交付" },
] as const satisfies readonly { id: ThreadStage; label: string }[];
export type OverviewStage = typeof overviewStages[number]["id"];
export const runLabels: Record<Run["status"], string> = { running: "运行中", succeeded: "最近任务完成", failed: "任务失败", cancelled: "已停止", interrupted: "已中断" };
export function projectStageStates(snapshot: Pick<Snapshot, "threads" | "runs">, projectId: string) {
  const threads = new Map(snapshot.threads.filter(t => t.projectId === projectId).map(t => [t.id, t]));
  return overviewStages.map(stage => {
    const runs = snapshot.runs.filter(r => r.projectId === projectId && threads.get(r.threadId)?.stageId === stage.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const active = runs.filter(r => r.status === "running");
    const run = active[0] ?? runs[0];
    return { ...stage, run, activeCount: active.length, count: runs.length, thread: run ? threads.get(run.threadId) : undefined, status: run?.status ?? "idle" as const };
  });
}
