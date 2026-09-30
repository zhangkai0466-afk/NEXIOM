import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function AvatarPreview({ source, children }: { source?: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const cancel = () => { clearTimeout(timer.current); };
  useEffect(() => () => cancel(), []);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close); return () => document.removeEventListener("keydown", close);
  }, [open]);
  return <span title={source ? "长按查看头像" : undefined} onPointerDown={() => { held.current = false; if (source) timer.current = setTimeout(() => { held.current = true; setOpen(true); }, 500); }} onPointerUp={cancel} onPointerLeave={cancel} onPointerCancel={cancel} onClickCapture={event => { if (held.current) { event.stopPropagation(); event.preventDefault(); held.current = false; } }}>
    {children}
    {open && source && createPortal(<div className="avatar-preview" role="dialog" aria-label="头像原图" aria-modal="true" onClick={() => setOpen(false)}><button autoFocus aria-label="关闭头像原图" onClick={() => setOpen(false)}><img src={source} alt="头像原图" /></button></div>, document.body)}
  </span>;
}
