import type { CSSProperties, ReactNode } from "react";
import { Check, CircleCheckBig, CirclePause, CircleX, OctagonX } from "lucide-react";
import { ThinkingPixelTrail } from "./ThinkingPixelTrail";
import { AGENT_TASK_STATES, type AgentTaskKind, type AgentTaskOutcome } from "./agent-task-state";
import "./agent-task-status.css";

const outcomeLabels: Record<Exclude<AgentTaskOutcome, "running">, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};

export function AgentTaskIcon({
  kind = "thinking",
  status = "running",
  size = 32,
  paused = false,
  final = false,
}: {
  kind?: AgentTaskKind;
  status?: AgentTaskOutcome;
  size?: number;
  paused?: boolean;
  final?: boolean;
}) {
  const EndIcon = status === "failed" ? CircleX : status === "cancelled" ? OctagonX : CirclePause;
  return (
    <span
      className={`nexiom-task-icon${final ? " nexiom-task-icon-final" : ""}`}
      data-task-kind={kind}
      data-task-status={status}
      data-paused={paused}
      style={{ "--nexiom-task-icon-size": `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="nexiom-task-icon-pixels">
        <ThinkingPixelTrail color={AGENT_TASK_STATES[kind].color} size={size} paused={paused || status !== "running"} />
      </span>
      <span className="nexiom-task-icon-result">
        {status === "running" || status === "completed" ? (
          final ? <span className="nexiom-task-final-check"><Check size={size * 0.65} strokeWidth={2.5} /></span> : <CircleCheckBig size={size} strokeWidth={1.7} />
        ) : <EndIcon size={size} strokeWidth={1.7} />}
      </span>
    </span>
  );
}

export function AgentTaskLabel({
  kind = "thinking",
  status = "running",
  paused = false,
  children,
  className = "",
}: {
  kind?: AgentTaskKind;
  status?: AgentTaskOutcome;
  paused?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const label = children ?? (status === "running" ? AGENT_TASK_STATES[kind].label : outcomeLabels[status]);
  return (
    <span
      className={`nexiom-task-label ${className}`.trim()}
      data-task-kind={kind}
      data-task-status={status}
      data-paused={paused}
      data-label={typeof label === "string" || typeof label === "number" ? String(label) : undefined}
    >
      {label}
    </span>
  );
}

export function AgentTaskStatus({
  kind = "thinking",
  status = "running",
  compact = false,
  paused = false,
  label,
  final = false,
  className = "",
}: {
  kind?: AgentTaskKind;
  status?: AgentTaskOutcome;
  compact?: boolean;
  paused?: boolean;
  label?: ReactNode;
  final?: boolean;
  className?: string;
}) {
  return (
    <span className={`nexiom-task-status${compact ? " nexiom-task-status-compact" : ""} ${className}`.trim()} data-task-status={status}>
      <AgentTaskIcon kind={kind} status={status} size={compact ? 17 : 32} paused={paused} final={final} />
      <AgentTaskLabel kind={kind} status={status} paused={paused}>{label}</AgentTaskLabel>
    </span>
  );
}
