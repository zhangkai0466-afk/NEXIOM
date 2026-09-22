import { useEffect } from "react";
import "./tooltip.css";

const SHOW_DELAY = 280;
const HIDE_DELAY = 48;
const GAP = 8;
const MARGIN = 8;

function captureTitle(element: Element) {
  if (!element.hasAttribute("title")) return;
  const value = element.getAttribute("title")?.trim() ?? "";
  element.removeAttribute("title");
  if (value) element.setAttribute("data-nexiom-title", value);
  else element.removeAttribute("data-nexiom-title");
}

function tooltipText(element: Element) {
  captureTitle(element);
  return element.getAttribute("data-nexiom-title")?.trim() ?? "";
}

function anchorFrom(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const element = target.closest("[title], [data-nexiom-title]");
  if (!element || element.classList.contains("nexiom-tooltip")) return null;
  return tooltipText(element) ? element : null;
}

export function TooltipLayer() {
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "nexiom-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    tip.hidden = true;
    document.body.appendChild(tip);

    let current: Element | null = null;
    let pending: Element | null = null;
    let showTimer = 0;
    let hideTimer = 0;

    const hide = () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      pending = null;
      tip.hidden = true;
      tip.textContent = "";
      current = null;
    };

    const place = (anchor: Element) => {
      const rect = anchor.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hide();
        return;
      }
      tip.hidden = false;
      tip.style.left = "0px";
      tip.style.top = "0px";
      const box = tip.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
      const spaceAbove = rect.top - MARGIN;
      const below = spaceBelow >= box.height + GAP || spaceBelow >= spaceAbove;
      let top = below ? rect.bottom + GAP : rect.top - GAP - box.height;
      let left = rect.left + rect.width / 2 - box.width / 2;
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - box.width - MARGIN));
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN));
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    };

    const show = (anchor: Element, value: string) => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      current = anchor;
      tip.textContent = value;
      place(anchor);
    };

    const arm = (anchor: Element, value: string, immediate: boolean) => {
      window.clearTimeout(hideTimer);
      if (current === anchor && tip.textContent === value && !tip.hidden) {
        place(anchor);
        return;
      }
      if (immediate || !tip.hidden) {
        pending = null;
        show(anchor, value);
        return;
      }
      if (pending === anchor) return;
      window.clearTimeout(showTimer);
      pending = anchor;
      showTimer = window.setTimeout(() => {
        pending = null;
        show(anchor, value);
      }, SHOW_DELAY);
    };

    const scheduleHide = (anchor: Element) => {
      if (pending && pending !== anchor) return;
      window.clearTimeout(showTimer);
      pending = null;
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (current === anchor || current === null) hide();
      }, HIDE_DELAY);
    };

    const onOver = (event: Event) => {
      const anchor = anchorFrom(event.target);
      if (!anchor) return;
      arm(anchor, tooltipText(anchor), false);
    };

    const onOut = (event: MouseEvent) => {
      const anchor = event.target instanceof Element
        ? event.target.closest("[title], [data-nexiom-title]")
        : null;
      if (!anchor) return;
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (next && anchor.contains(next)) return;
      if (current === anchor || pending === anchor) scheduleHide(anchor);
    };

    const onFocus = (event: FocusEvent) => {
      const anchor = anchorFrom(event.target);
      if (!anchor?.matches(":focus-visible")) return;
      arm(anchor, tooltipText(anchor), false);
    };

    const onBlur = (event: FocusEvent) => {
      const anchor = event.target instanceof Element
        ? event.target.closest("[data-nexiom-title]")
        : null;
      if (anchor && current === anchor) scheduleHide(anchor);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    const onScroll = () => {
      if (current?.isConnected) place(current);
      else hide();
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) captureTitle(record.target);
        if (record.type === "childList") {
          record.addedNodes.forEach((node) => {
            if (!(node instanceof Element)) return;
            if (node.hasAttribute("title")) captureTitle(node);
            node.querySelectorAll("[title]").forEach(captureTitle);
          });
        }
      }
      if (current && !current.isConnected) hide();
      else if (current && !tip.hidden) {
        const next = tooltipText(current);
        if (!next) hide();
        else if (tip.textContent !== next) show(current, next);
      }
    });

    document.querySelectorAll("[title]").forEach(captureTitle);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("blur", hide);

    return () => {
      hide();
      observer.disconnect();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("blur", hide);
      document.querySelectorAll("[data-nexiom-title]").forEach((element) => {
        if (!element.getAttribute("title")) element.setAttribute("title", element.getAttribute("data-nexiom-title") ?? "");
        element.removeAttribute("data-nexiom-title");
      });
      tip.remove();
    };
  }, []);

  return null;
}
