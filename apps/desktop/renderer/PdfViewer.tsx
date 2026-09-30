import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Save, FileWarning, Highlighter, List, LoaderCircle, Maximize, Minimize, Minus, MousePointer2, PanelLeft, PenLine, Plus, Search, X } from "lucide-react";
import { AnnotationEditorType, GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer as PdfJsViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import pdfViewerCss from "pdfjs-dist/web/pdf_viewer.css?inline";
import "./pdf-viewer.css";

GlobalWorkerOptions.workerSrc = pdfWorker;
// PDF.js also styles generic names such as .sidebar. Keep every vendor rule,
// including its root variables, inside the viewer so it cannot restyle the app.
const scopedViewerCss = `@scope (.nexiom-pdf) {
${pdfViewerCss.replaceAll(":root", ":scope")}
:scope { color-scheme: inherit; }
}`;
const resources = import.meta.glob<string>([
  "/node_modules/pdfjs-dist/cmaps/*.bcmap",
  "/node_modules/pdfjs-dist/standard_fonts/*.{ttf,pfb}",
], { query: "?url&no-inline", import: "default", eager: true });

// Resolve bundled font/CMap names, including Chinese PDFs, without remote font requests.
class PdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const directory = kind === "cMapUrl" ? "cmaps" : kind === "standardFontDataUrl" ? "standard_fonts" : "";
    const url = resources["/node_modules/pdfjs-dist/" + directory + "/" + filename];
    if (!directory || !url) throw new Error("PDF 内置资源不可用");
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF 内置资源读取失败");
    return new Uint8Array(await response.arrayBuffer());
  }
}

interface PdfViewerProps { base64: string; title: string; className?: string; onClose?: () => void; onQuote?: (quote: string) => void; onSave?: (base64: string) => Promise<void> }
type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>;
type PdfSession = { viewer: PdfJsViewer; bus: EventBus; link: PDFLinkService; document?: PDFDocumentProxy };

function Thumbnail({ pdf, number, active, onSelect }: { pdf: PDFDocumentProxy; number: number; active: boolean; onSelect: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setVisible(true); }, { rootMargin: "200px" });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let task: RenderTask | undefined;
    void pdf.getPage(number).then(page => {
      if (stopped || !canvas.current) return;
      const viewport = page.getViewport({ scale: 130 / page.getViewport({ scale: 1 }).width });
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      task = page.render({ canvas: canvas.current, viewport });
      return task.promise;
    }).catch(() => {});
    return () => { stopped = true; task?.cancel(); };
  }, [pdf, number, visible]);
  return <button ref={root} type="button" className={"nexiom-pdf-thumbnail" + (active ? " active" : "")} aria-label={"转到第 " + number + " 页"} aria-current={active ? "page" : undefined} onClick={onSelect}>
    <canvas ref={canvas} /><span>{number}</span>
  </button>;
}

function OutlineItems({ items, link }: { items: Outline; link: PDFLinkService }) {
  return <ul>{items.map((item, index) => <li key={index}>
    <button type="button" disabled={!item.dest} onClick={() => { if (item.dest) void link.goToDestination(item.dest); }}>{item.title || "未命名章节"}</button>
    {!!item.items.length && <OutlineItems items={item.items} link={link} />}
  </li>)}</ul>;
}

export function PdfViewer({ base64, title, className = "", onClose, onQuote, onSave }: PdfViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const viewerElement = useRef<HTMLDivElement>(null);
  const session = useRef<PdfSession | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [scale, setScale] = useState(1);
  const [zoom, setZoom] = useState("auto");
  const [side, setSide] = useState<"pages" | "outline" | null>(null);
  const [outline, setOutline] = useState<Outline>([]);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState({ current: 0, total: 0 });
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [editor, setEditor] = useState<number>(AnnotationEditorType.NONE);
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number }>();
  useEffect(() => {
    const selected = () => {
      const value = window.getSelection();
      if (!value || value.isCollapsed || !value.rangeCount || !container.current?.contains(value.anchorNode) || !container.current?.contains(value.focusNode)) { setSelection(undefined); return; }
      const text = value.toString().trim();
      const rect = value.getRangeAt(0).getBoundingClientRect();
      const bounds = root.current!.getBoundingClientRect();
      setSelection(text ? { text: text.slice(0, 3500), x: Math.max(8, Math.min(rect.left - bounds.left, bounds.width - 210)), y: Math.max(42, rect.top - bounds.top - 42) } : undefined);
    };
    document.addEventListener("selectionchange", selected);
    return () => document.removeEventListener("selectionchange", selected);
  }, [base64]);

  useEffect(() => {
    if (!container.current || !viewerElement.current) return;
    let disposed = false;
    setPdf(null); setError(""); setNotice(""); setOutline([]); setPageNumber(1); setPageDraft("1");
    setQuery(""); setMatches({ current: 0, total: 0 }); setZoom("auto"); setEditor(AnnotationEditorType.NONE);
    const abort = new AbortController();
    const bus = new EventBus();
    const link = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer" });
    const find = new PDFFindController({ eventBus: bus, linkService: link });
    const viewer = new PdfJsViewer({ container: container.current, viewer: viewerElement.current, eventBus: bus, linkService: link,
      findController: find, annotationEditorMode: AnnotationEditorType.NONE,
      annotationEditorHighlightColors: "yellow=#fff066,green=#a8ef9e,blue=#92c5ff,pink=#ffb5d4,red=#ffa19c", enableAutoLinking: false });
    link.setViewer(viewer);
    const current: PdfSession = { viewer, bus, link };
    session.current = current;
    bus.on("pagesinit", () => { if (!disposed) { viewer.currentScaleValue = "auto"; viewer.update(); } }, { signal: abort.signal });
    bus.on("pagechanging", ({ pageNumber: next }: { pageNumber: number }) => { if (!disposed) { setPageNumber(next); setPageDraft(String(next)); } }, { signal: abort.signal });
    bus.on("scalechanging", ({ scale: next, presetValue }: { scale: number; presetValue?: string }) => { if (!disposed) { setScale(next); setZoom(presetValue || String(next)); } }, { signal: abort.signal });
    bus.on("updatefindmatchescount", ({ matchesCount }: { matchesCount: typeof matches }) => { if (!disposed) setMatches(matchesCount); }, { signal: abort.signal });
    bus.on("updatefindcontrolstate", ({ matchesCount }: { matchesCount: typeof matches }) => { if (!disposed && matchesCount) setMatches(matchesCount); }, { signal: abort.signal });
    bus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => { if (!disposed) setEditor(mode); }, { signal: abort.signal });
    bus.on("pagerendered", ({ error: failure }: { error?: Error }) => { if (!disposed && failure) setNotice("部分页面无法渲染，请下载原文件核对。"); }, { signal: abort.signal });
    const resize = new ResizeObserver(() => {
      if (disposed || !current.document) return;
      if (["page-width", "page-fit", "auto"].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
      viewer.update();
    });
    resize.observe(container.current);
    // React wheel listeners are passive; use a local non-passive listener so
    // Ctrl+wheel zooms the document at the pointer without zooming the app.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (!current.document || !event.deltaY) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.current!.clientHeight : 1;
      const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
      const next = Math.min(10, Math.max(0.1, viewer.currentScale * Math.exp(-delta * 0.002)));
      viewer.updateScale({ scaleFactor: next / viewer.currentScale, origin: [event.clientX, event.clientY], drawingDelay: 100 });
    };
    root.current?.addEventListener("wheel", wheel, { passive: false, signal: abort.signal });
    let task: ReturnType<typeof getDocument> | undefined;
    try {
      const binary = atob(base64);
      task = getDocument({ data: Uint8Array.from(binary, char => char.charCodeAt(0)), BinaryDataFactory: PdfBinaryDataFactory, useWorkerFetch: false, useWasm: false });
      void task.promise.then(async document => {
        if (disposed) return;
        current.document = document;
        link.setDocument(document); viewer.setDocument(document); setPdf(document);
        const items = await document.getOutline();
        if (!disposed) setOutline(items ?? []);
      }).catch(failure => { if (!disposed) setError(failure instanceof Error ? failure.message : "PDF 读取失败"); });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "PDF 数据无效"); }
    return () => {
      disposed = true; abort.abort(); resize.disconnect(); session.current = null;
      // Detaching cancels PDF.js page, text and editor listeners.
      viewer.setDocument(null as unknown as PDFDocumentProxy); link.setDocument(null);
      void task?.destroy();
    };
  }, [base64]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => { if (finding) searchInput.current?.focus(); }, [finding]);
  useEffect(() => { if (finding && pdf) findText(false, false); }, [query, caseSensitive, pdf, finding]);

  function findText(previous: boolean, again = true) {
    session.current?.bus.dispatch("find", { source: root.current, type: again ? "again" : "", query, caseSensitive, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }
  function goToPage(number: number) {
    if (!pdf || !Number.isFinite(number)) return;
    session.current!.viewer.currentPageNumber = Math.min(pdf.numPages, Math.max(1, Math.trunc(number)));
    setPageDraft(String(session.current!.viewer.currentPageNumber));
  }
  function setEditorMode(mode: number) {
    if (!session.current?.document) return;
    try { session.current.viewer.annotationEditorMode = { mode }; setEditor(mode); }
    catch { setNotice("此 PDF 暂不支持批注。"); }
  }
  async function download(save = false) {
    const current = session.current;
    if (!current?.document) return;
    setSaving(true); setNotice("");
    try {
      current.viewer.annotationEditorMode = { mode: AnnotationEditorType.NONE };
      const bytes = await current.document.saveDocument();
      if (session.current !== current) return;
      if (save && onSave) {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await onSave(btoa(binary)); setNotice("批注 PDF 已保存到项目。"); return;
      }
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = title.replace(/\.pdf$/i, "") + (current.document.annotationStorage.size ? "-批注" : "") + ".pdf";
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setNotice(`PDF 保存失败：${error instanceof Error ? error.message : "请重试"}`); }
    finally { setSaving(false); }
  }
  const button = (label: string, icon: ReactNode, action: () => void, disabled = !pdf, active?: boolean) =>
    <button type="button" title={label} aria-label={label} disabled={disabled} aria-pressed={active} onClick={action}>{icon}</button>;

  return <div ref={root} className={"pdf-viewer nexiom-pdf " + className} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); setFinding(true); }
    if (event.key === "Escape" && finding) { setFinding(false); session.current?.bus.dispatch("findbarclose", { source: root.current }); }
  }} tabIndex={-1} aria-label={`${title} PDF 查看器`}>
    <style>{scopedViewerCss}</style>
    {selection && <div className="pdf-selection-menu" style={{ left: selection.x, top: selection.y }} onPointerDown={event => event.preventDefault()}>
      <button onClick={() => void navigator.clipboard.writeText(selection.text).catch(() => setNotice("复制失败，请使用 Ctrl+C。"))}>复制</button>
      {onQuote && <button onClick={() => { onQuote(`> ${selection.text.replaceAll("\n", "\n> ")}\n\n`); setSelection(undefined); }}>在对话中聊聊</button>}
    </div>}
    <div className="nexiom-pdf-toolbar" role="toolbar" aria-label="PDF 查看工具">
      <div className="nexiom-pdf-tools-left">
        {onSave && button("保存批注到项目", saving ? <LoaderCircle size={17} /> : <Save size={17} />, () => void download(true), !pdf || saving)}
        <div className="nexiom-pdf-group">
        {button("文档目录", <List size={17} />, () => setSide(side === "outline" ? null : "outline"), !pdf, side === "outline")}
        {button("页面缩略图", <PanelLeft size={17} />, () => setSide(side === "pages" ? null : "pages"), !pdf, side === "pages")}
        </div>
        <div className="nexiom-pdf-group">
          {button("选择文字", <MousePointer2 size={17} />, () => setEditorMode(AnnotationEditorType.NONE), !pdf, editor === AnnotationEditorType.NONE)}
          {button("高亮批注", <Highlighter size={17} />, () => setEditorMode(AnnotationEditorType.HIGHLIGHT), !pdf, editor === AnnotationEditorType.HIGHLIGHT)}
          {button("手绘批注", <PenLine size={17} />, () => setEditorMode(AnnotationEditorType.INK), !pdf, editor === AnnotationEditorType.INK)}
        </div>
      </div>
      <div className="nexiom-pdf-tools-center">
      <div className="nexiom-pdf-group">
        {button("上一页", <ChevronLeft size={17} />, () => goToPage(pageNumber - 1), !pdf || pageNumber <= 1)}
        <input aria-label="PDF 页码" type="number" min={1} max={pdf?.numPages ?? 1} value={pageDraft} disabled={!pdf}
          onChange={event => setPageDraft(event.target.value)} onBlur={() => goToPage(Number(pageDraft))} onKeyDown={event => { if (event.key === "Enter") goToPage(Number(pageDraft)); }} />
        <span className="nexiom-pdf-count">/ {pdf?.numPages ?? "-"}</span>
        {button("下一页", <ChevronRight size={17} />, () => goToPage(pageNumber + 1), !pdf || pageNumber >= pdf.numPages)}
      </div>
      <div className="nexiom-pdf-group">
        {button("缩小 PDF", <Minus size={17} />, () => session.current?.viewer.decreaseScale(), !pdf || scale <= 0.1)}
        <select aria-label="PDF 缩放" disabled={!pdf} value={zoom} onChange={event => { if (session.current) session.current.viewer.currentScaleValue = event.target.value; }}>
          <option value="auto">自动</option><option value="page-width">适合宽度</option><option value="page-fit">适合页面</option>
          {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map(value => <option key={value} value={String(value)}>{value * 100}%</option>)}
          {!["auto", "page-width", "page-fit", "0.5", "0.75", "1", "1.25", "1.5", "2", "3", "4"].includes(zoom) && <option value={zoom}>{Math.round(scale * 100)}%</option>}
        </select>
        {button("放大 PDF", <Plus size={17} />, () => session.current?.viewer.increaseScale(), !pdf || scale >= 10)}
      </div>
      </div>
      <div className="nexiom-pdf-group nexiom-pdf-actions">
        {button("搜索 PDF", <Search size={17} />, () => { setFinding(!finding); if (finding) session.current?.bus.dispatch("findbarclose", { source: root.current }); }, !pdf, finding)}
        {button("下载 PDF（含批注）", saving ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />, () => void download(), !pdf || saving)}
        {button(fullscreen ? "退出全屏" : "全屏阅读", fullscreen ? <Minimize size={17} /> : <Maximize size={17} />, () => {
          void (fullscreen ? document.exitFullscreen() : root.current?.requestFullscreen())?.catch(() => setNotice("当前窗口无法进入全屏。"));
        }, false)}
        {onClose && button("关闭 PDF", <X size={17} />, onClose, false)}
      </div>
    </div>
    {finding && <div className="nexiom-pdf-find" role="search">
      <input ref={searchInput} aria-label="查找文档文字" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") findText(event.shiftKey); }} />
      <span role="status">{query ? matches.current + " / " + matches.total : ""}</span>
      {button("上一个匹配", <ChevronUp size={16} />, () => findText(true), !query)}
      {button("下一个匹配", <ChevronDown size={16} />, () => findText(false), !query)}
      <label><input type="checkbox" checked={caseSensitive} onChange={event => setCaseSensitive(event.target.checked)} />区分大小写</label>
      {button("关闭搜索", <X size={16} />, () => { setFinding(false); session.current?.bus.dispatch("findbarclose", { source: root.current }); }, false)}
    </div>}
    {notice && <div className="nexiom-pdf-notice" data-success={notice === "批注 PDF 已保存到项目。"} role="status">{notice}</div>}
    <div className="nexiom-pdf-body">
      {side && <aside className="nexiom-pdf-sidebar" aria-label={side === "pages" ? "页面缩略图" : "文档目录"}>
        {side === "pages" && pdf && Array.from({ length: pdf.numPages }, (_, index) => <Thumbnail key={index} pdf={pdf} number={index + 1} active={pageNumber === index + 1} onSelect={() => goToPage(index + 1)} />)}
        {side === "outline" && (outline.length && session.current ? <OutlineItems items={outline} link={session.current.link} /> : <p>此文档没有目录</p>)}
      </aside>}
      <div className="nexiom-pdf-stage">
        <div ref={container} className="nexiom-pdf-scroll" tabIndex={0} aria-label={title + " 正文"}><div ref={viewerElement} className="pdfViewer" /></div>
        {error ? <div className="nexiom-pdf-state" role="alert"><FileWarning size={24} /><span>无法显示 PDF：{error}</span></div>
          : !pdf && <div className="nexiom-pdf-state"><LoaderCircle className="spin" size={24} /><span>正在解析 PDF</span></div>}
      </div>
    </div>
  </div>;
}
