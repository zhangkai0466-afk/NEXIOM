import { useRef, type PointerEvent } from "react";

const COLLAPSE_WIDTH = 96;

export function ReadingOutlineDivider({ width, restoreWidth, max, onChange, onCommit }: {
  width: number; restoreWidth: number; max: number;
  onChange: (width: number) => void; onCommit: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number; current: number; moved: boolean } | null>(null);
  const clamp = (value: number) => Math.min(max, Math.max(0, Math.round(value)));
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    const next = !current.moved && !current.width ? restoreWidth : current.current;
    onCommit(next <= COLLAPSE_WIDTH ? 0 : Math.max(180, clamp(next)));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className="reading-outline-resizer" role="separator" tabIndex={0}
    aria-label="调整报告目录宽度" aria-orientation="vertical" aria-controls="reading-report-outline"
    aria-valuemin={0} aria-valuemax={max} aria-valuenow={width}
    aria-valuetext={width ? `${Math.round(width)} 像素，向左拖动可收起` : "目录已收起，向右拖动或按回车展开"}
    title={width ? "向左拖动收起目录，双击收起" : "向右拖动或点击展开目录"}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width, current: width, moved: false };
    }}
    onPointerMove={event => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      if (Math.abs(event.clientX - current.x) < 3 && !current.moved) return;
      current.moved = true;
      current.current = clamp(current.width + event.clientX - current.x);
      if (current.width && current.current <= COLLAPSE_WIDTH) {
        current.current = 0; finish(event); return;
      }
      onChange(current.current <= COLLAPSE_WIDTH ? 0 : current.current);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => onCommit(width ? 0 : restoreWidth)}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? max
        : ["Enter", " "].includes(event.key) ? (width ? 0 : restoreWidth)
        : !width && event.key === "ArrowRight" ? restoreWidth : width + (event.key === "ArrowRight" ? 16 : -16);
      onCommit(next < 180 ? 0 : clamp(next));
    }} />;
}
