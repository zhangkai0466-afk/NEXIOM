import { useEffect, useState } from "react";
import type { AgentItem, Run } from "../../../packages/contracts";
import { AgentTaskStatus } from "./AgentTaskStatus";
import { getCurrentAgentTaskKind } from "./agent-task-state";

export function AgentActivity({
  run,
  items,
  paused,
  casual = false,
}: {
  run: Run;
  items: AgentItem[];
  paused: boolean;
  casual?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () =>
      setElapsed(
        Math.max(
          0,
          Math.floor(((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.createdAt)) / 1000),
        ),
      );
    update();
    if (run.status !== "running") return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [run.id, run.createdAt, run.finishedAt, run.status]);
  const kind = casual ? "thinking" : getCurrentAgentTaskKind(items, run.id, run.mode === "plan" ? "planning" : "thinking");
  const status = run.status === "succeeded" ? "completed" : run.status;
  return (
    <div className="working-indicator" role="status">
      <AgentTaskStatus
        kind={kind}
        status={status}
        paused={paused}
        compact
        final={status === "completed"}
        label={status === "completed" ? "已完成" : undefined}
      />
      <span className="activity-time" role="timer" aria-live="off">
        {status !== "running" && "· 耗时 "}
        {!casual && elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ` : ""}
        {casual ? elapsed : elapsed % 60} 秒
      </span>
    </div>
  );
}
