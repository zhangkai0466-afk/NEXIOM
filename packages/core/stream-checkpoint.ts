import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { ThreadEvent } from "../runtime";

type ItemEvent = Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }>;

function canReplace(previous: ItemEvent, next: ItemEvent) {
  if (previous.item.id !== next.item.id) return false;
  const before = previous.item;
  const after = next.item;
  if (before.type === "agent_message" && after.type === "agent_message")
    return after.text.startsWith(before.text);
  if (before.type === "command_execution" && after.type === "command_execution")
    return before.command === after.command && before.status === after.status &&
      after.aggregated_output.startsWith(before.aggregated_output);
  return false;
}

/** Checkpoint cumulative output, independently of the source's next-event timing. */
export class StreamCheckpoint {
  private pending: ItemEvent | undefined;
  private timer: NodeJS.Timeout | undefined;
  private count = 0;
  private yieldedAt = performance.now();
  private closed = false;
  private completedItems = new Set<string>();
  error: unknown;

  constructor(
    private commit: (events: ThreadEvent[]) => void,
    private failed: () => void,
  ) {}

  push(event: ThreadEvent) {
    if (this.error) throw this.error;
    if (this.closed) throw new Error("流式输出检查点已关闭。");
    this.count++;
    if (event.type === "item.updated" && this.completedItems.has(event.item.id)) return;
    if (event.type === "item.updated" &&
      (event.item.type === "agent_message" || event.item.type === "command_execution")) {
      if (this.pending && !canReplace(this.pending, event)) this.flush();
      // Runners may reuse their item object; retain the received snapshot.
      this.pending = { ...event, item: { ...event.item } };
      if (!this.timer) {
        this.timer = setTimeout(() => {
          try { this.flush(); }
          catch (error) {
            this.error = error;
            this.failed();
          }
        }, 50);
      }
    } else {
      // Failure events must not roll back an earlier partial-output checkpoint.
      this.flush();
      this.commit([event]);
      if (event.type === "item.completed") this.completedItems.add(event.item.id);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.commit([pending]);
  }

  async yieldIfNeeded() {
    if (this.count < 64 && performance.now() - this.yieldedAt < 8) return;
    this.count = 0;
    await yieldToLoop();
    this.yieldedAt = performance.now();
    if (this.error) throw this.error;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.flush();
    if (this.error) throw this.error;
  }
}
