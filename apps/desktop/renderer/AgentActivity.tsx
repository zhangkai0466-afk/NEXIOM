import { useEffect, useState } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import type { AgentItem, Run } from "../../../packages/contracts";

export function AgentActivity({
  run,
  items,
  paused,
}: {
  run: Run;
  items: AgentItem[];
  paused: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () =>
      setElapsed(
        Math.max(
          0,
          Math.floor((Date.now() - Date.parse(run.createdAt)) / 1000),
        ),
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [run.id, run.createdAt]);
  const current = items
    .filter((item) => item.runId === run.id && item.status === "running")
    .at(-1)?.item;
  let state: OrbState = "working";
  let label = "正在分析";
  if (current?.type === "agent_message") {
    state = "composing";
    label = "正在输出";
  } else if (current?.type === "command_execution") {
    state = "solving";
    label = "正在运行";
  } else if (current?.type === "file_change") {
    state = "weaving";
    label = "正在修改文件";
  } else if (current?.type === "web_search") {
    state = "searching";
    label = "正在检索";
  }
  return (
    <div className="working-indicator" role="status">
      <ThinkingOrb state={state} size={20} paused={paused} />
      <span className="activity-label">{label}</span>
      <span className="activity-time">
        {elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ` : ""}
        {elapsed % 60} 秒
      </span>
    </div>
  );
}
