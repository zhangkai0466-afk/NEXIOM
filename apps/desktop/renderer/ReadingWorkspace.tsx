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
  ArrowUp,
  Square,
  Tags,
  X,
} from "lucide-react";
import type { AgentItem, FileContent, Message, ProjectFile, Run } from "../../../packages/contracts";
import { RichText } from "./AgentOutput";
import { PdfViewer } from "./PdfViewer";
import { PanelToggleIcon } from "./PanelToggleIcon";
import { ReadingOutlineDivider } from "./ReadingOutlineDivider";
import { ReadingSectionBody } from "./ReadingSections";
import { request } from "./bridge";
import type { WorkflowAction, WorkflowState } from "../../../packages/contracts/workflow";
import { AgentActivity } from "./AgentActivity";
import { AgentTaskStatus } from "./AgentTaskStatus";
import { NexiomMark } from "./NexiomMark";
import { getCurrentAgentTaskKind, outputBlockedByThinking } from "./agent-task-state";
import {
  READING_CORRECTION_MARKER,
  isReadingDiscussionSequence,
  latestReadingTurnIsDiscussion,
  parseReadingDiscussion,
  readingDiscussionBounds,
} from "../../../packages/contracts/reading-workflow";
import { ReadingProgress } from "./ReadingProgress";
import { AutoTextarea } from "./AutoTextarea";
import { WorkspaceHeading } from "./WorkspaceHeading";
import { latestFormalReadingRun, readingCanViewReport, readingSteps } from "./reading-progress";
import { readPreference, writePreference } from "./preferences";

export const READING_TASK_MARKER = "[NEXIOM赛题研读任务]";
export { READING_CORRECTION_MARKER };

type SectionKind =
  | "overview"
  | "source"
  | "terms"
  | "question"
  | "dependency"
  | "trap"
  | "pending"
  | "delivery"
  | "research"
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
  body?: string;
}

interface ReadingWorkspaceProps {
  projectId: string;
  projectName: string;
  messages: Message[];
  agentItems: AgentItem[];
  files: ProjectFile[];
  activeRun?: Run;
  latestRun?: Run;
  runs?: Run[];
  busy: boolean;
  modelReady: boolean;
  researchEnabled?: boolean;
  onConfigureResearch?: () => void;
  onStart: () => void;
  onCorrect: (correction: string, target: ReadingCorrectionTarget) => void;
  onImport: (selected: FileList | null) => Promise<void>;
  onRemove: (file: ProjectFile) => Promise<void>;
  onReadFile: (file: ProjectFile) => Promise<FileContent | undefined>;
  onConfigureModel: () => void;
  onCancel: () => void;
}

function sectionKind(title: string): SectionKind {
  const normalized = title.replace(/[\s·：:、—_-]/g, "").toLowerCase();
  if (/文献调研/.test(normalized)) return "research";
  if (/问题[一二三四五六七八九十\d]+/.test(normalized)) return "question";
  if (/逐字|逐句|原题|题干/.test(normalized)) return "source";
  if (/名词|术语|符号|变量|数据|口径|单位/.test(normalized)) return "terms";
  if (/依赖|关系图|承接/.test(normalized)) return "dependency";
  if (/陷阱|误区|风险/.test(normalized)) return "trap";
  if (/待.*核对|待核|歧义|确认|不确定/.test(normalized)) return "pending";
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
  const bounds = readingDiscussionBounds(messages, afterSequence);
  const published = (sequence: number) => !isReadingDiscussionSequence(sequence, bounds);
  const candidates = [
    ...messages
      .filter((message) =>
        message.sequence > afterSequence &&
        published(message.sequence) &&
        message.role === "assistant" &&
        message.kind !== "progress" &&
        isReadingReport(message.text)
      )
      .map((message) => ({ sequence: message.sequence, text: message.text })),
    ...items.flatMap((record) =>
      record.sequence > afterSequence &&
      published(record.sequence) &&
      record.runId !== excludedRunId && record.status === "completed" &&
      record.item.type === "agent_message" &&
      isReadingReport(record.item.text)
        ? [{ sequence: record.sequence, text: record.item.text }]
        : [],
    ),
  ].sort((left, right) => left.sequence - right.sequence);
  return candidates.at(-1)?.text.trim() ?? "";
}

export function draftReadingReport(items: AgentItem[], runId: string) {
  return items
    .flatMap((record) =>
      record.runId === runId && record.item.type === "agent_message" && isReadingReport(record.item.text)
        ? [{ sequence: record.sequence, text: record.item.text.trim() }]
        : [],
    )
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1)?.text ?? "";
}

interface ReadingDiscussionReply {
  id: string;
  sequence: number;
  text: string;
  streaming: boolean;
}

interface ReadingDiscussionTurn {
  id: string;
  targetId: string;
  targetTitle: string;
  text: string;
  createdAt: string;
  sequence: number;
  replies: ReadingDiscussionReply[];
}

function discussionTurns(messages: Message[], items: AgentItem[], afterSequence: number): ReadingDiscussionTurn[] {
  const bounds = readingDiscussionBounds(messages, afterSequence);
  return [...messages]
    .filter((message) => message.sequence > afterSequence && message.role === "user")
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((message) => {
      const parsed = parseReadingDiscussion(message.text);
      const bound = bounds.find((item) => item.start === message.sequence);
      if (!parsed || !bound) return [];
      const replies = [
        ...items.flatMap((record) => {
          if (record.sequence <= bound.start || record.sequence >= bound.end || record.item.type !== "agent_message") return [];
          if (outputBlockedByThinking(items, record)) return [];
          const streaming = record.status === "running";
          if (!record.item.text.trim() && !streaming) return [];
          return [{ id: record.id, sequence: record.sequence, text: record.item.text, streaming }];
        }),
        ...messages.flatMap((reply) => {
          if (reply.sequence <= bound.start || reply.sequence >= bound.end || reply.role !== "assistant" || reply.kind === "progress") return [];
          const duplicated = items.some((record) =>
            record.sequence > bound.start &&
            record.sequence < bound.end &&
            record.item.type === "agent_message" &&
            record.item.text.trim() === reply.text.trim(),
          );
          return duplicated ? [] : [{ id: reply.id, sequence: reply.sequence, text: reply.text, streaming: false }];
        }),
      ].sort((left, right) => left.sequence - right.sequence);
      return [{
        id: message.id,
        targetId: parsed.id,
        targetTitle: parsed.title,
        text: parsed.opinion,
        createdAt: message.createdAt,
        sequence: message.sequence,
        replies,
      }];
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
  projectId,
  projectName,
  messages,
  agentItems,
  files,
  activeRun,
  latestRun,
  runs = [],
  busy,
  modelReady,
  researchEnabled = false,
  onConfigureResearch,
  onStart,
  onCorrect,
  onImport,
  onRemove,
  onReadFile,
  onConfigureModel,
  onCancel,
}: ReadingWorkspaceProps) {
  const [workflow, setWorkflow] = useState<WorkflowState>();
  const [workflowError, setWorkflowError] = useState("");
  useEffect(() => {
    let active = true;
    void request({ type: "workflow.read", projectId }).then(result => { if (active) setWorkflow(result.workflow); }).catch(error => { if (active) setWorkflowError(error.message); });
    return () => { active = false; };
  }, [projectId, latestRun?.status, messages.length]);
  async function updateWorkflow(change: WorkflowAction) {
    try { setWorkflowError(""); const result = await request({ type: "workflow.update", projectId, change }); setWorkflow(result.workflow); }
    catch (error) { setWorkflowError((error as Error).message); throw error; }
  }
  const readingStartSequence = messages
    .filter((message) => message.role === "user" && message.text.startsWith(READING_TASK_MARKER))
    .reduce((latest, message) => Math.max(latest, message.sequence), -1);
  const hasStructuredReading = readingStartSequence >= 0;
  const discussionTurn = latestReadingTurnIsDiscussion(messages, readingStartSequence);
  const discussing = !!activeRun && discussionTurn;
  const formalRun = latestFormalReadingRun(runs.length ? runs : latestRun ? [latestRun] : [], agentItems);
  const [viewingReport, setViewingReport] = useState(false);
  const report = useMemo(
    () => hasStructuredReading ? latestReport(messages, agentItems, readingStartSequence, latestRun?.status !== "succeeded" ? latestRun?.id : undefined) : "",
    [messages, agentItems, hasStructuredReading, readingStartSequence, latestRun],
  );
  const draftReport = useMemo(
    () => activeRun ? draftReadingReport(agentItems, activeRun.id) : "",
    [agentItems, activeRun],
  );
  const shownReport = viewingReport && activeRun && !discussing ? draftReport || report : report;
  const sections = useMemo(() => {
    const result = parseReadingReport(shownReport);
    if (result.length && !result.some(section => section.kind === ("research" as SectionKind))) result.splice(Math.max(0, result.length - 1), 0, { id: "research", title: "文献调研", kind: "research" as SectionKind, body: "在任意板块提出文献调研请求，结果会分类积累到这里。未经核实的引用应标明证据限制。" });
    return result;
  }, [shownReport]);
  const turns = useMemo(
    () => discussionTurns(messages, agentItems, readingStartSequence),
    [messages, agentItems, readingStartSequence],
  );
  const [activeSection, setActiveSection] = useState("");
  const [outlineOpen, setOutlineOpen] = useState(() => readPreference("nexiom.readingOutlineOpen") !== "false");
  const [outlineWidth, setOutlineWidth] = useState(() => Math.min(360, Math.max(180, Number(readPreference("nexiom.readingOutlineWidth")) || 230)));
  const [outlineMax, setOutlineMax] = useState(360);
  const [resizingOutline, setResizingOutline] = useState(false);
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
  const sourceRequest = useRef(0);
  const workspaceGrid = useRef<HTMLDivElement>(null);
  const correctionPanel = useRef<HTMLElement>(null);
  const correctionHistory = useRef<HTMLDivElement>(null);
  const correctionButton = useRef<HTMLButtonElement>(null);
  const correctionResize = useRef({ active: false, pointerId: -1, startX: 0, startWidth: 360, currentWidth: 360 });
  const selected = sections.find((section) => section.id === activeSection) ?? sections[0];
  const pdfFiles = files.filter(isProblemPdf);
  const selectedSource = pdfFiles.find((file) => file.path === sourcePath);
  const correctionTarget: ReadingCorrectionTarget | undefined = selectedSource
    ? { id: `source:${selectedSource.path}`, title: `原题 · ${selectedSource.name}`, body: "当前打开的是原题 PDF，不是报告正文。请只讨论对这份原题的理解，不要重新研读。" }
    : selected ? { id: selected.id, title: selected.title, body: selected.body } : undefined;
  const targetTurns = correctionTarget
    ? turns.filter((turn) => turn.targetId === correctionTarget.id)
    : [];
  const latestDiscussion = turns.at(-1);
  const discussionRun = discussionTurn && latestDiscussion?.targetId === correctionTarget?.id ? activeRun ?? latestRun : undefined;
  const reduceMotion = document.documentElement.dataset.reduceMotion === "true";
  const correctionDraft = correctionTarget ? correctionDrafts[correctionTarget.id] ?? "" : "";
  const failed = hasStructuredReading && latestRun && !discussionTurn && ["failed", "cancelled", "interrupted"].includes(latestRun.status);
  const currentTaskKind = activeRun ? getCurrentAgentTaskKind(agentItems, activeRun.id) : "thinking";
  const runOutcome = activeRun ? "running" : latestRun?.status === "succeeded" ? "completed" : latestRun?.status;
  const displayedCorrectionWidth = Math.min(correctionWidth, correctionMax);

  useEffect(() => {
    const grid = workspaceGrid.current;
    if (!grid) return;
    const measure = () => {
      const outline = grid.querySelector<HTMLElement>(".reading-outline");
      const outlineWidth = outline && getComputedStyle(outline).display !== "flex" ? outline.offsetWidth : 0;
      setCorrectionMax(Math.min(READING_CORRECTION_MAX, Math.max(READING_CORRECTION_MIN, grid.clientWidth - outlineWidth - 376)));
      setOutlineMax(Math.min(360, Math.max(180, grid.clientWidth - (correctionOpen ? READING_CORRECTION_MIN : 0) - 376)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    const outline = grid.querySelector<HTMLElement>(".reading-outline");
    if (outline) observer.observe(outline);
    measure();
    return () => observer.disconnect();
  }, [!!report, !!activeRun, restarting, animatedRunId, outlineWidth, outlineOpen, correctionOpen]);

  useEffect(() => {
    if (activeRun && !discussing) setViewingReport(false);
  }, [activeRun?.id, discussing]);

  useEffect(() => {
    if (activeRun || report) return;
    if (viewingReport) setViewingReport(false);
  }, [activeRun, viewingReport, report]);

  useEffect(() => {
    if (activeRun) {
      setAnimatedRunId(discussing ? null : activeRun.id);
      return;
    }
    if (!animatedRunId) return;
    const completed = latestRun?.id === animatedRunId && latestRun.status === "succeeded";
    if (!completed) { setAnimatedRunId(null); return; }
    const reduced = document.documentElement.dataset.reduceMotion === "true" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setAnimatedRunId(null); return; }
    const timer = setTimeout(() => setAnimatedRunId(null), 650);
    return () => clearTimeout(timer);
  }, [activeRun?.id, discussing, latestRun?.id, latestRun?.status, animatedRunId]);

  const discussionSignature = targetTurns.map((turn) => turn.id + ":" + turn.replies.map((reply) => reply.sequence + ":" + reply.text.length + ":" + reply.streaming).join(",")).join("|");
  useEffect(() => {
    const node = correctionHistory.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance < 96) node.scrollTop = node.scrollHeight;
  }, [discussionSignature, correctionOpen, correctionTarget?.id]);

  useEffect(() => {
    if (!sections.length) return;
    if (!sections.some((section) => section.id === activeSection)) setActiveSection(sections[0].id);
  }, [sections, activeSection]);


  useEffect(() => {
    const paths = new Set(files.map(file => file.path));
    setPdfContents(current => {
      const entries = Object.entries(current);
      return entries.some(([path]) => !paths.has(path))
        ? Object.fromEntries(entries.filter(([path]) => paths.has(path))) : current;
    });
    if (sourcePath && !paths.has(sourcePath)) {
      sourceRequest.current++;
      setSourcePath("");
      setSourceLoading("");
      setSourceError("");
    }
  }, [files, sourcePath]);

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
    const requestId = ++sourceRequest.current;
    setSourcePath(file.path);
    setSourceError("");
    setSourceLoading("");
    if (pdfContents[file.path]) return;
    setSourceLoading(file.path);
    try {
      const content = await onReadFile(file);
      if (requestId !== sourceRequest.current) return;
      if (!content) throw new Error("无法读取原题文件。");
      if (content.mime !== "application/pdf" || !content.base64) throw new Error("当前文件无法作为 PDF 显示。");
      setPdfContents((current) => ({ ...current, [file.path]: content.base64! }));
    } catch (failure) {
      if (requestId === sourceRequest.current) setSourceError(failure instanceof Error ? failure.message : "无法打开原题文件。");
    } finally {
      if (requestId === sourceRequest.current) setSourceLoading("");
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

  if (progressHistory && formalRun && !activeRun) {
    return <ReadingProgress projectName={projectName} key={`history:${formalRun.id}`} run={formalRun} items={agentItems} onCancel={onCancel} history
      onBack={() => setProgressHistory(false)} backLabel={report && !restarting ? "返回研读报告" : "返回输入"} />;
  }

  if ((!report && !activeRun) || (restarting && !activeRun)) {
    return (
      <section className="reading-intake workspace-intake" aria-labelledby="reading-intake-title">
        <header className="workspace-state-header"><WorkspaceHeading dimension="reading" projectName={projectName} title="赛题研读"/></header>
        {report && restarting && (
          <button type="button" className="reading-back-button" onClick={() => setRestarting(false)}>
            <ArrowLeft size={16} />返回研读报告
          </button>
        )}
        <div className="reading-intake-content">
          <div className="reading-intake-heading">
            <h2 id="reading-intake-title">输入赛题文件</h2>
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
                      <button
                        type="button"
                        className="reading-intake-remove"
                        title={`移除 ${file.name}`}
                        aria-label={`移除 ${file.name}`}
                        disabled={busy || !!activeRun}
                        onClick={() => void onRemove(file)}
                      ><X size={16} aria-hidden="true" /></button>
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
              {hasStructuredReading && formalRun && <button type="button" className="reading-research-setting" onClick={() => setProgressHistory(true)}>查看研读过程</button>}
            </form>
          </div>
        </div>
      </section>
    );
  }

  const canViewReport = !!activeRun && readingCanViewReport(readingSteps(agentItems, activeRun), activeRun);
  if (activeRun && !discussing && !viewingReport) return <ReadingProgress projectName={projectName} key={activeRun.id} run={activeRun} items={agentItems} onCancel={onCancel} onViewReport={canViewReport ? () => setViewingReport(true) : undefined} />;
  if (!discussing && !viewingReport && latestRun?.id === animatedRunId && latestRun.status === "succeeded" && report) {
    return <ReadingProgress projectName={projectName} key={latestRun.id} run={latestRun} items={agentItems} onCancel={onCancel} />;
  }
  if (viewingReport && activeRun && !shownReport) {
    return <section className="reading-report-pending" aria-live="polite">
      <WorkspaceHeading dimension="reading" projectName={projectName} title="赛题研读报告"/>
      <p>报告仍在写入。</p>
      <div>
        <button type="button" className="secondary-button" onClick={() => setViewingReport(false)}><ArrowLeft size={15} />返回进度</button>
        <button type="button" className="reading-progress-stop" onClick={onCancel} aria-label="停止研读"><Square size={15} /></button>
      </div>
    </section>;
  }

  return (
    <section
      className={`reading-workspace ${correctionOpen ? "" : "correction-closed"} ${outlineOpen ? "" : "outline-closed"} ${resizingCorrection || resizingOutline ? "correction-resizing" : ""}`}
      style={{ "--reading-correction-width": `${displayedCorrectionWidth}px`, "--reading-outline-width": `${Math.min(outlineWidth, outlineMax)}px` } as CSSProperties}
    >
      <header className="reading-report-header">
        <WorkspaceHeading dimension="reading" projectName={projectName} title="赛题研读报告" detail={discussing ? "正在讨论当前板块，已发布报告保持不变" : activeRun ? "正在根据新的信息更新报告" : `已整理 ${sections.length} 个研读板块`}/>
        <div className="reading-report-actions">
          {runOutcome && runOutcome !== "completed" && !discussionTurn && <AgentTaskStatus kind={currentTaskKind} status={runOutcome} compact final />}
          {activeRun && !discussing && <button type="button" className="secondary-button" onClick={() => setViewingReport(false)}><ArrowLeft size={15} />返回进度</button>}
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
            <PanelToggleIcon expanded={correctionOpen} />
            {selectedSource ? "聊聊原题" : "人工纠偏"}
            {!!targetTurns.length && <span className="reading-correction-count">{targetTurns.length}</span>}
          </button>
        </div>
      </header>
      <div className="reading-workspace-grid" ref={workspaceGrid}>
        <nav id="reading-report-outline" className="reading-outline" aria-label="研读报告目录" inert={!outlineOpen} aria-hidden={!outlineOpen}>
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
        <ReadingOutlineDivider width={outlineOpen ? Math.min(outlineWidth, outlineMax) : 0} restoreWidth={Math.min(outlineWidth, outlineMax)} max={outlineMax}
          onChange={width => { setResizingOutline(true); setOutlineOpen(width > 0); if (width) setOutlineWidth(width); }}
          onCommit={width => {
            setResizingOutline(false); setOutlineOpen(width > 0);
            writePreference("nexiom.readingOutlineOpen", String(width > 0));
            if (width) { setOutlineWidth(width); writePreference("nexiom.readingOutlineWidth", String(width)); }
            else setOutlineWidth(Math.min(360, Math.max(180, Number(readPreference("nexiom.readingOutlineWidth")) || 230)));
          }} />
        <article className={`reading-report-body ${selectedSource ? "pdf-active" : ""}`} aria-live="polite">
          {workflowError && <p role="alert" className="form-error">{workflowError}</p>}
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
                  onSave={async base64 => {
                    const path = selectedSource.path;
                    await request({ type: "pdf.save", projectId, path, base64 });
                    setPdfContents(current => ({ ...current, [path]: base64 }));
                  }}
                  onQuote={quote => { if (!correctionTarget) return; setCorrectionOpen(true); setCorrectionDrafts(current => ({ ...current, [correctionTarget.id]: (current[correctionTarget.id] ?? "") + quote })); requestAnimationFrame(() => correctionPanel.current?.querySelector("textarea")?.focus()); }}
                />
              ) : null}
            </div>
          ) : selected && (
            <>
              <div className="reading-section-heading">
                <span><SectionIcon kind={selected.kind} size={18} /></span>
                <div><h2>{selected.title}</h2></div>
              </div>
              <ReadingSectionBody key={selected.id} kind={selected.kind} body={selected.body} state={workflow} onChange={updateWorkflow} />
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
                <div><MessageSquareText size={18} /><strong>{selectedSource ? "聊聊原题" : "人工纠偏"}</strong></div>
                <span className="reading-correction-target">{correctionTarget?.title}</span>
              </header>
              <div className="reading-correction-history" ref={correctionHistory} aria-label="当前板块讨论">
                {targetTurns.length === 0 ? (
                  <div className="thread-empty reading-discussion-empty">
                    <div className="empty-mark"><NexiomMark /></div>
                    <h1>聊点什么？</h1>
                  </div>
                ) : targetTurns.map((turn) => (
                  <div key={turn.id}>
                    <article className="message user note">
                      <div className="message-body">{turn.text}</div>
                    </article>
                    {turn.replies.map((reply) => {
                      const record = agentItems.find((item) => item.id === reply.id);
                      const replyRun = record ? runs.find((item) => item.id === record.runId) : undefined;
                      const run = replyRun ?? (reply.streaming ? discussionRun : undefined);
                      const lastOfRun = run ? turn.replies.reduce<(typeof reply) | undefined>((chosen, item) => {
                        const match = agentItems.find((agent) => agent.id === item.id);
                        return (match?.runId ?? (item.streaming ? discussionRun?.id : undefined)) === run.id && (!chosen || item.sequence > chosen.sequence) ? item : chosen;
                      }, undefined) : undefined;
                      const streaming = !!reply.streaming && run?.status === "running";
                      const showHeader = !!run && lastOfRun?.id === reply.id && (streaming || !!reply.text.trim());
                      return reply.text.trim() || reply.streaming ? (
                        <article className={`message assistant answer${reply.streaming ? " streaming" : ""}`} key={reply.id}>
                          {showHeader && run && (
                            <AgentActivity run={run} items={agentItems} paused={reduceMotion} casual kind={streaming ? "writing" : undefined} settled={!streaming} ruled />
                          )}
                          {reply.text.trim() ? <div className="message-body"><RichText text={reply.text} /></div> : null}
                        </article>
                      ) : null;
                    })}
                    {discussionRun && turn.id === latestDiscussion?.id && discussionRun.status === "running" && !turn.replies.some((reply) => reply.streaming || reply.text.trim()) && (
                      <AgentActivity run={discussionRun} items={agentItems} paused={reduceMotion} casual />
                    )}
                  </div>
                ))}
              </div>
              <form className="composer reading-discussion-composer" onSubmit={correct}>
                <AutoTextarea
                  aria-label={`讨论${correctionTarget?.title ?? "当前板块"}`}
                  placeholder="向 NEXIOM 发送任务…"
                  value={correctionDraft}
                  maxLength={4000}
                  disabled={!correctionTarget}
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
                <div className="composer-toolbar">
                  <div className="composer-tools" />
                  <div className="composer-right">
                    {activeRun ? (
                      <button type="button" className="icon-button" aria-label={discussing ? "停止讨论" : "停止研读"} title={discussing ? "停止讨论" : "停止研读"} onClick={onCancel}>
                        <Square size={16} />
                      </button>
                    ) : (
                      <button className="send-button" type="submit" title="发送" aria-label="发送当前板块的意见" disabled={!correctionDraft.trim() || busy || !correctionTarget}>
                        <ArrowUp size={18} />
                      </button>
                    )}
                  </div>
                </div>
              </form>
            </aside>
            </div>
          </>
      </div>
    </section>
  );
}
