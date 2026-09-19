import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight, BookOpen, ChartNoAxesCombined, Check, ChevronRight,
  Grid2X2, ImageIcon, LoaderCircle, Palette, Pipette, Search, X, ZoomIn, ZoomOut,
} from "lucide-react";
import type {
  VisualCatalog, VisualGrammarEntry, VisualPalette, VisualReference,
  VisualStatus, VisualTemplate,
} from "../../../packages/contracts";
import { request } from "./bridge";
import { ImageRecolorWorkspace } from "./ImageRecolorWorkspace";
import "./visual-design.css";

type LibraryTab = "templates" | "references" | "palettes" | "grammar";
type Selection =
  | { type: "templates"; item: VisualTemplate }
  | { type: "references"; item: VisualReference }
  | { type: "palettes"; item: VisualPalette }
  | { type: "grammar"; item: VisualGrammarEntry };

const tabs = [
  { id: "templates", label: "绘图模板", icon: ChartNoAxesCombined },
  { id: "references", label: "参考图库", icon: ImageIcon },
  { id: "palettes", label: "学术配色", icon: Palette },
  { id: "grammar", label: "图种索引", icon: BookOpen },
] as const;
const assetCache = new Map<string, Promise<string>>();
const PAGE_SIZE = 24;
function loadAsset(assetId: string) {
  let pending = assetCache.get(assetId);
  if (!pending) {
    pending = request({ type: "visual.asset", assetId }).then(({ file }) => {
      if (!file?.base64 || !file.mime.startsWith("image/")) throw new Error("参考图暂时无法读取");
      return `data:${file.mime};base64,${file.base64}`;
    });
    assetCache.set(assetId, pending);
    if (assetCache.size > 64) assetCache.delete(assetCache.keys().next().value!);
    void pending.catch(() => assetCache.delete(assetId));
  }
  return pending;
}

function ReferenceImage({ item, large = false }: { item: VisualReference; large?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let started = false;
    setSrc("");
    setFailed(false);
    const load = () => {
      if (started || !item.assetId) return;
      started = true;
      void loadAsset(item.assetId).then((value) => {
        if (active) setSrc(value);
      }).catch(() => {
        if (active) setFailed(true);
      });
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load();
    }, { rootMargin: "180px" });
    if (large) load();
    else if (ref.current) observer.observe(ref.current);
    return () => { active = false; observer.disconnect(); };
  }, [item.assetId, large, retry]);
  return (
    <div ref={ref} className={`visual-reference-image ${large ? "large" : ""}`}>
      {src ? <img src={src} alt={item.name} loading={large ? "eager" : "lazy"} /> : (
        <span className="visual-image-placeholder">
          {failed || !item.assetId ? <ImageIcon size={24} /> : <LoaderCircle size={20} className="spin" />}
          <span>{failed ? "图片加载失败" : !item.assetId ? "暂无预览图" : "正在载入参考图"}</span>
          {failed && large && <button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重新加载</button>}
        </span>
      )}
    </div>
  );
}

// These small diagrams describe chart structure; they are not generated outputs.
function TemplateDiagram({ item }: { item: VisualTemplate }) {
  const key = `${item.id} ${item.family}`.toLowerCase();
  let graphic: ReactNode;
  if (/heatmap|matrix|correlation/.test(key)) {
    graphic = Array.from({ length: 30 }, (_, i) => (
      <rect key={i} x={33 + (i % 6) * 25} y={17 + Math.floor(i / 6) * 18} width={22} height={15} rx={2}
        fill="currentColor" opacity={0.15 + ((i * 7) % 13) / 16} />
    ));
  } else if (/pie|donut|radar|polar/.test(key)) {
    graphic = <><circle cx="109" cy="61" r="39" fill="none" stroke="currentColor" strokeWidth="18" opacity=".18" /><circle cx="109" cy="61" r="39" fill="none" stroke="currentColor" strokeWidth="18" strokeDasharray="106 245" transform="rotate(-90 109 61)" /><circle cx="109" cy="61" r="39" fill="none" stroke="currentColor" strokeWidth="18" opacity=".5" strokeDasharray="49 245" strokeDashoffset="-111" transform="rotate(-90 109 61)" /></>;
  } else if (/bar|histogram|tornado|gantt/.test(key)) {
    graphic = <><path d="M27 14V104H204" fill="none" stroke="currentColor" opacity=".16" />{[49, 72, 38, 82, 61, 91].map((height, i) => <rect key={i} x={39 + i * 26} y={103 - height} width="17" height={height} rx="2" fill="currentColor" opacity={i % 2 ? ".78" : ".32"} />)}</>;
  } else if (/scatter|residual|qq|pareto/.test(key)) {
    graphic = <><path d="M27 14V104H204" fill="none" stroke="currentColor" opacity=".16" /><path d="M38 92L193 27" fill="none" stroke="currentColor" opacity=".3" strokeDasharray="4 5" />{Array.from({ length: 18 }, (_, i) => <circle key={i} cx={39 + ((i * 43) % 155)} cy={95 - ((i * 43) % 155) * .4 + ((i * 11) % 23) - 12} r={3.4} fill="currentColor" opacity={.35 + (i % 3) * .25} />)}</>;
  } else if (/network|graph|flow|sankey/.test(key)) {
    graphic = <><path d="M44 63L94 28L151 45L184 86L115 96L44 63L151 45L115 96L94 28" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".35" />{[[44, 63], [94, 28], [151, 45], [184, 86], [115, 96]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === 2 ? 10 : 7} fill="currentColor" opacity={i === 2 ? .9 : .5} />)}</>;
  } else {
    graphic = <><path d="M27 14V104H204M27 74H204M27 43H204" fill="none" stroke="currentColor" opacity=".12" /><path d="M36 87L65 68L94 76L123 48L154 55L193 25" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M36 96L65 87L94 90L123 74L154 80L193 51" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 5" opacity=".4" />{[[36, 87], [65, 68], [94, 76], [123, 48], [154, 55], [193, 25]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3" fill="currentColor" />)}</>;
  }
  return <div className="visual-template-diagram"><svg viewBox="0 0 230 122" aria-hidden="true">{graphic}</svg><span>结构示意</span></div>;
}

function Swatches({ colors, labeled = false }: { colors: string[]; labeled?: boolean }) {
  return <div className={`visual-swatches ${labeled ? "labeled" : ""}`}>{colors.map((color, i) => <div key={`${color}-${i}`}><span style={{ backgroundColor: color }} title={color} />{labeled && <code>{color}</code>}</div>)}</div>;
}
function DetailList({ title, values }: { title: string; values: string[] }) {
  return values.length > 0 ? <section className="visual-detail-section"><h3>{title}</h3><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></section> : null;
}
function promptFor(selection: Selection) {
  const item = selection.item;
  if (selection.type === "templates") return `请使用可视化资源库中的「${item.name}」模板（template_id: ${item.id}）设计图表。\n\n先检查项目中的数据与本模板的适用条件，确认要表达的结论、字段映射和图表方案，再生成可复现的绘图代码与图片。\n\n我希望表达的结论：\n数据文件与字段：`;
  if (selection.type === "palettes") return `请使用可视化资源库中的「${item.name}」配色（palette_id: ${item.id}）设计图表。\n配色：${selection.item.colors.join("、")}\n\n先检查项目数据，建议合适的图种，注意色彩区分度与论文排版。\n\n我希望表达的结论：\n数据文件与字段：`;
  if (selection.type === "references") return `请参考可视化资源库中的「${item.name}」（reference_id: ${item.id}）设计图表。\n\n参考其视觉布局和表达方式，并根据项目数据确定可执行的绘图方案。参考图仅提供设计参考，请勿把其中的数据当作项目数据。\n\n我希望表达的结论：\n数据文件与字段：`;
  return `请使用可视化资源库中的「${item.name}」图种（template_id: ${selection.item.templateId}）设计图表。\n\n先检查项目数据及图种适用条件，确认字段映射与表达目标。\n\n我希望表达的结论：\n数据文件与字段：`;
}

function ResourceDetail({ selection, busy, onClose, onStart }: {
  selection: Selection; busy: boolean; onClose: () => void;
  onStart: (prompt: string, title: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const { item } = selection;
  const canStart = selection.type !== "grammar" || (selection.item.status === "executable" && !!selection.item.templateId);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} className={`visual-detail ${expanded ? "expanded" : ""}`} aria-labelledby="visual-detail-title"
      onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <header><div><span className="visual-eyebrow">{tabs.find((tab) => tab.id === selection.type)?.label}</span><h2 id="visual-detail-title">{item.name}</h2></div><button type="button" className="icon-button" aria-label="关闭资源详情" onClick={onClose}><X size={19} /></button></header>
      <div className="visual-detail-body">
        {selection.type === "templates" && <TemplateDiagram item={selection.item} />}
        {selection.type === "palettes" && <Swatches colors={selection.item.colors} labeled />}
        {selection.type === "references" && <div className="visual-large-image"><ReferenceImage item={selection.item} large />{selection.item.assetId && <button className="visual-zoom" onClick={() => setExpanded((value) => !value)}>{expanded ? <ZoomOut size={16} /> : <ZoomIn size={16} />}{expanded ? "适合窗口" : "放大查看"}</button>}</div>}
        <p className="visual-detail-description">{item.description || "浏览此资源并结合项目数据选择合适的表达方式。"}</p>
        {selection.type === "templates" && <>
          <div className="visual-detail-meta"><span className="visual-badge executable"><Check size={11} />可执行模板</span><span>{selection.item.family}</span><code>{item.id}</code></div>
          {selection.item.readerQuestion && <section className="visual-detail-section"><h3>适合回答的问题</h3><p>{selection.item.readerQuestion}</p></section>}
          <DetailList title="所需数据字段" values={selection.item.requiredColumns} />
          <DetailList title="适用条件" values={selection.item.preconditions} />
          <DetailList title="不适用情形" values={selection.item.forbiddenUses} />
        </>}
        {selection.type === "references" && <><div className="visual-detail-meta"><span className="visual-badge">设计参考</span>{selection.item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><p className="visual-detail-note">参考图用于选择布局与风格。开始设计后，将根据你的数据匹配绘图模板。</p></>}
        {selection.type === "grammar" && <><div className="visual-detail-meta"><span className={`visual-badge ${selection.item.status === "executable" ? "executable" : ""}`}>{selection.item.status === "executable" ? "已关联可执行模板" : "仅图种索引"}</span><span>{selection.item.nameEn}</span></div><p className="visual-detail-note">{canStart ? `关联模板：${selection.item.templateId}` : "此条目用于查阅图种名称与表达方式，目前没有关联的可执行模板。"}</p></>}
        {error && <p className="visual-inline-error" role="alert">{error}</p>}
      </div>
      <footer><span>{canStart ? "创建图表对话，内容将填入草稿" : "可在绘图模板中选择可执行资源"}</span>{canStart && <button type="button" className="visual-primary" disabled={busy} onClick={async () => {
        setError("");
        try { await onStart(promptFor(selection), `${item.name} · 图表设计`); }
        catch (error) { setError(error instanceof Error ? error.message : "创建图表对话失败，请重试。"); }
      }}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}开始设计</button>}</footer>
    </dialog>
  );
}

export function VisualDesignLibrary({ busy, projectId, onStart, onFilesChanged }: {
  busy: boolean;
  projectId: string;
  onStart: (prompt: string, title: string) => Promise<void>;
  onFilesChanged?: () => void | Promise<void>;
}) {
  const [catalog, setCatalog] = useState<VisualCatalog | null>(null);
  const [status, setStatus] = useState<VisualStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState<LibraryTab>("templates");
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [workspace, setWorkspace] = useState<"library" | "recolor">("recolor");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void request({ type: "visual.catalog" }).then((result) => {
      if (!result.visualCatalog) throw new Error("未找到可视化资源目录。");
      if (active) setCatalog(result.visualCatalog);
    }).catch((error) => {
      if (active) setError(error instanceof Error ? error.message : "资源加载失败。");
    }).finally(() => { if (active) setLoading(false); });
    void request({ type: "visual.status" }).then((result) => {
      if (active) setStatus(result.visualStatus ?? null);
    }).catch(() => {
      if (active) setStatus({ available: false, label: "暂时无法读取绘图运行环境" });
    });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => { setPage(0); }, [tab, query, family]);
  const families = useMemo(() => [...new Set(catalog?.templates.map((item) => item.family) ?? [])].sort(), [catalog]);
  const items = useMemo(() => {
    if (!catalog) return [];
    const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return catalog[tab].filter((item) => {
      if (tab === "templates" && family && (item as VisualTemplate).family !== family) return false;
      const content = Object.values(item).flat().filter((value) => typeof value === "string").join(" ").toLocaleLowerCase();
      return tokens.every((token) => content.includes(token));
    });
  }, [catalog, tab, query, family]);
  function choose(item: VisualTemplate | VisualPalette | VisualReference | VisualGrammarEntry) {
    setSelection({ type: tab, item } as Selection);
  }
  return (
    <>
      <div className="visual-workspace-host" hidden={workspace !== "recolor"}>
        <ImageRecolorWorkspace
          projectId={projectId}
          palettes={catalog?.palettes ?? []}
          onBack={() => setWorkspace("library")}
          onSaved={() => void onFilesChanged?.()}
        />
      </div>
      {workspace === "library" && <div className="visual-library">
      <header className="visual-library-header"><div><div className="visual-eyebrow"><Grid2X2 size={13} />NEXIOM / VISUAL DESIGN</div><h1>让数据表达更清楚</h1><p>从绘图模板出发，为你的研究选择合适的图形、布局与配色。</p></div><span className="visual-library-mark" aria-hidden="true"><ChartNoAxesCombined size={38} /></span></header>
      <button type="button" className="visual-tool-entry" onClick={() => setWorkspace("recolor")}>
        <span className="visual-tool-entry-icon"><Pipette size={20} /></span>
        <span><strong>返回可视化工作台</strong><small>继续使用画布、图片换色与图像调整工具</small></span>
        <span className="visual-tool-entry-action">返回工作台<ArrowRight size={15} /></span>
      </button>
      <div className="visual-library-info"><span><span className={`status-dot ${status?.available ? "ready" : ""}`} />{status?.label ?? "正在检查绘图运行环境"}</span><span>本地资源库{catalog ? ` · ${catalog.version}` : ""}</span></div>
      <div className="visual-library-toolbar">
        <div className="visual-library-tabs" role="tablist" aria-label="可视化资源类型">{tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`visual-tab-${id}`} aria-selected={tab === id} aria-controls="visual-library-results" className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={15} /><span>{label}</span>{catalog && <small>{catalog.counts[id]}</small>}</button>)}</div>
        <div className="visual-library-filters"><label className="visual-search"><Search size={16} /><input aria-label="搜索可视化资源" placeholder="搜索名称、用途或关键词" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button>}</label>{tab === "templates" && families.length > 1 && <select aria-label="筛选模板分类" value={family} onChange={(event) => setFamily(event.target.value)}><option value="">所有分类</option>{families.map((value) => <option key={value} value={value}>{value}</option>)}</select>}</div>
      </div>
      <div id="visual-library-results" role="tabpanel" aria-labelledby={`visual-tab-${tab}`} aria-busy={loading}>
        {loading ? <div className="visual-library-empty" role="status"><LoaderCircle size={26} className="spin" /><h2>正在载入可视化资源</h2><p>读取模板、配色与参考图库</p></div> : error ? <div className="visual-library-empty" role="alert"><BookOpen size={28} /><h2>资源库暂时无法打开</h2><p>{error}</p><button className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重新加载</button></div> : <>
          <div className="visual-results-summary"><span>{query || family ? `找到 ${items.length} 项资源` : `${tabs.find((item) => item.id === tab)?.label} · ${items.length}`}</span><span>{tab === "templates" ? "选择模板，查看数据要求与适用条件" : tab === "references" ? "点击参考图，查看细节与设计方向" : tab === "palettes" ? "选择配色，应用于新的图表设计" : "已标明可执行模板与仅供查阅的图种"}</span></div>
          {!items.length ? <div className="visual-library-empty"><Search size={27} /><h2>没有找到匹配的资源</h2><p>试试更短的关键词，或切换资源类型。</p>{(query || family) && <button className="secondary-button" onClick={() => { setQuery(""); setFamily(""); }}>清除筛选</button>}</div> : <div className={`visual-grid ${tab === "grammar" ? "visual-grammar-grid" : ""}`}>{items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => <button key={item.id} type="button" className={`visual-card visual-card-${tab}`} onClick={() => choose(item)}>
            {tab === "templates" && <TemplateDiagram item={item as VisualTemplate} />}
            {tab === "references" && <ReferenceImage item={item as VisualReference} />}
            {tab === "palettes" && <Swatches colors={(item as VisualPalette).colors} />}
            <div className="visual-card-content"><div className="visual-card-heading"><h2>{item.name}</h2>{tab === "grammar" && <ChevronRight size={16} />}</div><p>{item.description || (tab === "templates" ? (item as VisualTemplate).readerQuestion : item.id)}</p><div className="visual-card-meta">{tab === "templates" ? <><span>{(item as VisualTemplate).family}</span><span className="visual-badge executable">可执行</span></> : tab === "references" ? <><span>{(item as VisualReference).tags.slice(0, 2).join(" · ") || "参考图"}</span><span className="visual-badge">设计参考</span></> : tab === "palettes" ? <><span>{(item as VisualPalette).colors.length} 种颜色</span><ArrowRight size={14} /></> : <><span>{(item as VisualGrammarEntry).nameEn}</span><span className={`visual-badge ${(item as VisualGrammarEntry).status === "executable" ? "executable" : ""}`}>{(item as VisualGrammarEntry).status === "executable" ? "可执行" : "仅索引"}</span></>}</div></div>
          </button>)}</div>}
          {items.length > PAGE_SIZE && <nav className="visual-load-more" aria-label="可视化资源分页"><button className="secondary-button" disabled={page === 0} onClick={() => { setPage((value) => value - 1); document.getElementById("visual-library-results")?.scrollIntoView({ block: "start" }); }}>上一页</button><span>第 {page + 1} / {Math.ceil(items.length / PAGE_SIZE)} 页</span><button className="secondary-button" disabled={(page + 1) * PAGE_SIZE >= items.length} onClick={() => { setPage((value) => value + 1); document.getElementById("visual-library-results")?.scrollIntoView({ block: "start" }); }}>下一页</button></nav>}
        </>}
      </div>
      {selection && <ResourceDetail key={`${selection.type}-${selection.item.id}`} selection={selection} busy={busy} onClose={() => setSelection(null)} onStart={onStart} />}
      </div>}
    </>
  );
}
