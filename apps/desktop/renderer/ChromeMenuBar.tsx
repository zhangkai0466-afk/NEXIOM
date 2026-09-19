import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

type Menu = {
  label: string;
  items: { label: string; onSelect: () => void }[];
};

export function ChromeMenuBar({ menus, hidden = false }: { menus: Menu[]; hidden?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const [tabStop, setTabStop] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const hoverOpened = useRef<number | null>(null);
  const pendingFocus = useRef<"first" | "last" | null>(null);

  function close(restoreFocus = false) {
    if (restoreFocus && open !== null) triggers.current[open]?.focus();
    hoverOpened.current = null;
    pendingFocus.current = null;
    setOpen(null);
  }

  function show(index: number, focus: "first" | "last" | null = null) {
    hoverOpened.current = null;
    pendingFocus.current = focus;
    setOpen(index);
    if (open === index && focus) focusItem(focus);
  }

  function focusItem(position: "first" | "last") {
    const items = panel.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
    items?.[position === "first" ? 0 : items.length - 1]?.focus();
    pendingFocus.current = null;
  }

  useLayoutEffect(() => {
    if (open !== null && pendingFocus.current) focusItem(pendingFocus.current);
  }, [open]);

  useEffect(() => {
    if (hidden) close();
  }, [hidden]);

  useEffect(() => {
    if (open === null) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    const blur = () => close();
    const visibility = () => { if (document.hidden) close(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, [open]);

  function horizontal(event: KeyboardEvent, index: number, inPanel: boolean) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : -1) + menus.length) % menus.length;
    triggers.current[next]?.focus();
    if (open !== null) show(next, inPanel ? "first" : null);
    return true;
  }

  return (
    <div className="chrome-menubar" role="menubar" aria-label="应用菜单" ref={root}>
      {menus.map((menu, index) => (
        <div className="chrome-menu" key={menu.label}>
          <button
            className="chrome-menu-trigger"
            id={`chrome-menu-${index}`}
            ref={(node) => { triggers.current[index] = node; }}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            aria-controls={open === index ? `chrome-panel-${index}` : undefined}
            tabIndex={tabStop === index ? 0 : -1}
            onFocus={() => setTabStop(index)}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse" && event.buttons === 0 && open !== null && open !== index) {
                triggers.current[index]?.focus();
                show(index);
                hoverOpened.current = index;
              }
            }}
            onPointerLeave={() => { hoverOpened.current = null; }}
            onClick={(event) => {
              // A mouse click immediately following a hover switch confirms that menu.
              if (event.detail > 0 && open === index && hoverOpened.current === index) {
                hoverOpened.current = null;
                return;
              }
              if (open === index) close();
              else show(index, event.detail === 0 ? "first" : null);
            }}
            onKeyDown={(event) => {
              if (horizontal(event, index, false)) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                show(index, event.key === "ArrowDown" ? "first" : "last");
              } else if (event.key === "Tab") close();
            }}
          >
            {menu.label}
          </button>
          {open === index && (
            <div
              className="chrome-popover"
              role="menu"
              id={`chrome-panel-${index}`}
              aria-labelledby={`chrome-menu-${index}`}
              ref={panel}
              onKeyDown={(event) => {
                if (horizontal(event, index, true)) return;
                if (event.key === "Tab") { close(true); return; }
                const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                let next: number;
                if (event.key === "ArrowDown") next = (current + 1) % items.length;
                else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = items.length - 1;
                else return;
                event.preventDefault();
                items[next]?.focus();
              }}
            >
              {menu.items.map((item) => (
                <button
                  key={item.label}
                  role="menuitem"
                  tabIndex={-1}
                  onPointerEnter={(event) => {
                    if (event.pointerType === "mouse") event.currentTarget.focus();
                  }}
                  onClick={() => { close(true); item.onSelect(); }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
