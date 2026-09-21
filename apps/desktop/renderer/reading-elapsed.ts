import type { Run } from "../../../packages/contracts";

export type ReadingTiming = Pick<Run, "createdAt" | "finishedAt" | "status">;

export function readingElapsedSeconds(run: ReadingTiming, now: number): number | null {
  const start = Date.parse(run.createdAt);
  // Historical runs without an end timestamp must not keep counting today.
  const end = run.status === "running" ? now : run.finishedAt ? Date.parse(run.finishedAt) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export function formatReadingElapsed(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60) % 60;
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${pad(hours)}:` : ""}${pad(minutes)}:${pad(seconds % 60)}`;
}
