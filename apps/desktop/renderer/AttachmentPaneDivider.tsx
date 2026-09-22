import { useRef } from "react";

export function AttachmentPaneDivider({ label, area, width, min, max, reverse = false, onChange, onCommit }: {
  label: string; area: string; width: number; min: number; max: number; reverse?: boolean;
  onChange: (width: number) => void; onCommit: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number; current: number } | undefined>(undefined);
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));
  return <div className="attachment-pane-divider" style={{ gridArea: area }} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width, current: width };
    }}
    onPointerMove={event => {
      if (drag.current?.id !== event.pointerId) return;
      const next = clamp(drag.current.width + (event.clientX - drag.current.x) * (reverse ? -1 : 1));
      drag.current.current = next;
      onChange(next);
    }}
    onLostPointerCapture={() => {
      if (!drag.current) return;
      onCommit(drag.current.current);
      drag.current = undefined;
    }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = clamp(event.key === "Home" ? min : event.key === "End" ? max : width + (event.key === "ArrowRight" ? 16 : -16) * (reverse ? -1 : 1));
      onChange(next); onCommit(next);
    }} />;
}
