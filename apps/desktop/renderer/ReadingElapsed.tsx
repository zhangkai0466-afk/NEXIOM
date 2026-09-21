import { memo, useEffect, useState } from "react";
import { formatReadingElapsed, readingElapsedSeconds, type ReadingTiming } from "./reading-elapsed";

// Keep the one-second clock local so it never re-renders the action chain.
export const ReadingElapsed = memo(function ReadingElapsed({ createdAt, finishedAt, status }: ReadingTiming) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [createdAt, finishedAt, status]);

  const seconds = readingElapsedSeconds({ createdAt, finishedAt, status }, now);
  const label = status === "running" ? "已用时" : "总耗时";
  const formatted = formatReadingElapsed(seconds);
  return <span className="reading-progress-elapsed" role="timer" aria-live="off" aria-label={`研读${label} ${formatted}`}>
    <span>{label}</span>
    <time dateTime={seconds === null ? undefined : `PT${seconds}S`}>{formatted}</time>
  </span>;
});
