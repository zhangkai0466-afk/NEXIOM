import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Check, ChevronRight, Eye, Folder, FolderOpen, GitBranch, Image as ImageIcon, LoaderCircle, Minus, Move, Palette, Plus, Redo2, RefreshCw, RotateCcw, Save, Search, Undo2, X } from "lucide-react";
import type { VisualPalette } from "../../../packages/contracts";
import type { VisualAsset, VisualAssetSummary, VisualElement, VisualFigure, VisualWorkspaceState } from "../../../packages/visualization/document";
import { renderVisualFigure } from "../../../packages/visualization/render";
import { request, subscribe } from "./bridge";
import { WorkspaceLogo } from "./WorkspaceLogo";
import "./visual-workspace.css";

type Props = { projectId: string; onFilesChanged: () => void };
type History = { past: VisualFigure[]; present: VisualFigure; future: VisualFigure[] };
const libraryNames = { modeling: "建模过程", paper: "论文论述" };
const kindNames = { "grouped-bar": "分组条形图", line: "折线图", scatter: "散点图", diagram: "结构图" };
const clone = (figure: VisualFigure): VisualFigure => structuredClone(figure);
const same = (left: VisualFigure, right: VisualFigure) => JSON.stringify(left) === JSON.stringify(right);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";

function positionOf(figure: VisualFigure, element: VisualElement) {
  if (element.kind === "node") return figure.nodes.find(node => `node:${node.id}` === element.id)!;
  if (element.kind === "annotation") return figure.annotations.find(note => `annotation:${note.id}` === element.id)!;
  if (["title", "legend", "plot", "xLabel", "yLabel"].includes(element.kind)) return figure.layout[element.kind as "title" | "legend" | "plot" | "xLabel" | "yLabel"];
  return null;
}

function moveElement(figure: VisualFigure, element: VisualElement, x: number, y: number): VisualFigure {
  const next = clone(figure);
  const value = positionOf(next, element);
  if (!value) return next;
  const width = element.kind === "plot" ? next.layout.plot.width : element.kind === "node" ? (value as VisualFigure["nodes"][number]).width : element.kind === "legend" ? element.bounds.width : 0;
  const height = element.kind === "plot" ? next.layout.plot.height : element.kind === "node" ? (value as VisualFigure["nodes"][number]).height : element.kind === "legend" ? element.bounds.height : 0;
  value.x = Math.max(0, Math.min(1 - width, x));
  value.y = Math.max(0, Math.min(1 - height, y));
  return next;
}

function AssetItem({ item, selected, onSelect }: { item: VisualAssetSummary; selected: boolean; onSelect: () => void }) {
  return <button className={`vws-asset ${selected ? "active" : ""}`} onClick={onSelect} title={item.purpose}>
    <span className="vws-asset-icon">{item.kind === "diagram" ? <GitBranch size={18} /> : <ImageIcon size={18} />}</span>
    <span><strong>{item.title}</strong><small>{kindNames[item.kind]} · 第 {item.revision} 版</small></span>
    <ChevronRight size={13} />
  </button>;
}

export function VisualDesignWorkspace({ projectId, onFilesChanged }: Props) {
  const [workspace, setWorkspace] = useState<VisualWorkspaceState | null>(null);
  const [palettes, setPalettes] = useState<VisualPalette[]>([]);
  const [paletteId, setPaletteId] = useState("");
  const [query, setQuery] = useState("");
  const [asset, setAsset] = useState<VisualAsset | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [tool, setTool] = useState<"color" | "layout">("color");
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [intent, setIntent] = useState<VisualAssetSummary | null>(null);
  const [zoom, setZoom] = useState(1);
  const [available, setAvailable] = useState({ width: 500, height: 500 });
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const openSequence = useRef(0);
  const alive = useRef(true);
  const drag = useRef<{ element: VisualElement; initial: VisualFigure; x: number; y: number; width: number; height: number; pointer: number } | null>(null);
  const present = useRef<VisualFigure | null>(null);
  present.current = history?.present ?? null;
  const dirty = !!(asset && history && !same(asset.figure, history.present));
  const figure = comparing ? asset?.figure : history?.present;
  const rendered = useMemo(() => figure ? renderVisualFigure(figure) : null, [figure]);
  const elements = rendered?.elements ?? [];
  const selected = elements.find(element => element.id === selectedId) ?? null;
  const activePalette = palettes.find(palette => palette.id === paletteId) ?? palettes[0];
  const editableElements = elements.filter(element => tool === "color" ? !!element.color : element.movable);
  const locked = opening || saving || comparing;
  const filtered = (workspace?.assets ?? []).filter(item => `${item.title} ${item.purpose}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const refresh = useCallback(async () => {
    const response = await request({ type: "visual.workspace", projectId });
    if (alive.current) setWorkspace(response.visualWorkspace ?? null);
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    void refresh().catch(cause => { if (alive.current) setError(errorMessage(cause)); }).finally(() => { if (alive.current) setLoading(false); });
    void request({ type: "visual.palettes" }).then(response => { if (alive.current) setPalettes(response.visualPalettes ?? []); }).catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = subscribe(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh().catch(cause => { if (alive.current) setError(errorMessage(cause)); }); }, 350);
    });
    return () => { alive.current = false; clearTimeout(timer); unsubscribe(); openSequence.current += 1; };
  }, [refresh]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(entries => {
      const box = entries[0].contentRect;
      setAvailable({ width: Math.max(80, box.width), height: Math.max(80, box.height) });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  function commit(next: VisualFigure) {
    setHistory(current => !current || same(current.present, next) ? current : ({ past: [...current.past.slice(-39), current.present], present: next, future: [] }));
    setNotice("");
    setError("");
  }

  async function openAsset(item: VisualAssetSummary) {
    const sequence = ++openSequence.current;
    setOpening(true); setError(""); setNotice(""); setComparing(false);
    try {
      const response = await request({ type: "visual.figure.read", projectId, library: item.library, id: item.id });
      if (sequence !== openSequence.current) return;
      if (!response.visualFigure) throw new Error("素材未返回可编辑的图表文档。");
      const loaded = response.visualFigure;
      setAsset(loaded);
      setHistory({ past: [], present: loaded.figure, future: [] });
      setSelectedId(loaded.elements.find(element => element.color)?.id ?? "");
      setTool("color"); setZoom(1);
    } catch (cause) { if (sequence === openSequence.current) setError(errorMessage(cause)); }
    finally { if (sequence === openSequence.current) setOpening(false); }
  }

  function navigate(next: VisualAssetSummary) {
    if (locked) return;
    if (asset?.id === next.id && asset.revision === next.revision) return;
    if (dirty) setIntent(next);
    else void openAsset(next);
  }

  async function save(): Promise<boolean> {
    if (!asset || !history || saving) return false;
    setSaving(true); setError("");
    try {
      const response = await request({ type: "visual.figure.save", projectId, library: asset.library, id: asset.id, expectedRevision: asset.revision, figure: history.present });
      if (!response.visualFigure) throw new Error("保存未返回新版本。");
      setAsset(response.visualFigure);
      setHistory({ past: [], present: response.visualFigure.figure, future: [] });
      setNotice(`已保存至${libraryNames[asset.library]}素材库 · 第 ${response.visualFigure.revision} 版`);
      onFilesChanged();
      await refresh();
      return true;
    } catch (cause) { setError(errorMessage(cause)); return false; }
    finally { setSaving(false); }
  }

  function changeColor(value: string) {
    if (!history || !selected || !/^#[0-9a-f]{6}$/i.test(value) || locked) return;
    const next = clone(history.present);
    const candidates = [...next.series.map(item => ({ item, id: `series:${item.id}` })), ...next.nodes.map(item => ({ item, id: `node:${item.id}` })), ...next.edges.map(item => ({ item, id: `edge:${item.id}` })), ...next.annotations.map(item => ({ item, id: `annotation:${item.id}` }))];
    const target = candidates.find(item => item.id === selected.id);
    if (target) { target.item.color = value.toUpperCase(); commit(next); }
  }

  function moveSelected(axis: "x" | "y", percent: number) {
    if (!history || !selected || !Number.isFinite(percent) || locked) return;
    const position = positionOf(history.present, selected);
    if (position) commit(moveElement(history.present, selected, axis === "x" ? percent / 100 : position.x, axis === "y" ? percent / 100 : position.y));
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (locked || event.button !== 0 || !history || !(event.target instanceof Element)) return;
    const series = tool === "color" ? event.target.closest("[data-series-id]")?.getAttribute("data-series-id") : null;
    const id = series ? `series:${series}` : event.target.closest("[data-element-id]")?.getAttribute("data-element-id");
    const element = elements.find(item => item.id === id);
    if (!element) return;
    setSelectedId(element.id);
    if (tool !== "layout" || !element.movable) return;
    const box = canvas.current!.getBoundingClientRect();
    drag.current = { element, initial: clone(history.present), x: event.clientX, y: event.clientY, width: box.width, height: box.height, pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const movement = drag.current;
    if (!movement || movement.pointer !== event.pointerId) return;
    const from = positionOf(movement.initial, movement.element);
    if (!from) return;
    const next = moveElement(movement.initial, movement.element, from.x + (event.clientX - movement.x) / movement.width, from.y + (event.clientY - movement.y) / movement.height);
    present.current = next;
    setHistory(current => current ? { ...current, present: next } : null);
    setNotice("");
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const movement = drag.current;
    if (!movement || movement.pointer !== event.pointerId) return;
    drag.current = null;
    const next = cancelled ? movement.initial : present.current!;
    setHistory(current => current ? {
      past: cancelled || same(movement.initial, next) ? current.past : [...current.past.slice(-39), movement.initial],
      present: next, future: cancelled || same(movement.initial, next) ? current.future : [],
    } : null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function undo() {
    setHistory(current => !current?.past.length ? current : ({ past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [current.present, ...current.future] }));
    setNotice("");
  }
  function redo() {
    setHistory(current => !current?.future.length ? current : ({ past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1) }));
    setNotice("");
  }
  function changeTool(next: "color" | "layout") {
    setTool(next);
    setSelectedId(elements.find(element => next === "color" ? !!element.color : element.movable && element.kind === "legend")?.id ?? elements.find(element => element.movable)?.id ?? "");
  }

  const position = selected && history ? positionOf(history.present, selected) : null;
  const fit = figure ? Math.min(available.width / figure.width, available.height / figure.height) : 1;
  const stageStyle = figure ? { width: figure.width * fit * zoom, height: figure.height * fit * zoom } : {};

  return <div className="vws">
    <header className="vws-header">
      <WorkspaceLogo dimension="chart" />
      <div className="vws-title"><strong>可视化工作台</strong><span>{asset?.title ?? "项目可视化素材"}{dirty && <i title="尚未保存" />}</span></div>
      <div className="vws-modes" role="tablist" aria-label="可视化编辑工具">
        <button role="tab" aria-selected={tool === "color"} className={tool === "color" ? "active" : ""} onClick={() => changeTool("color")}><Palette size={15} />调色</button>
        <button role="tab" aria-selected={tool === "layout"} className={tool === "layout" ? "active" : ""} onClick={() => changeTool("layout")}><Move size={15} />调整</button>
      </div>
      <div className="vws-actions">
        <button className="vws-icon" aria-label="撤销" title="撤销" disabled={locked || !history?.past.length} onClick={undo}><Undo2 size={17} /></button>
        <button className="vws-icon" aria-label="重做" title="重做" disabled={locked || !history?.future.length} onClick={redo}><Redo2 size={17} /></button>
        <button className={`vws-icon ${comparing ? "active" : ""}`} aria-label={comparing ? "返回编辑" : "对比已保存版本"} title={comparing ? "返回编辑" : "对比已保存版本"} disabled={!asset || opening || saving} onClick={() => setComparing(value => !value)}><Eye size={17} /></button>
        <button className="vws-save" disabled={!dirty || locked} onClick={() => void save()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}确认保存入库</button>
      </div>
    </header>
    <div className="vws-body">
      <aside className="vws-library" aria-label="Agent 可视化素材库">
        <div className="vws-heading"><strong><Folder size={15} />全部可视化素材</strong><button className="vws-icon" title="刷新素材库" aria-label="刷新素材库" disabled={loading} onClick={() => void refresh().catch(cause => setError(errorMessage(cause)))}><RefreshCw size={14} /></button></div>
        <label className="vws-search"><Search size={14} /><input aria-label="搜索项目素材" placeholder="搜索素材" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="vws-asset-list">{loading ? <div className="vws-small-empty"><LoaderCircle className="spin" size={19} />正在读取素材库</div> : filtered.length ? filtered.map(item => <AssetItem key={item.id} item={item} selected={asset?.id === item.id} onSelect={() => navigate(item)} />) : <div className="vws-small-empty"><FolderOpen size={24} /><span>{query ? "没有匹配的素材" : "暂无 Agent 生成的素材"}</span></div>}</div>
        <div className="vws-library-path"><span>全部素材</span><span>{workspace?.assets.length ?? 0} 张</span></div>
      </aside>
      <main className="vws-stage">
        <div className="vws-stage-toolbar"><span>{asset ? `${kindNames[asset.kind]} · ${libraryNames[asset.library]} · 第 ${asset.revision} 版` : "画布"}</span><div><button className="vws-icon" aria-label="缩小画布" title="缩小画布" disabled={!figure || zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}><Minus size={14} /></button><button className="vws-zoom" title="适合画布" disabled={!figure} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button className="vws-icon" aria-label="放大画布" title="放大画布" disabled={!figure || zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.25))}><Plus size={14} /></button></div></div>
        <div className="vws-viewport" ref={viewport}>
          {opening ? <div className="vws-empty"><LoaderCircle className="spin" size={28} /><strong>正在打开图表</strong></div> : !figure || !rendered ? <div className="vws-empty"><GitBranch size={40} strokeWidth={1.2} /><strong>{loading ? "正在读取项目素材" : "暂无打开的可视化素材"}</strong></div> : <div ref={canvas} className={`vws-canvas ${tool === "layout" && !comparing ? "moving" : ""}`} style={stageStyle} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)}>
            <div className="vws-svg" aria-label="可编辑图表" dangerouslySetInnerHTML={{ __html: rendered.svg }} />
            {selected && !comparing && !(selected.kind === "legend" && !figure.layout.legend.visible) && <div className="vws-selection" style={{ left: `${selected.bounds.x * 100}%`, top: `${selected.bounds.y * 100}%`, width: `${selected.bounds.width * 100}%`, height: `${selected.bounds.height * 100}%` }}><span>{selected.label}</span></div>}
          </div>}
        </div>
        <footer className="vws-status"><span>{comparing ? "已保存版本" : selected?.label ?? "未选择元素"}</span><span>{dirty ? "尚未保存" : asset ? "已入库" : ""}</span></footer>
      </main>
      <aside className="vws-inspector" aria-label="图表元素属性">
        <section><div className="vws-heading"><h2>{tool === "color" ? "配色元素" : "结构元素"}</h2>{asset && <button className="vws-icon" title="还原全部修改" aria-label="还原全部修改" disabled={!dirty || locked} onClick={() => commit(clone(asset.figure))}><RotateCcw size={14} /></button>}</div>
          <div className="vws-elements">{editableElements.length ? editableElements.map(element => <button key={element.id} disabled={locked} className={selectedId === element.id ? "active" : ""} onClick={() => setSelectedId(element.id)}>{element.color ? <span className="vws-dot" style={{ backgroundColor: element.color }} /> : <Move size={13} />}<span>{element.label}</span>{selectedId === element.id && <Check size={13} />}</button>) : <div className="vws-muted">{asset ? "此图没有对应元素" : "尚未打开图表"}</div>}</div>
        </section>
        {tool === "color" && selected?.color && <section className="vws-colors"><h2>{selected.label}</h2><label className="vws-custom-color"><input aria-label={`${selected.label}颜色`} type="color" value={selected.color} disabled={locked} onChange={event => changeColor(event.target.value)} /><code>{selected.color}</code></label><label className="vws-field"><span>色库</span><select aria-label="选择色板" value={activePalette?.id ?? ""} onChange={event => setPaletteId(event.target.value)} disabled={!palettes.length}>{!palettes.length && <option value="">色库暂不可用</option>}{palettes.map(palette => <option key={palette.id} value={palette.id}>{palette.name}</option>)}</select></label><div className="vws-swatches">{activePalette?.colors.map((color, index) => <button key={`${color}-${index}`} aria-label={`将${selected.label}设为${color}`} title={color} disabled={locked} style={{ backgroundColor: color }} onClick={() => changeColor(color)}>{color.toLowerCase() === selected.color?.toLowerCase() && <Check size={14} />}</button>)}</div></section>}
        {tool === "layout" && selected?.movable && position && <section><h2>{selected.label}</h2><div className="vws-position">{(["x", "y"] as const).map(axis => <label className="vws-field" key={axis}><span>{axis === "x" ? "水平位置 %" : "垂直位置 %"}</span><input aria-label={`${selected.label}${axis === "x" ? "水平" : "垂直"}位置`} type="number" min="0" max="100" step="1" value={Math.round(position[axis] * 1000) / 10} disabled={locked} onChange={event => moveSelected(axis, event.target.valueAsNumber)} /></label>)}</div>
          {selected.kind === "legend" && history && <><label className="vws-check"><input type="checkbox" checked={history.present.layout.legend.visible} disabled={locked} onChange={event => { const next = clone(history.present); next.layout.legend.visible = event.target.checked; commit(next); }} />显示图例</label><button className="vws-create" disabled={locked} onClick={() => { const next = clone(history!.present); next.layout.plot = { x: 0.12, y: 0.18, width: 0.58, height: 0.66 }; next.layout.legend.x = 0.73; next.layout.legend.y = 0.2; commit(next); }}>图例置于绘图区右侧</button></>}
        </section>}
        {tool === "layout" && history && <section><label className="vws-field"><span>文字字号</span><input type="number" min="10" max="28" step="1" aria-label="图表文字字号" value={history.present.layout.fontSize} disabled={locked} onChange={event => { const value = event.target.valueAsNumber; if (Number.isInteger(value) && value >= 10 && value <= 28) { const next = clone(history.present); next.layout.fontSize = value; commit(next); } }} /></label></section>}
        {asset && <section className="vws-details"><h2>素材信息</h2><span>{libraryNames[asset.library]}素材库</span><p>{asset.purpose}</p>{asset.sourcePaths.map(source => <code key={source} title={source}>{source}</code>)}</section>}
      </aside>
    </div>
    {(error || notice || !!workspace?.warnings.length) && <div className={`vws-message ${error || workspace?.warnings.length ? "error" : "success"}`} role={error ? "alert" : "status"}><span>{error || notice || workspace?.warnings.join("；")}</span><button className="vws-icon" aria-label="关闭消息" onClick={() => { setError(""); setNotice(""); setWorkspace(current => current ? { ...current, warnings: [] } : current); }}><X size={14} /></button></div>}
    {intent && <div className="vws-dialog-backdrop"><div className="vws-dialog" role="dialog" aria-modal="true" aria-labelledby="vws-unsaved-title"><h2 id="vws-unsaved-title">保存当前图表的修改？</h2><p>{asset?.title} 有尚未入库的修改。</p><footer><button onClick={() => setIntent(null)} disabled={saving}>取消</button><button disabled={saving} onClick={() => { const next = intent; setIntent(null); if (asset) setHistory({ past: [], present: asset.figure, future: [] }); void openAsset(next); }}>放弃修改</button><button className="vws-save" disabled={saving} onClick={() => { const next = intent; void save().then(saved => { if (saved) { setIntent(null); void openAsset(next); } }); }}><Save size={15} />保存并继续</button></footer></div></div>}
  </div>;
}
