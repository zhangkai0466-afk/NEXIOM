import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

export function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "0px";
      const style = getComputedStyle(element);
      const minimum = parseFloat(style.minHeight) || 32;
      const maximum = parseFloat(style.maxHeight) || 180;
      element.style.height = `${Math.max(minimum, Math.min(maximum, element.scrollHeight))}px`;
      element.style.overflowY = element.scrollHeight > maximum ? "auto" : "hidden";
    };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; resize(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} rows={1} ref={field} />;
}
