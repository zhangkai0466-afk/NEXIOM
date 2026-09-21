import type { CSSProperties } from "react";

// Approximate peak offsets fitted to the reference's timestamped video frames.
// The centre participates in the wave; these are not perimeter/chase delays.
const cycleMs = 760;
const phaseDelayByCell = [0, 579, 440, 629, 360, 483, 233, 697, 396] as const;

export function ThinkingPixelTrail({
  compact = false,
  color,
  size,
  paused = false,
}: {
  compact?: boolean;
  color?: string;
  size?: number;
  paused?: boolean;
}) {
  return (
    <span
      className={`thinking-pixel-trail${compact ? " compact" : ""}`}
      data-paused={paused}
      style={{
        ...(color ? { "--thinking-pixel-color": color } : {}),
        ...(size ? { "--thinking-pixel-size": `${size / 3}px` } : {}),
      } as CSSProperties}
      aria-hidden="true"
    >
      {phaseDelayByCell.map((delay, cell) => (
        <span
          key={cell}
          style={{
            // Start every layer mid-cycle, including on newly mounted events.
            "--thinking-pixel-delay": `${delay - cycleMs}ms`,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}
