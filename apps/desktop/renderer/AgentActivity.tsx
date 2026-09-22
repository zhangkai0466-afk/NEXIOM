import { useEffect, useState } from "react";
import type { AgentItem, Run } from "../../../packages/contracts";
import { AgentTaskStatus } from "./AgentTaskStatus";
import { getCurrentAgentTaskKind, type AgentTaskKind } from "./agent-task-state";

export function AgentActivity({
  run,
  items,
  paused,
  casual = false,
  kind: kindOverride,
  settled = false,
  ruled = false,
}: {
  run: Run;
  items: AgentItem[];
  paused: boolean;
  casual?: boolean;
  kind?: AgentTaskKind;
  settled?: boolean;
  ruled?: boolean;
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
    if (run.status !== "running" || settled) return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [run.id, run.createdAt, run.finishedAt, run.status, settled]);
  const live = run.status === "running" && !settled;
  const kind = live ? kindOverride ?? getCurrentAgentTaskKind(items, run.id, "thinking") : "writing";
  const status = run.status === "succeeded" || (settled && run.status === "running")
    ? "completed"
    : run.status === "running"
      ? "running"
      : run.status;
  return (
    <div className={`working-indicator${ruled ? " ruled" : ""}`} role="status">
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
