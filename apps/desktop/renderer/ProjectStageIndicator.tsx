import { Boxes, CircleCheckBig, CirclePause, CircleX, OctagonX } from "lucide-react";
import type { Run } from "../../../packages/contracts";
import { dimensions } from "./ModelingSidebar";
import { ThinkingPixelTrail } from "./ThinkingPixelTrail";
import type { OverviewStage } from "./project-status";
import { AGENT_TASK_STATES, type AgentTaskKind } from "./agent-task-state";

export function ProjectStageIndicator({ stage, status, kind = "thinking" }: {
  stage: OverviewStage | "final";
  status: Run["status"] | "idle";
  kind?: AgentTaskKind;
}) {
  const Icon = stage === "final" ? Boxes : dimensions.find(item => item.id === stage)!.icon;
  return <span className="project-stage-indicator" data-status={status} aria-hidden="true">
    {status === "running" ? <ThinkingPixelTrail size={27} color={AGENT_TASK_STATES[kind].color}/> : <Icon size={28}/>}
  </span>;
}

export function ProjectStageResult({ status }: { status: Run["status"] | "idle" }) {
  const Icon = status === "succeeded" ? CircleCheckBig : status === "failed" ? CircleX
    : status === "cancelled" ? OctagonX : status === "interrupted" ? CirclePause : null;
  return Icon ? <Icon size={14} aria-hidden="true"/> : null;
}
