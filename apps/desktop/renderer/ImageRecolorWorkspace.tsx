import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BookOpen,
  Download,
  Eye,
  FolderOpen,
  Image as ImageIcon,
  Images,
  LoaderCircle,
  Minus,
  Palette,
  Pipette,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Undo2,
  Upload,
} from "lucide-react";
import type {
  FileContent,
  ProjectFile,
  VisualPalette,
  VisualReference,
} from "../../../packages/contracts";
import {
  applyImageAdjustments,
  applyRecolorOperation,
  createRecolorSelection,
  MAX_RECOLOR_PIXELS,
  replayRecolorOperations,
  type ImageAdjustments,
  type PixelBounds,
  type RecolorOperation,
} from "./image-recolor";
import { request } from "./bridge";
import "./visual-design.css";

type RecolorMode = "connected" | "global";
type SourceTab = "project" | "library";
type EditorTool = "recolor" | "adjust";
type LoadedPixels = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
};
type ImageSource = {
  id: string;
  kind: SourceTab | "local";
  name: string;
  detail: string;
  path?: string;
  assetId?: string;
};
type Selection = {
  x: number;
  y: number;
  source: string;
  selectedPixels: number;
  bounds: PixelBounds | null;
};

export interface ImageRecolorWorkspaceProps {
  projectId: string;
  palettes: VisualPalette[];
  onBack: () => void;
  onSaved?: (path: string) => void;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SOURCE_RESULT_LIMIT = 80;
const galleryAssetCache = new Map<string, Promise<string>>();

function message(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function imageDataUrl(file: FileContent): string {
  if (!file.base64 || !file.mime.startsWith("image/"))
    throw new Error("图片内容无法读取，请确认文件格式后重试。");
  return `data:${file.mime};base64,${file.base64}`;
}

function loadGalleryAsset(assetId: string) {
  let pending = galleryAssetCache.get(assetId);
  if (!pending) {
    pending = request({ type: "visual.asset", assetId }).then(({ file }) => {
      if (!file) throw new Error("图库图片不存在。");
      return imageDataUrl(file);
    });
    galleryAssetCache.set(assetId, pending);
    if (galleryAssetCache.size > 40)
      galleryAssetCache.delete(galleryAssetCache.keys().next().value!);
    void pending.catch(() => galleryAssetCache.delete(assetId));
  }
  return pending;
}

function decodeImage(url: string): Promise<LoadedPixels> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) throw new Error("图片尺寸无效。");
        if (width > 12_000 || height > 12_000)
          throw new Error("图片单边不能超过 12,000 像素。");
        if (width * height > MAX_RECOLOR_PIXELS)
          throw new Error(`图片共有 ${(width * height).toLocaleString()} 像素，当前上限为 ${MAX_RECOLOR_PIXELS.toLocaleString()} 像素。`);
        const surface = document.createElement("canvas");
        surface.width = width;
        surface.height = height;
        const context = surface.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("当前设备无法创建图片画布。");
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, width, height);
        resolve({ pixels: data.data, width, height });
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error("图片画布创建失败。"));
      }
    };
    image.onerror = () => reject(new Error("图片解码失败，请改用 PNG、JPEG 或 WebP。"));
    image.src = url;
  });
}

function paintCanvas(canvas: HTMLCanvasElement | null, image: LoadedPixels | null) {
  if (!canvas || !image) return;
  if (canvas.width !== image.width) canvas.width = image.width;
  if (canvas.height !== image.height) canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height),
    0,
    0,
  );
}

function pixelHex(image: LoadedPixels, x: number, y: number) {
  const index = (y * image.width + x) * 4;
  return `#${[image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function outputStem(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "edited";
}

async function pngBase64(image: LoadedPixels) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  paintCanvas(canvas, image);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 编码失败。")), "image/png");
  });
  if (blob.size > 20 * 1024 * 1024)
    throw new Error("导出的 PNG 超过 20 MB，请先缩小图片尺寸。");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("PNG 数据读取失败。"));
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

function GalleryThumbnail({ source }: { source: ImageSource }) {
  const container = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    let started = false;
    const load = () => {
      if (started || !source.assetId) return;
      started = true;
      void loadGalleryAsset(source.assetId).then((value) => {
        if (active) setUrl(value);
      }).catch(() => {});
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load();
    }, { rootMargin: "120px" });
    if (container.current) observer.observe(container.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [source.assetId]);
  return (
    <span ref={container} className="recolor-source-thumb" aria-hidden="true">
      {url ? <img src={url} alt="" /> : <ImageIcon size={17} />}
    </span>
  );
}

export function ImageRecolorWorkspace({
  projectId,
  palettes,
  onBack,
  onSaved,
}: ImageRecolorWorkspaceProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const localPicker = useRef<HTMLInputElement>(null);
  const original = useRef<LoadedPixels | null>(null);
  const recolored = useRef<LoadedPixels | null>(null);
  const working = useRef<LoadedPixels | null>(null);
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [references, setReferences] = useState<VisualReference[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourceTab, setSourceTab] = useState<SourceTab>("project");
  const [sourceQuery, setSourceQuery] = useState("");
  const [activeSource, setActiveSource] = useState<ImageSource | null>(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [error, setError] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<RecolorOperation[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<RecolorMode>("connected");
  const [tolerance, setTolerance] = useState(8);
  const [paletteId, setPaletteId] = useState(palettes[0]?.id ?? "");
  const [zoom, setZoom] = useState(1);
  const [comparing, setComparing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [lastChanged, setLastChanged] = useState(0);
  const [tool, setTool] = useState<EditorTool>("recolor");
  const [adjustments, setAdjustments] = useState<Required<ImageAdjustments>>({
    brightness: 0,
    contrast: 0,
    saturation: 0,
  });

  useEffect(() => {
    if (!palettes.some((palette) => palette.id === paletteId))
      setPaletteId(palettes[0]?.id ?? "");
  }, [paletteId, palettes]);

  useEffect(() => {
    let active = true;
    setSourcesLoading(true);
    void Promise.all([
      request({ type: "project.files", projectId }),
      request({ type: "visual.catalog" }),
    ]).then(([files, catalog]) => {
      if (!active) return;
      setProjectFiles((files.files ?? []).filter((file) => IMAGE_EXTENSIONS.has(file.extension)));
      setReferences((catalog.visualCatalog?.references ?? []).filter((item) => !!item.assetId));
    }).catch((cause) => {
      if (active) setError(message(cause, "图片来源读取失败。"));
    }).finally(() => {
      if (active) setSourcesLoading(false);
    });
    return () => { active = false; };
  }, [projectId]);

  const projectSources = useMemo<ImageSource[]>(() => projectFiles.map((file) => ({
    id: `project:${file.path}`,
    kind: "project",
    name: file.name,
    detail: file.path,
    path: file.path,
  })), [projectFiles]);
  const librarySources = useMemo<ImageSource[]>(() => references.map((item) => ({
    id: `library:${item.id}`,
    kind: "library",
    name: item.name,
    detail: item.tags.slice(0, 2).join(" · ") || "参考图库",
    assetId: item.assetId ?? undefined,
  })), [references]);
  const visibleSources = useMemo(() => {
    const query = sourceQuery.trim().toLocaleLowerCase();
    const sources = sourceTab === "project" ? projectSources : librarySources;
    if (!query) return sources;
    return sources.filter((source) => `${source.name} ${source.detail}`.toLocaleLowerCase().includes(query));
  }, [librarySources, projectSources, sourceQuery, sourceTab]);
  const displayedSources = visibleSources.slice(0, SOURCE_RESULT_LIMIT);
  const activePalette = palettes.find((palette) => palette.id === paletteId) ?? palettes[0];

  useEffect(() => {
    paintCanvas(canvas.current, comparing ? original.current : working.current);
  }, [comparing, revision]);

  const installWorking = useCallback((pixels: Uint8ClampedArray, changed = 0) => {
    const source = original.current;
    if (!source) return;
    working.current = {
      pixels: new Uint8ClampedArray(pixels),
      width: source.width,
      height: source.height,
    };
    setLastChanged(changed);
    setRevision((value) => value + 1);
  }, []);

  const inspectSelection = useCallback((x: number, y: number, nextTolerance = tolerance, nextMode = mode) => {
    const image = recolored.current;
    if (!image) return;
    const source = pixelHex(image, x, y);
    const inspected = createRecolorSelection(image.pixels, image.width, image.height, {
      x,
      y,
      tolerance: nextTolerance,
      mode: nextMode,
      feather: 0,
    });
    setSelection({ x, y, source, selectedPixels: inspected.selectedPixels, bounds: inspected.bounds });
  }, [mode, tolerance]);

  function activateImage(source: ImageSource, decoded: LoadedPixels) {
    original.current = {
      pixels: new Uint8ClampedArray(decoded.pixels),
      width: decoded.width,
      height: decoded.height,
    };
    recolored.current = {
      pixels: new Uint8ClampedArray(decoded.pixels),
      width: decoded.width,
      height: decoded.height,
    };
    working.current = {
      pixels: new Uint8ClampedArray(decoded.pixels),
      width: decoded.width,
      height: decoded.height,
    };
    setActiveSource(source);
    setHistory([]);
    setCursor(0);
    setSelection(null);
    setLastChanged(0);
    setComparing(false);
    setZoom(1);
    setAdjustments({ brightness: 0, contrast: 0, saturation: 0 });
    setRevision((value) => value + 1);
  }

  async function openSource(source: ImageSource) {
    if (loadingImage) return;
    setLoadingImage(true);
    setError("");
    setSavedPath("");
    try {
      const file = source.kind === "project"
        ? (await request({ type: "visual.image.read", projectId, path: source.path! })).file
        : (await request({ type: "visual.asset", assetId: source.assetId! })).file;
      if (!file) throw new Error("图片内容不存在。");
      const decoded = await decodeImage(imageDataUrl(file));
      activateImage(source, decoded);
    } catch (cause) {
      setError(message(cause, "图片打开失败。"));
    } finally {
      setLoadingImage(false);
    }
  }

  async function openLocalFile(file: File | undefined) {
    if (!file || loadingImage) return;
    setLoadingImage(true);
    setError("");
    setSavedPath("");
    try {
      if (!(["image/png", "image/jpeg", "image/webp"].includes(file.type)))
        throw new Error("本地图片仅支持 PNG、JPEG 和 WebP。");
      if (file.size > 20 * 1024 * 1024)
        throw new Error("本地图片不能超过 20 MB。");
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("本地图片读取失败。"));
        reader.readAsDataURL(file);
      });
      const decoded = await decodeImage(dataUrl);
      activateImage({
        id: `local:${file.name}:${file.lastModified}`,
        kind: "local",
        name: file.name,
        detail: "本地图片",
      }, decoded);
    } catch (cause) {
      setError(message(cause, "本地图片打开失败。"));
    } finally {
      setLoadingImage(false);
      if (localPicker.current) localPicker.current.value = "";
    }
  }

  function selectPixel(event: React.MouseEvent<HTMLCanvasElement>) {
    const image = recolored.current;
    if (!image || comparing || tool !== "recolor") return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(image.width - 1, Math.floor((event.clientX - bounds.left) * image.width / bounds.width)));
    const y = Math.max(0, Math.min(image.height - 1, Math.floor((event.clientY - bounds.top) * image.height / bounds.height)));
    inspectSelection(x, y);
  }

  function updateTolerance(value: number) {
    setTolerance(value);
  }

  function commitTolerance() {
    if (selection) inspectSelection(selection.x, selection.y, tolerance, mode);
  }

  function updateMode(value: RecolorMode) {
    setMode(value);
    if (selection) inspectSelection(selection.x, selection.y, tolerance, value);
  }

  function applyColor(target: string) {
    const image = recolored.current;
    if (!image || !selection) return;
    setError("");
    const operation: RecolorOperation = {
      x: selection.x,
      y: selection.y,
      target,
      tolerance,
      mode,
      feather: 0.45,
    };
    try {
      const result = applyRecolorOperation(image.pixels, image.width, image.height, operation);
      const nextHistory = [...history.slice(0, cursor), operation];
      setHistory(nextHistory);
      setCursor(nextHistory.length);
      recolored.current = { pixels: result.pixels, width: image.width, height: image.height };
      const adjusted = applyImageAdjustments(result.pixels, image.width, image.height, adjustments);
      installWorking(adjusted.pixels, result.changedPixels);
      const nextImage = { pixels: result.pixels, width: image.width, height: image.height };
      setSelection({
        ...selection,
        source: pixelHex(nextImage, selection.x, selection.y),
        selectedPixels: result.selectedPixels,
        bounds: result.bounds,
      });
      setSavedPath("");
    } catch (cause) {
      setError(message(cause, "颜色替换失败。"));
    }
  }

  function moveHistory(nextCursor: number) {
    const source = original.current;
    if (!source) return;
    try {
      const result = replayRecolorOperations(
        source.pixels,
        source.width,
        source.height,
        history.slice(0, nextCursor),
      );
      recolored.current = { pixels: result.pixels, width: source.width, height: source.height };
      const adjusted = applyImageAdjustments(result.pixels, source.width, source.height, adjustments);
      setCursor(nextCursor);
      setSelection(null);
      installWorking(adjusted.pixels, result.changedPixels);
      setSavedPath("");
    } catch (cause) {
      setError(message(cause, "历史记录恢复失败。"));
    }
  }

  function updateAdjustment(name: keyof Required<ImageAdjustments>, value: number) {
    if (!recolored.current) return;
    setAdjustments((current) => ({ ...current, [name]: value }));
    setSelection(null);
    setSavedPath("");
  }

  function resetAdjustments() {
    if (!recolored.current) return;
    setAdjustments({ brightness: 0, contrast: 0, saturation: 0 });
    setSavedPath("");
  }

  useEffect(() => {
    const image = recolored.current;
    if (!image) return;
    const timeout = window.setTimeout(() => {
      const result = applyImageAdjustments(image.pixels, image.width, image.height, adjustments);
      installWorking(result.pixels, result.changedPixels);
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [adjustments, cursor, installWorking]);

  async function saveImage() {
    const image = recolored.current;
    if (!image || !activeSource || saving) return;
    setSaving(true);
    setError("");
    try {
      const finalImage = applyImageAdjustments(image.pixels, image.width, image.height, adjustments);
      const base64 = await pngBase64({ pixels: finalImage.pixels, width: image.width, height: image.height });
      const result = await request({
        type: "visual.image.save",
        projectId,
        name: `${outputStem(activeSource.name)}-edited.png`,
        base64,
      });
      if (!result.savedPath) throw new Error("导出完成，但没有返回保存位置。");
      setSavedPath(result.savedPath);
      onSaved?.(result.savedPath);
      const refreshed = await request({ type: "project.files", projectId });
      setProjectFiles((refreshed.files ?? []).filter((file) => IMAGE_EXTENSIONS.has(file.extension)));
    } catch (cause) {
      setError(message(cause, "PNG 导出失败。"));
    } finally {
      setSaving(false);
    }
  }

  const dimensions = working.current ? `${working.current.width} x ${working.current.height}` : "";
  return (
    <div className="image-recolor-workspace">
      <header className="recolor-header">
        <button type="button" className="recolor-resource-button" onClick={onBack}><BookOpen size={16} />资源库</button>
        <div className="recolor-title">
          <span>可视化工作台</span>
          <small>{activeSource ? activeSource.name : "选择项目、图库或本地图片"}</small>
        </div>
        <div className="recolor-tool-switch" role="tablist" aria-label="画布工具">
          <button type="button" role="tab" aria-selected={tool === "recolor"} className={tool === "recolor" ? "active" : ""} onClick={() => setTool("recolor")}><Pipette size={15} />换色</button>
          <button type="button" role="tab" aria-selected={tool === "adjust"} className={tool === "adjust" ? "active" : ""} onClick={() => { setTool("adjust"); setSelection(null); }}><SlidersHorizontal size={15} />调整</button>
        </div>
        <div className="recolor-header-actions">
          <button type="button" className="icon-button" aria-label="撤销换色" title="撤销换色" disabled={cursor === 0} onClick={() => moveHistory(cursor - 1)}><Undo2 size={18} /></button>
          <button type="button" className="icon-button" aria-label="重做换色" title="重做换色" disabled={cursor >= history.length} onClick={() => moveHistory(cursor + 1)}><Redo2 size={18} /></button>
          <button type="button" className={`recolor-compare ${comparing ? "active" : ""}`} disabled={!working.current} onClick={() => setComparing((value) => !value)}><Eye size={16} />{comparing ? "返回编辑" : "原图对比"}</button>
          <button type="button" className="visual-primary" disabled={!working.current || saving} onClick={() => void saveImage()}>{saving ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}导出 PNG</button>
        </div>
      </header>

      <div className="recolor-body">
        <aside className="recolor-sources" aria-label="图片来源">
          <header><strong>资源</strong><span>{sourceTab === "project" ? projectSources.length : librarySources.length}</span></header>
          <button type="button" className="recolor-local-open" disabled={loadingImage} onClick={() => localPicker.current?.click()}><Upload size={15} />打开本地图片</button>
          <div className="recolor-segmented" role="group" aria-label="选择图片来源">
            <button type="button" className={sourceTab === "project" ? "active" : ""} onClick={() => { setSourceTab("project"); setSourceQuery(""); }}><FolderOpen size={14} />项目</button>
            <button type="button" className={sourceTab === "library" ? "active" : ""} onClick={() => { setSourceTab("library"); setSourceQuery(""); }}><Images size={14} />图库</button>
          </div>
          <label className="recolor-search"><Search size={14} /><input aria-label="搜索图片" placeholder="搜索图片" value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} /></label>
          <div className="recolor-source-list">
            {sourcesLoading ? <div className="recolor-source-empty"><LoaderCircle size={20} className="spin" /><span>正在读取图片</span></div>
              : visibleSources.length === 0 ? <div className="recolor-source-empty"><ImageIcon size={22} /><span>{sourceQuery ? "没有匹配的图片" : sourceTab === "project" ? "项目中没有可换色图片" : "图库暂无图片"}</span></div>
                : displayedSources.map((source) => <button type="button" key={source.id} className={activeSource?.id === source.id ? "active" : ""} disabled={loadingImage} title={source.detail} onClick={() => void openSource(source)}>
                  {source.kind === "library" ? <GalleryThumbnail source={source} /> : <span className="recolor-source-thumb"><ImageIcon size={17} /></span>}
                  <span><strong>{source.name}</strong><small>{source.detail}</small></span>
                </button>)}
            {visibleSources.length > SOURCE_RESULT_LIMIT && <div className="recolor-source-limit">显示前 {SOURCE_RESULT_LIMIT} 项 · 可搜索全部 {visibleSources.length} 项</div>}
          </div>
        </aside>

        <main className="recolor-stage">
          <div className="recolor-stage-toolbar">
            <span>{dimensions || "画布"}</span>
            <div className="recolor-zoom" role="group" aria-label="画布缩放">
              <button type="button" className="icon-button" aria-label="缩小画布" title="缩小" disabled={!working.current || zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}><Minus size={15} /></button>
              <button type="button" disabled={!working.current} onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button type="button" className="icon-button" aria-label="放大画布" title="放大" disabled={!working.current || zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + 0.25))}><Plus size={15} /></button>
            </div>
          </div>
          <div className="recolor-canvas-viewport">
            {!working.current && !loadingImage && <div className="recolor-canvas-empty"><Palette size={32} strokeWidth={1.35} /><strong>选择一张图片开始编辑</strong><span>可使用项目图片、参考图库，也可直接打开本地图片。</span></div>}
            {loadingImage && <div className="recolor-canvas-empty"><LoaderCircle size={28} className="spin" /><strong>正在打开图片</strong></div>}
            <div className={`recolor-canvas-shell ${working.current ? "visible" : ""}`} style={{ width: `${zoom * 100}%` }}>
              <canvas ref={canvas} className={tool === "recolor" ? "picking" : ""} onClick={selectPixel} aria-label="可视化编辑画布" />
              {tool === "recolor" && selection?.bounds && mode === "connected" && working.current && !comparing && <span className="recolor-selection-bounds" style={{ left: `${selection.bounds.x / working.current.width * 100}%`, top: `${selection.bounds.y / working.current.height * 100}%`, width: `${selection.bounds.width / working.current.width * 100}%`, height: `${selection.bounds.height / working.current.height * 100}%` }} />}
              {tool === "recolor" && selection && working.current && !comparing && <span className="recolor-pick-marker" style={{ left: `${(selection.x + 0.5) / working.current.width * 100}%`, top: `${(selection.y + 0.5) / working.current.height * 100}%` }} />}
            </div>
          </div>
          <footer className="recolor-stage-status">
            <span>{comparing ? "正在显示原图" : tool === "adjust" && working.current ? "拖动属性面板中的滑块调整图片" : selection ? `已选择 ${selection.selectedPixels.toLocaleString()} 个像素` : working.current ? "点击图中要换色的元素" : "等待选择图片"}</span>
            <span>{lastChanged > 0 ? `上次改变 ${lastChanged.toLocaleString()} 个像素` : history.length > 0 ? `${cursor} / ${history.length} 步` : ""}</span>
          </footer>
        </main>

        <aside className="recolor-inspector" aria-label="图像属性">
          {tool === "recolor" ? <>
            <section>
              <h2>选区</h2>
              <div className="recolor-selected-color">
                <span style={{ backgroundColor: selection?.source ?? "transparent" }} />
                <div><strong>{selection?.source ?? "尚未取色"}</strong><small>{selection ? `${selection.selectedPixels.toLocaleString()} 个像素` : "点击画布中的元素"}</small></div>
              </div>
              <label className="recolor-range"><span>容差 <output>{tolerance}</output></span><input type="range" min="0" max="40" step="1" value={tolerance} disabled={!working.current} onChange={(event) => updateTolerance(Number(event.target.value))} onPointerUp={commitTolerance} onKeyUp={commitTolerance} onBlur={commitTolerance} /></label>
              <div className="recolor-segmented" role="group" aria-label="选择换色范围">
                <button type="button" className={mode === "connected" ? "active" : ""} disabled={!working.current} onClick={() => updateMode("connected")}>连续区域</button>
                <button type="button" className={mode === "global" ? "active" : ""} disabled={!working.current} onClick={() => updateMode("global")}>全图同色</button>
              </div>
            </section>
            <section className="recolor-palette-panel">
              <h2>目标颜色</h2>
              {activePalette ? <>
                <select aria-label="选择色板" value={activePalette.id} onChange={(event) => setPaletteId(event.target.value)}>{palettes.map((palette) => <option key={palette.id} value={palette.id}>{palette.name}</option>)}</select>
                <p>{activePalette.description}</p>
                <div className="recolor-palette-colors">{activePalette.colors.map((color, index) => <button key={`${color}-${index}`} type="button" disabled={!selection || comparing} aria-label={`替换为 ${color}`} title={color} style={{ backgroundColor: color }} onClick={() => applyColor(color)}><span>{color}</span></button>)}</div>
              </> : <div className="recolor-no-palettes">没有可用色板</div>}
            </section>
          </> : <section className="recolor-adjustments">
            <div className="recolor-section-heading"><h2>基础调整</h2><button type="button" className="icon-button" aria-label="重置基础调整" title="重置" disabled={!working.current || Object.values(adjustments).every((value) => value === 0)} onClick={resetAdjustments}><RotateCcw size={15} /></button></div>
            {(["brightness", "contrast", "saturation"] as const).map((name) => <label className="recolor-range" key={name}><span>{{ brightness: "亮度", contrast: "对比度", saturation: "饱和度" }[name]} <output>{adjustments[name]}</output></span><input type="range" min="-100" max="100" step="1" value={adjustments[name]} disabled={!working.current} onChange={(event) => updateAdjustment(name, Number(event.target.value))} /></label>)}
          </section>}
          {(error || savedPath) && <section className={`recolor-notice ${error ? "error" : "success"}`} role={error ? "alert" : "status"}>{error || <>已保存至<br /><code>{savedPath}</code></>}</section>}
        </aside>
      </div>
      <input ref={localPicker} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(event) => void openLocalFile(event.target.files?.[0])} />
    </div>
  );
}
