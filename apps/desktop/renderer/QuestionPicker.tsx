import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import "./question-picker.css";

/** Editable selection: existing question names or a new name, without a native datalist. */
export function QuestionPicker({ value, options, disabled, onChange }: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(-1);
  const matches = [...new Set(options)].filter(option => option.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const expanded = open && !disabled;
  const activeOption = active >= 0 && active < matches.length ? active : -1;
  const close = () => { setOpen(false); setActive(-1); };
  const show = (last = false) => {
    setFilter("");
    setActive(last ? options.length - 1 : Math.max(0, options.indexOf(value)));
    setOpen(true);
  };
  const select = (option: string) => { onChange(option); close(); input.current?.focus(); };

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);
  useEffect(() => {
    if (expanded && activeOption >= 0) document.getElementById(`${id}-option-${activeOption}`)?.scrollIntoView({ block: "nearest" });
  }, [activeOption, expanded, id]);

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && expanded) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) show(event.key === "ArrowUp");
      else setActive(current => !matches.length ? -1 : current < 0 ? (event.key === "ArrowDown" ? 0 : matches.length - 1)
        : (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === "Enter" && expanded) {
      event.preventDefault();
      if (activeOption >= 0) select(matches[activeOption]); else close();
    } else if (event.key === "Tab") close();
  }

  return <div className="question-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}>
    <label htmlFor={`${id}-input`}>问题</label>
    <div className="question-picker-field" data-disabled={!!disabled}>
      <input id={`${id}-input`} ref={input} autoFocus role="combobox" aria-autocomplete="list" aria-expanded={expanded}
        aria-controls={expanded ? `${id}-list` : undefined} aria-activedescendant={expanded && activeOption >= 0 ? `${id}-option-${activeOption}` : undefined}
        value={value} required maxLength={80} disabled={disabled} autoComplete="off" placeholder="选择或输入问题名称"
        onClick={() => { if (!expanded) show(); }}
        onChange={event => { onChange(event.target.value); setFilter(event.target.value); setActive(-1); setOpen(true); }} onKeyDown={keyDown}/>
      <button type="button" className="question-picker-toggle" tabIndex={-1} disabled={disabled}
        aria-label={expanded ? "收起问题列表" : "展开问题列表"} aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (expanded) close(); else show(); input.current?.focus(); }}><ChevronDown size={16}/></button>
    </div>
    {expanded && <div className="question-picker-popup">
      <div id={`${id}-list`} role="listbox" aria-label="已有问题" className="question-picker-options">
        {matches.map((option, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`} key={option}
          aria-selected={option === value} className={activeOption === index ? "active" : ""}
          onMouseDown={event => event.preventDefault()} onPointerMove={() => setActive(index)} onClick={() => select(option)}>
          <span>{option}</span>{option === value && <Check size={15}/>}</button>)}
      </div>
      {!matches.length && <p className="question-picker-empty" role="status">{value.trim() ? "将使用输入的新问题名称" : "输入问题名称以新建"}</p>}
    </div>}
  </div>;
}
