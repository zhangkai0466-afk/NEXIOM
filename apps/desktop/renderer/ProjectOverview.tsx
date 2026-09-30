import { useEffect, useState, type CSSProperties } from "react";
import { ArrowUpRight } from "lucide-react";
import type { Project, Snapshot } from "../../../packages/contracts";
import type { WorkflowState } from "../../../packages/contracts/workflow";
import { ProjectStageIndicator, ProjectStageResult } from "./ProjectStageIndicator";
import { AGENT_TASK_STATES, getCurrentAgentTaskKind } from "./agent-task-state";
import { projectStageStates, runLabels, type OverviewStage } from "./project-status";
import "./project-overview.css";
import { WorkspaceHeading } from "./WorkspaceHeading";

function duration(created: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时 ${Math.floor(seconds % 3600 / 60)}分` : seconds >= 60 ? `${Math.floor(seconds / 60)}分 ${seconds % 60}秒` : `${seconds}秒`;
}
export function ProjectOverview({ project, snapshot, workflow, onNavigate }: {
  project: Project; snapshot: Snapshot; workflow?: WorkflowState; onNavigate: (stage: OverviewStage, threadId?: string) => void;
}) {
  const stages = projectStageStates(snapshot, project.id);
  const activeCount = stages.reduce((sum, stage) => sum + stage.activeCount, 0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!activeCount) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [activeCount]);
  const confirmed = workflow?.questions.filter(q => q.selected).length ?? 0;
  const total = workflow?.questions.length ?? 0;
  const allConfirmed = total > 0 && confirmed === total;
  return <div className="project-monitor">
    <header className="project-monitor-header"><WorkspaceHeading dimension="overview" projectName={project.name} title="项目总览"/><span className="project-monitor-live" data-active={!!activeCount}><i />{activeCount ? `${activeCount} 项任务运行中` : "当前无运行任务"}</span></header>
    <div className="project-stage-grid" aria-label="各环节实时工作状态">
      {stages.map(stage => {
        const kind = stage.run?.status === "running" ? getCurrentAgentTaskKind(snapshot.items, stage.run.id) : undefined;
        const label = kind ? AGENT_TASK_STATES[kind].label : stage.run ? runLabels[stage.run.status] : "未开始";
        return <button key={stage.id} className="project-stage-card" data-status={stage.status} style={{ "--stage-color": kind ? AGENT_TASK_STATES[kind].color : `var(--dimension-${stage.id})` } as CSSProperties} onClick={() => onNavigate(stage.id, stage.thread?.id)} aria-label={`${stage.label}：${label}`}>
          <span className="project-stage-top"><ProjectStageIndicator stage={stage.id} status={stage.status} kind={kind}/><ArrowUpRight size={16}/></span>
          <strong>{stage.label}</strong><span className="project-stage-status"><ProjectStageResult status={stage.status}/>{label}{stage.activeCount > 1 && ` · ${stage.activeCount} 项`}</span>
          <span className="project-stage-detail">{stage.thread?.questionId ? `${snapshot.questions.find(q => q.id === stage.thread!.questionId)?.name ?? ""} · ` : ""}{stage.run?.status === "running" ? `已运行 ${duration(stage.run.createdAt, now)}` : stage.run ? new Date(stage.run.finishedAt ?? stage.run.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "暂无任务记录"}</span>
        </button>;
      })}
      <button className="project-stage-card" data-status={allConfirmed ? "succeeded" : "idle"} style={{ "--stage-color": "var(--dimension-overview)" } as CSSProperties} onClick={() => { const details = document.getElementById("project-final-models") as HTMLDetailsElement | null; if (details) { details.open = true; details.scrollIntoView({ behavior: document.documentElement.dataset.reduceMotion === "true" ? "instant" : "smooth", block: "start" }); } }} aria-label="查看最终模型确认">
        <span className="project-stage-top"><ProjectStageIndicator stage="final" status={allConfirmed ? "succeeded" : "idle"}/><ArrowUpRight size={16}/></span><strong>最终模型</strong><span className="project-stage-status"><ProjectStageResult status={allConfirmed ? "succeeded" : "idle"}/>{allConfirmed ? "全部已确认" : total ? "待确认" : "等待分问"}</span><span className="project-stage-detail">{total ? `${confirmed} / ${total} 问已确认` : "研读后自动生成"}</span>
      </button>
    </div>
  </div>;
}
