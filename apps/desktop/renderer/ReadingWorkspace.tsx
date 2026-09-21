import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  CircleDotDashed,
  FileText,
  FileUp,
  History,
  ListChecks,
  MessageSquareText,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Send,
  Square,
  Tags,
} from "lucide-react";
import type { AgentItem, FileContent, Message, ProjectFile, Run } from "../../../packages/contracts";
import { RichText } from "./AgentOutput";
import { PdfViewer } from "./PdfViewer";
import { AgentTaskStatus } from "./AgentTaskStatus";
import { getCurrentAgentTaskKind } from "./agent-task-state";
import { ReadingProgress } from "./ReadingProgress";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { readPreference, writePreference } from "./preferences";

export const READING_TASK_MARKER = "[NEXIOM赛题研读任务]";
export const READING_CORRECTION_MARKER = "[NEXIOM赛题研读纠偏]";

type SectionKind =
  | "overview"
  | "source"
  | "terms"
  | "question"
  | "dependency"
  | "trap"
  | "pending"
  | "delivery"
  | "other";

interface ReadingSection {
  id: string;
  title: string;
  body: string;
  kind: SectionKind;
}

export interface ReadingCorrectionTarget {
  id: string;
  title: string;
}

interface ReadingCorrection {
  id: string;
  targetId: string;
  targetTitle: string;
  text: string;
  createdAt: string;
}


interface ReadingWorkspaceProps {
  projectName: string;
  messages: Message[];
  agentItems: AgentItem[];
  files: ProjectFile[];
  activeRun?: Run;
  latestRun?: Run;
  busy: boolean;
  modelReady: boolean;
  researchEnabled?: boolean;
  onConfigureResearch?: () => void;
  onStart: () => void;
  onCorrect: (correction: string, target: ReadingCorrectionTarget) => void;
  onImport: (selected: FileList | null) => Promise<void>;
  onReadFile: (file: ProjectFile) => Promise<FileContent | undefined>;
  onConfigureModel: () => void;
  onCancel: () => void;
}

function sectionKind(title: string): SectionKind {
  const normalized = title.replace(/[\s·：:、—_-]/g, "").toLowerCase();
  if (/问题[一二三四五六七八九十\d]+/.test(normalized)) return "question";
  if (/逐字|逐句|原题|题干/.test(normalized)) return "source";
  if (/名词|术语|符号|变量|数据|口径|单位/.test(normalized)) return "terms";
  if (/依赖|关系图|承接/.test(normalized)) return "dependency";
  if (/陷阱|误区|风险/.test(normalized)) return "trap";
  if (/待核|歧义|确认|不确定/.test(normalized)) return "pending";
  if (/交付|提交|成果清单/.test(normalized)) return "delivery";
  if (/概览|总体|题意/.test(normalized)) return "overview";
  return "other";
}

function isProblemPdf(file: ProjectFile) {
  const normalizedPath = file.path.replace(/\\/g, "/").toLowerCase();
  return normalizedPath.startsWith("inputs/") && file.extension.toLowerCase() === ".pdf";
}

function sectionId(title: string, index: number) {
  const normalized = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42);
  return normalized || `section-${index}`;
}

export function parseReadingReport(text: string): ReadingSection[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const headings = [...normalized.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (!headings.length) {
    return [{ id: "complete-report-0", title: "完整研读报告", body: normalized, kind: "other" }];
  }
  return headings.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? normalized.length;
    const title = match[1].replace(/^\d+[.、]\s*/, "").trim();
    return {
      id: sectionId(title, index),
      title,
      body: normalized.slice(start, end).trim(),
      kind: sectionKind(title),
    };
  });
}

export function isReadingReport(text: string) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return false;
  if (/^#\s+赛题研读报告\s*$/m.test(normalized)) return true;
  const expectedHeadings = [
    "赛题概览",
    "原题逐字句研读",
    "名词、符号与数据口径",
    "问题依赖关系",
    "可能设置的陷阱",
    "待人工核对",
    "交付清单",
  ];
  return expectedHeadings.filter((heading) => normalized.includes(`## ${heading}`)).length >= 2;
}

function latestReport(messages: Message[], items: AgentItem[], afterSequence: number, excludedRunId?: string) {
  const candidates = [
    ...messages
      .filter((message) =>
        message.sequence > afterSequence &&
        message.role === "assistant" &&
        message.kind !== "progress" &&
        isReadingReport(message.text)
      )
      .map((message) => ({ sequence: message.sequence, text: message.text })),
    ...items.flatMap((record) =>
      record.sequence > afterSequence &&
      record.runId !== excludedRunId && record.status === "completed" &&
      record.item.type === "agent_message" &&
      isReadingReport(record.item.text)
        ? [{ sequence: record.sequence, text: record.item.text }]
        : [],
    ),
  ].sort((left, right) => left.sequence - right.sequence);
  return candidates.at(-1)?.text.trim() ?? "";
}

function extractCorrections(messages: Message[], afterSequence: number): ReadingCorrection[] {
  return messages.flatMap((message) => {
    if (
      message.sequence <= afterSequence ||
      message.role !== "user" ||
      !message.text.startsWith(READING_CORRECTION_MARKER)
    ) return [];
    const target = message.text.match(/【目标板块】\nID: ([^\n]+)\n标题: ([^\n]+)\n\n【人工纠偏】/);
    const correction = message.text.match(/【人工纠偏】\n([\s\S]*?)\n\n【更新要求】/);
    return target && correction?.[1]?.trim()
      ? [{
          id: message.id,
          targetId: target[1].trim(),
          targetTitle: target[2].trim(),
          text: correction[1].trim(),
          createdAt: message.createdAt,
        }]
      : [];
  });
}

const READING_CORRECTION_MIN = 280;
const READING_CORRECTION_MAX = 560;
const READING_CORRECTION_CLOSE = 160;

function initialCorrectionWidth() {
  const stored = Number(readPreference("nexiom.readingCorrectionWidth"));
  return Number.isFinite(stored) && stored > 0
    ? Math.min(READING_CORRECTION_MAX, Math.max(READING_CORRECTION_MIN, stored))
    : 360;
}

function SectionIcon({ kind, size = 16 }: { kind: SectionKind; size?: number }) {
  if (kind === "source") return <BookOpen size={size} />;
  if (kind === "terms") return <Tags size={size} />;
  if (kind === "question") return <ListChecks size={size} />;
  if (kind === "dependency") return <Network size={size} />;
  if (kind === "trap" || kind === "pending") return <AlertTriangle size={size} />;
  if (kind === "delivery") return <CheckCircle2 size={size} />;
  return <FileText size={size} />;
}


export function ReadingWorkspace({
  projectName,
  messages,
  agentItems,
  files,
  activeRun,
  latestRun,
  busy,
  modelReady,
  researchEnabled = false,
  onConfigureResearch,
  onStart,
  onCorrect,
  onImport,
  onReadFile,
  onConfigureModel,
  onCancel,
}: ReadingWorkspaceProps) {
  const readingStartSequence = messages
    .filter((message) => message.role === "user" && message.text.startsWith(READING_TASK_MARKER))
    .reduce((latest, message) => Math.max(latest, message.sequence), -1);
  const hasStructuredReading = readingStartSequence >= 0;
  const report = useMemo(
    () => hasStructuredReading ? latestReport(messages, agentItems, readingStartSequence, latestRun?.status !== "succeeded" ? latestRun?.id : undefined) : "",
    [messages, agentItems, hasStructuredReading, readingStartSequence, latestRun],
  );
  const sections = useMemo(() => parseReadingReport(report), [report]);
  const corrections = useMemo(
    () => extractCorrections(messages, readingStartSequence),
    [messages, readingStartSequence],
  );
  const [activeSection, setActiveSection] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(() => window.innerWidth >= 1180);
  const [correctionWidth, setCorrectionWidth] = useState(initialCorrectionWidth);
  const [correctionMax, setCorrectionMax] = useState(READING_CORRECTION_MAX);
  const [resizingCorrection, setResizingCorrection] = useState(false);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [restarting, setRestarting] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [pdfContents, setPdfContents] = useState<Record<string, string>>({});
  const [sourceLoading, setSourceLoading] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [animatedRunId, setAnimatedRunId] = useState<string | null>(activeRun?.id ?? null);
  const [progressHistory, setProgressHistory] = useState(false);
  const problemPicker = useRef<HTMLInputElement>(null);
  const workspaceGrid = useRef<HTMLDivElement>(null);
  const correctionPanel = useRef<HTMLElement>(null);
  const correctionButton = useRef<HTMLButtonElement>(null);
  const correctionResize = useRef({ active: false, pointerId: -1, startX: 0, startWidth: 360, currentWidth: 360 });
  const selected = sections.find((section) => section.id === activeSection) ?? sections[0];
  const pdfFiles = files.filter(isProblemPdf);
  const selectedSource = pdfFiles.find((file) => file.path === sourcePath);
  const correctionTarget: ReadingCorrectionTarget | undefined = selectedSource
    ? { id: `source:${selectedSource.path}`, title: `原题 · ${selectedSource.name}` }
    : selected ? { id: selected.id, title: selected.title } : undefined;
  const targetCorrections = correctionTarget
    ? corrections.filter((correction) => correction.targetId === correctionTarget.id)
    : [];
  const correctionDraft = correctionTarget ? correctionDrafts[correctionTarget.id] ?? "" : "";
  const failed = hasStructuredReading && latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status);
  const currentTaskKind = activeRun ? getCurrentAgentTaskKind(agentItems, activeRun.id) : "thinking";
  const runOutcome = activeRun ? "running" : latestRun?.status === "succeeded" ? "completed" : latestRun?.status;
  const displayedCorrectionWidth = Math.min(correctionWidth, correctionMax);

  useEffect(() => {
    const grid = workspaceGrid.current;
    if (!grid) return;
    const measure = () => {
      const outline = grid.querySelector<HTMLElement>(".reading-outline");
      const outlineWidth = outline && getComputedStyle(outline).display !== "flex" ? outline.offsetWidth : 0;
      setCorrectionMax(Math.min(READING_CORRECTION_MAX, Math.max(READING_CORRECTION_MIN, grid.clientWidth - outlineWidth - 368)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(grid); measure();
    return () => observer.disconnect();
  }, [!!report, !!activeRun, restarting, animatedRunId]);

  useEffect(() => {
    if (activeRun) { setAnimatedRunId(activeRun.id); return; }
    if (!animatedRunId) return;
    const completed = latestRun?.id === animatedRunId && latestRun.status === "succeeded";
    if (!completed) { setAnimatedRunId(null); return; }
    const reduced = document.documentElement.dataset.reduceMotion === "true" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setAnimatedRunId(null); return; }
    const timer = setTimeout(() => setAnimatedRunId(null), 650);
    return () => clearTimeout(timer);
  }, [activeRun?.id, latestRun?.id, latestRun?.status, animatedRunId]);

  useEffect(() => {
    if (!sections.length) return;
    if (!sections.some((section) => section.id === activeSection)) setActiveSection(sections[0].id);
  }, [sections, activeSection]);


  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!pdfFiles.length || busy || activeRun) return;
    onStart();
    setProgressHistory(false);
    setRestarting(false);
  };

  const correct = (event: FormEvent) => {
    event.preventDefault();
    if (!correctionTarget || !correctionDraft.trim() || busy || activeRun) return;
    onCorrect(correctionDraft.trim(), correctionTarget);
    setProgressHistory(false);
    setCorrectionDrafts((current) => ({ ...current, [correctionTarget.id]: "" }));
  };

  const openSource = async (file: ProjectFile) => {
    setSourcePath(file.path);
    setSourceError("");
    if (pdfContents[file.path]) return;
    setSourceLoading(file.path);
    try {
      const content = await onReadFile(file);
      if (!content) throw new Error("无法读取原题文件。");
      if (content.mime !== "application/pdf" || !content.base64) throw new Error("当前文件无法作为 PDF 显示。");
      setPdfContents((current) => ({ ...current, [file.path]: content.base64! }));
    } catch (failure) {
      setSourceError(failure instanceof Error ? failure.message : "无法打开原题文件。");
    } finally {
      setSourceLoading("");
    }
  };

  const chooseSection = (id: string) => {
    setSourcePath("");
    setSourceError("");
    setActiveSection(id);
  };

  const setCorrectionPanelWidth = (width: number, persist = false) => {
    const next = Math.min(correctionMax, Math.max(resizingCorrection ? READING_CORRECTION_CLOSE : READING_CORRECTION_MIN, width));
    correctionResize.current.currentWidth = next;
    setCorrectionWidth(next);
    if (persist) writePreference("nexiom.readingCorrectionWidth", String(Math.round(next)));
  };

  const closeCorrection = () => {
    if (correctionPanel.current?.contains(document.activeElement)) correctionButton.current?.focus();
    setCorrectionOpen(false);
  };

  const beginCorrectionResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !correctionOpen) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    correctionResize.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: correctionPanel.current?.getBoundingClientRect().width ?? displayedCorrectionWidth,
      currentWidth: displayedCorrectionWidth,
    };
    setResizingCorrection(true);
  };

  const moveCorrectionResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!correctionResize.current.active || correctionResize.current.pointerId !== event.pointerId) return;
    const next = correctionResize.current.startWidth + correctionResize.current.startX - event.clientX;
    if (next <= READING_CORRECTION_CLOSE) {
      correctionResize.current.active = false;
      setResizingCorrection(false);
      setCorrectionWidth(correctionResize.current.startWidth);
      closeCorrection();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      correctionButton.current?.focus();
      return;
    }
    setCorrectionPanelWidth(next);
  };

  const finishCorrectionResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!correctionResize.current.active || correctionResize.current.pointerId !== event.pointerId) return;
    correctionResize.current.active = false;
    setResizingCorrection(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const width = Math.max(READING_CORRECTION_MIN, correctionResize.current.currentWidth);
    setCorrectionWidth(width);
    writePreference("nexiom.readingCorrectionWidth", String(Math.round(width)));
  };

  const resizeCorrectionWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (event.key === "Home") { closeCorrection(); correctionButton.current?.focus(); }
    else if (event.key === "End") setCorrectionPanelWidth(READING_CORRECTION_MAX, true);
    else if (event.key === "ArrowRight" && displayedCorrectionWidth <= READING_CORRECTION_MIN) { closeCorrection(); correctionButton.current?.focus(); }
    else setCorrectionPanelWidth(displayedCorrectionWidth + (event.key === "ArrowLeft" ? 16 : -16), true);
  };

  if (progressHistory && latestRun && !activeRun) {
    return <ReadingProgress key={`history:${latestRun.id}`} run={latestRun} items={agentItems} onCancel={onCancel} history
      onBack={() => setProgressHistory(false)} backLabel={report && !restarting ? "返回研读报告" : "返回输入"} />;
  }

  if ((!report && !activeRun) || (restarting && !activeRun)) {
    return (
      <section className="reading-intake" aria-labelledby="reading-intake-title">
        {report && restarting && (
          <button type="button" className="reading-back-button" onClick={() => setRestarting(false)}>
            <ArrowLeft size={16} />返回研读报告
          </button>
        )}
        <div className="reading-intake-content">
          <div className="reading-intake-heading">
            <WorkspaceLogo dimension="reading" className="reading-intake-logo" />
            <h1 id="reading-intake-title">输入赛题文件</h1>
          </div>
          <div className="reading-intake-layout">
            <form className="reading-file-intake" onSubmit={start}>
              <input
                ref={problemPicker}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(event) => {
                  const input = event.currentTarget;
                  void onImport(input.files).finally(() => { input.value = ""; });
                }}
              />
              <button type="button" className="reading-file-picker" onClick={() => problemPicker.current?.click()} disabled={busy}>
                <FileUp size={19} />选择赛题文件
              </button>
              {!!pdfFiles.length && (
                <div className="reading-intake-files" aria-label="已输入的赛题文件">
                  {pdfFiles.map((file) => (
                    <div className="reading-intake-file"
                      key={file.path}
                      title={file.path}
                    >
                      <FileText size={17} /><span>{file.name}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="reading-intake-actions">
                {!modelReady ? (
                  <button type="button" className="primary-button" onClick={onConfigureModel}>先配置模型</button>
                ) : (
                  <button
                    className="primary-button reading-start-button"
                    disabled={!pdfFiles.length || busy || !!activeRun}
                  >
                    {report ? "重新开始研读" : "开始研读"}
                  </button>
                )}
              </div>
              {onConfigureResearch && <button type="button" className="reading-research-setting" disabled={busy} onClick={onConfigureResearch}>
                文献联网检索：{researchEnabled ? "已允许" : "未允许"}
              </button>}
              {failed && <div className="reading-run-error" role="alert"><AgentTaskStatus compact status={latestRun!.status === "failed" ? "failed" : latestRun!.status === "cancelled" ? "cancelled" : "interrupted"} /></div>}
              {hasStructuredReading && latestRun && <button type="button" className="reading-research-setting" onClick={() => setProgressHistory(true)}>查看研读过程</button>}
            </form>
          </div>
        </div>
      </section>
    );
  }

  if (activeRun) return <ReadingProgress key={activeRun.id} run={activeRun} items={agentItems} onCancel={onCancel} />;
  if (latestRun?.id === animatedRunId && latestRun.status === "succeeded" && report) {
    return <ReadingProgress key={latestRun.id} run={latestRun} items={agentItems} onCancel={onCancel} />;
  }

  return (
    <section
      className={`reading-workspace ${correctionOpen ? "" : "correction-closed"} ${resizingCorrection ? "correction-resizing" : ""}`}
      style={{ "--reading-correction-width": `${displayedCorrectionWidth}px` } as CSSProperties}
    >
      <header className="reading-report-header">
        <div className="reading-report-title">
          <WorkspaceLogo dimension="reading" />
          <div>
            <span className="reading-eyebrow"><BookOpen size={14} />{projectName}</span>
            <h1>赛题研读报告</h1>
            <p>{activeRun ? "正在根据新的信息更新报告" : `已整理 ${sections.length} 个研读板块`}</p>
          </div>
        </div>
        <div className="reading-report-actions">
          {runOutcome && <AgentTaskStatus kind={currentTaskKind} status={runOutcome} compact final />}
          {latestRun && <button type="button" className="secondary-button" onClick={() => setProgressHistory(true)}><History size={15} />研读过程</button>}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSourcePath("");
              setRestarting(true);
            }}
            disabled={!!activeRun}
          >
            <ArrowLeft size={15} />返回输入
          </button>
          <button
            ref={correctionButton}
            type="button"
            className={`secondary-button ${correctionOpen ? "active" : ""}`}
            aria-expanded={correctionOpen}
            aria-controls="reading-correction-panel"
            onClick={() => correctionOpen ? closeCorrection() : setCorrectionOpen(true)}
          >
            {correctionOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            人工纠偏
            {!!targetCorrections.length && <span className="reading-correction-count">{targetCorrections.length}</span>}
          </button>
        </div>
      </header>
      <div className="reading-workspace-grid" ref={workspaceGrid}>
        <nav className="reading-outline" aria-label="研读报告目录">
          {!!pdfFiles.length && <span className="reading-outline-label">原题文件</span>}
          {pdfFiles.map((file) => (
            <button
              type="button"
              key={file.path}
              className={selectedSource?.path === file.path ? "active" : ""}
              aria-current={selectedSource?.path === file.path ? "page" : undefined}
              onClick={() => void openSource(file)}
              title={file.path}
            >
              <span className="reading-outline-index">PDF</span>
              <FileText size={16} />
              <span>{file.name}</span>
            </button>
          ))}
          <span className="reading-outline-label">报告目录</span>
          {sections.map((section, index) => (
            <button
              type="button"
              key={section.id}
              className={!selectedSource && selected?.id === section.id ? "active" : ""}
              aria-current={!selectedSource && selected?.id === section.id ? "page" : undefined}
              onClick={() => chooseSection(section.id)}
            >
              <span className="reading-outline-index">{String(index + 1).padStart(2, "0")}</span>
              <SectionIcon kind={section.kind} />
              <span>{section.title}</span>
            </button>
          ))}
        </nav>
        <article className={`reading-report-body ${selectedSource ? "pdf-active" : ""}`} aria-live="polite">
          {selectedSource ? (
            <div className="reading-pdf-document">
              {sourceLoading === selectedSource.path ? (
                <div className="reading-pdf-state"><CircleDotDashed className="spin" size={22} />正在打开原题</div>
              ) : sourceError ? (
                <div className="reading-pdf-state error" role="alert">{sourceError}</div>
              ) : pdfContents[selectedSource.path] ? (
                <PdfViewer
                  className="reading-pdf-viewer"
                  base64={pdfContents[selectedSource.path]}
                  title={selectedSource.name}
                />
              ) : null}
            </div>
          ) : selected && (
            <>
              <div className="reading-section-heading">
                <span><SectionIcon kind={selected.kind} size={18} /></span>
                <div><h2>{selected.title}</h2></div>
              </div>
              <RichText text={selected.body || "本板块暂无内容。"} reading />
            </>
          )}
        </article>
          <>
            <div
              className="reading-correction-resizer"
              role="separator"
              aria-label="调整当前板块人工纠偏区域宽度"
              aria-orientation="vertical"
              aria-valuemin={resizingCorrection ? READING_CORRECTION_CLOSE : READING_CORRECTION_MIN}
              aria-valuemax={correctionMax}
              aria-valuenow={Math.round(displayedCorrectionWidth)}
              tabIndex={correctionOpen ? 0 : -1}
              aria-hidden={!correctionOpen}
              onPointerDown={beginCorrectionResize}
              onPointerMove={moveCorrectionResize}
              onPointerUp={finishCorrectionResize}
              onPointerCancel={finishCorrectionResize}
              onLostPointerCapture={finishCorrectionResize}
              onDoubleClick={() => setCorrectionPanelWidth(360, true)}
              onKeyDown={resizeCorrectionWithKeyboard}
            />
            <div className="reading-correction-slot" inert={!correctionOpen} aria-hidden={!correctionOpen}>
            <aside id="reading-correction-panel" ref={correctionPanel} className="reading-correction-panel" aria-label={`${correctionTarget?.title ?? "当前板块"}的人工纠偏`}>
              <header>
                <div><MessageSquareText size={18} /><strong>人工纠偏</strong></div>
                <span className="reading-correction-target">{correctionTarget?.title}</span>
              </header>
              <div className="reading-correction-history" aria-label="当前板块纠偏记录">
                {targetCorrections.map((correction, index) => (
                <div className="reading-correction-item" key={correction.id}>
                  <span>批注 {String(index + 1).padStart(2, "0")}</span>
                  <p>{correction.text}</p>
                  <small>{new Date(correction.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
                </div>
                ))}
              </div>
              <form className="reading-correction-form" onSubmit={correct}>
                <textarea
                  aria-label={`纠偏${correctionTarget?.title ?? "当前板块"}`}
                  value={correctionDraft}
                  maxLength={4000}
                  disabled={busy || !!activeRun || !correctionTarget}
                  onChange={(event) => {
                    if (!correctionTarget) return;
                    setCorrectionDrafts((current) => ({ ...current, [correctionTarget.id]: event.target.value }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      correct(event);
                    }
                  }}
                />
                <div>
                  {activeRun ? (
                    <button type="button" className="reading-correction-send" aria-label="停止更新" onClick={onCancel}>
                      <Square size={13} />
                    </button>
                  ) : (
                    <button className="reading-correction-send" aria-label="提交当前板块纠偏" disabled={!correctionDraft.trim() || busy || !correctionTarget}>
                      <Send size={15} />
                    </button>
                  )}
                </div>
              </form>
            </aside>
            </div>
          </>
      </div>
    </section>
  );
}
