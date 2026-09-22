import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowDown, ArrowLeft, Square } from "lucide-react";
import { motion } from "motion/react";
import type { AgentItem, Run } from "../../../packages/contracts";
import { AgentTaskIcon, AgentTaskLabel } from "./AgentTaskStatus";
import { AGENT_TASK_STATES } from "./agent-task-state";
import { readingProgressNotice, readingSteps, type ReadingStep } from "./reading-progress";
import { advanceReadingScroll, readingArrivalDelay } from "./reading-progress-motion";
import { ReadingElapsed } from "./ReadingElapsed";
import "./reading-progress.css";

const ReadingAction = memo(function ReadingAction({ id, kind, status, arrivalDelay, final }: ReadingStep & { arrivalDelay: number; final: boolean }) {
  // Keep the initial delay when later snapshots update this node's status.
  const [delay] = useState(arrivalDelay);
  const action = AGENT_TASK_STATES[kind].label.replace(/中$/, "");
  const ending = { completed: "完成", failed: "失败", cancelled: "已停止", interrupted: "已中断" };
  return <li className="reading-progress-step" data-step-id={id} style={{ "--reading-arrival-delay": `${delay}ms` } as CSSProperties}>
    <span className="reading-progress-link" aria-hidden="true" />
    <div className="reading-progress-action" data-task-status={status}>
      <AgentTaskIcon kind={kind} status={status} size={32} final={final} />
      <AgentTaskLabel kind={kind} status={status}>
        {status === "running" ? `${action}中` : `${action}${ending[status]}`}
      </AgentTaskLabel>
    </div>
  </li>;
});

function reducedMotion() {
  return document.documentElement.dataset.reduceMotion === "true" || matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ReadingProgress({ run, items, onCancel, onBack, backLabel = "返回研读报告", history = false, onViewReport }: {
  run: Run;
  items: AgentItem[];
  onCancel: () => void;
  onBack?: () => void;
  backLabel?: string;
  history?: boolean;
  onViewReport?: () => void;
}) {
  const steps = useMemo(() => readingSteps(items, run), [items, run]);
  const viewport = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef(0);
  const scrollMotion = useRef({ position: 0, velocity: 0, time: 0 });
  const knownSteps = useRef(new Set(steps.map(step => step.id)));
  const scheduledArrival = useRef(0);
  const following = useRef(!history);
  const [showLatest, setShowLatest] = useState(false);
  const tail = steps.at(-1);
  const completed = run.status === "succeeded" && tail?.kind === "writing" && steps.every(step => step.status === "completed");
  const notice = readingProgressNotice(steps, run);
  let newActionIndex = 0;
  const arrivalTime = performance.now();
  let nextArrival = scheduledArrival.current;
  const arrivals = steps.map(step => {
    if (knownSteps.current.has(step.id)) return 0;
    const delay = readingArrivalDelay(newActionIndex++, scheduledArrival.current - arrivalTime);
    nextArrival = arrivalTime + delay + 55;
    return delay;
  });

  function stopScrolling() {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = 0;
    scrollMotion.current.velocity = 0;
  }
  function followLatest() {
    const node = viewport.current;
    if (!node) return;
    following.current = true;
    setShowLatest(false);
    const start = node.scrollTop;
    const destination = Math.max(0, node.scrollHeight - node.clientHeight);
    if (reducedMotion() || Math.abs(destination - start) < 1) {
      stopScrolling();
      node.scrollTop = destination;
      return;
    }
    // Keep a single animation alive through bursts, retargeting it each frame.
    if (scrollFrame.current) return;
    scrollMotion.current = { position: start, velocity: 0, time: performance.now() };
    const advance = (now: number) => {
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      const previous = scrollMotion.current;
      const next = reducedMotion() ? { position: target, velocity: 0 } : advanceReadingScroll(previous, target, now - previous.time);
      scrollMotion.current = { ...next, time: now };
      node.scrollTop = next.position;
      if (next.position !== target || next.velocity !== 0) scrollFrame.current = requestAnimationFrame(advance);
      else scrollFrame.current = 0;
    };
    scrollFrame.current = requestAnimationFrame(advance);
  }
  function browseHistory() {
    stopScrolling();
    following.current = false;
  }

  useLayoutEffect(() => {
    knownSteps.current = new Set(steps.map(step => step.id));
    scheduledArrival.current = nextArrival;
    // Only an actual phase addition or terminal state can move the scroll target.
    if (following.current) followLatest();
    else {
      const node = viewport.current;
      setShowLatest(!!node && node.scrollHeight - node.clientHeight - node.scrollTop > 24);
    }
  }, [tail?.id, steps.length, run.status]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (following.current) followLatest();
      else setShowLatest(node.scrollHeight - node.clientHeight - node.scrollTop > 24);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => stopScrolling(), []);

  return <section className="reading-progress" data-history={history} aria-label="赛题研读进度" aria-busy={run.status === "running"}>
    <motion.div layoutScroll className="reading-progress-viewport" ref={viewport} tabIndex={0} aria-label="完整研读阶段链"
      onWheel={event => { if (event.deltaY < 0) browseHistory(); }}
      onPointerDown={browseHistory}
      onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) browseHistory(); }}
      onScroll={() => {
        if (scrollFrame.current) return;
        const node = viewport.current!;
        const atEnd = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
        following.current = atEnd;
        setShowLatest(!atEnd);
      }}>
      <div className="reading-progress-stage">
        <motion.ol className="reading-progress-chain" layout={history || reducedMotion() ? false : "position"}
          layoutDependency={`${steps.length}:${tail?.id}:${completed}`}
          transition={{ layout: { duration: 0.36, ease: [0.22, 1, 0.36, 1] } }}
          aria-live={history ? "off" : "polite"} aria-relevant="additions text">
          {steps.map((step, index) => <ReadingAction key={step.id} {...step} final={completed && index === steps.length - 1} arrivalDelay={history ? 0 : arrivals[index]} />)}
        </motion.ol>
        {notice && <p className="reading-progress-notice" data-empty={!steps.length} role="status">{notice}</p>}
        {onViewReport && <button className="reading-progress-view primary-button" type="button" onClick={onViewReport}>查看报告</button>}
      </div>
    </motion.div>
    {onBack && <button className="reading-progress-back secondary-button" type="button" onClick={onBack}><ArrowLeft size={15} />{backLabel}</button>}
    <div className="reading-progress-controls">
      <ReadingElapsed createdAt={run.createdAt} finishedAt={run.finishedAt} status={run.status} />
      {showLatest && <button className="reading-progress-latest" type="button" onClick={followLatest}><ArrowDown size={15} />回到当前阶段</button>}
      {run.status === "running" && <button className="reading-progress-stop" type="button" onClick={onCancel} title="停止研读" aria-label="停止研读"><Square size={15} /></button>}
    </div>
  </section>;
}
