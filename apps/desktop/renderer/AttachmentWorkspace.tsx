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
  CheckCircle2,
  CircleDotDashed,
  FileText,
  FileUp,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Send,
  Square,
} from "lucide-react";
import type { AgentItem, Message, ProjectFile, Run } from "../../../packages/contracts";
import { RichText } from "./AgentOutput";
import { AgentTaskIcon, AgentTaskLabel, AgentTaskStatus } from "./AgentTaskStatus";
import { getAgentItemOutcome, getAgentTaskKind, getCurrentAgentTaskKind } from "./agent-task-state";
import { WorkspaceLogo } from "./WorkspaceLogo";
import { readPreference, writePreference } from "./preferences";

export const ATTACHMENT_TASK_MARKER = "[NEXIOM附件分析任务]";
export const ATTACHMENT_CORRECTION_MARKER = "[NEXIOM附件分析纠偏]";
export const ATTACHMENT_ANALYSIS_LIMIT = 12;

export interface AttachmentCorrectionTarget {
  id: string;
  path: string;
  name: string;
}

interface AttachmentManifestEntry extends AttachmentCorrectionTarget {
  size: number;
  extension: string;
}

interface AttachmentReport {
  id: string;
  title: string;
  body: string;
}

interface AttachmentCorrection {
  id: string;
  targetId: string;
  targetPath: string;
  targetName: string;
  text: string;
  createdAt: string;
}

interface AttachmentWorkspaceProps {
  projectName: string;
  messages: Message[];
  agentItems: AgentItem[];
  files: ProjectFile[];
  activeRun?: Run;
  latestRun?: Run;
  busy: boolean;
  modelReady: boolean;
  onCorrect: (correction: string, target: AttachmentCorrectionTarget) => void;
  onImport: () => void;
  onOpenFile: (file: ProjectFile) => void;
  onConfigureModel: () => void;
  onCancel: () => void;
}

const normalizePath = (value: string) => value.replaceAll("\\", "/");

export function parseAttachmentManifest(text: string, files: ProjectFile[] = []): AttachmentManifestEntry[] {
  const block = text.match(/【附件清单】\n([\s\S]*?)\n\n【分析工作流】/)?.[1] ?? "";
  const byPath = new Map(files.map((file) => [normalizePath(file.path), file]));
  return block.split("\n").flatMap((line) => {
    const match = line.match(/^(A\d{2,3})\t(.+)$/);
    if (!match) return [];
    const path = normalizePath(match[2].trim());
    const file = byPath.get(path);
    const name = file?.name ?? path.split("/").at(-1) ?? path;
    return [{
      id: match[1],
      path,
      name,
      size: file?.size ?? 0,
      extension: file?.extension ?? name.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? "",
    }];
  });
}

export function parseAttachmentReports(text: string): AttachmentReport[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const headings = [...normalized.matchAll(/^##\s+\[(A\d{2,3})\]\s+(.+?)\s*$/gm)];
  return headings.map((heading, index) => {
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? normalized.length;
    return {
      id: heading[1],
      title: heading[2].trim(),
      body: normalized.slice(start, end).trim(),
    };
  });
}

function reportMap(messages: Message[], items: AgentItem[], afterSequence: number, manifest: AttachmentManifestEntry[], activeRunId?: string) {
  const reports = new Map<string, AttachmentReport>();
  const correctionTargets = messages.flatMap((message) => {
    if (
      message.sequence <= afterSequence ||
      message.role !== "user" ||
      !message.text.startsWith(ATTACHMENT_CORRECTION_MARKER)
    ) return [];
    const id = message.text.match(/【目标附件】\nID: (A\d{2,3})\n/)?.[1];
    return id ? [{ sequence: message.sequence, id }] : [];
  });
  const candidates = [
    ...messages
      .filter((message) => message.sequence > afterSequence && message.role === "assistant" && message.kind !== "progress")
      .map((message) => ({ sequence: message.sequence, text: message.text })),
    ...items.flatMap((record) =>
      record.sequence > afterSequence && record.item.type === "agent_message"
        ? [{ sequence: record.sequence, text: record.item.text, isActiveOutput: record.runId === activeRunId }]
        : [],
    ),
  ].sort((left, right) => left.sequence - right.sequence);

  for (const candidate of candidates) {
    const parsed = parseAttachmentReports(candidate.text);
    for (const report of parsed) reports.set(report.id, report);
    const correctionTarget = correctionTargets
      .filter((target) => target.sequence < candidate.sequence)
      .at(-1)?.id;
    const fallback = correctionTarget
      ? manifest.find((entry) => entry.id === correctionTarget)
      : manifest.length === 1 ? manifest[0] : undefined;
    // A streaming progress sentence is not a report, even for a single attachment.
    if (!parsed.length && fallback && candidate.text.trim() && !("isActiveOutput" in candidate && candidate.isActiveOutput)) {
      reports.set(fallback.id, {
        id: fallback.id,
        title: fallback.name,
        body: candidate.text.trim(),
      });
    }
  }
  return reports;
}

function extractCorrections(messages: Message[], afterSequence: number): AttachmentCorrection[] {
  return messages.flatMap((message) => {
    if (
      message.sequence <= afterSequence ||
      message.role !== "user" ||
      !message.text.startsWith(ATTACHMENT_CORRECTION_MARKER)
    ) return [];
    const target = message.text.match(/【目标附件】\nID: ([^\n]+)\n路径: ([^\n]+)\n名称: ([^\n]+)\n\n【人工纠偏】/);
    const correction = message.text.match(/【人工纠偏】\n([\s\S]*?)\n\n【更新要求】/);
    return target && correction?.[1]?.trim()
      ? [{
          id: message.id,
          targetId: target[1].trim(),
          targetPath: normalizePath(target[2].trim()),
          targetName: target[3].trim(),
          text: correction[1].trim(),
          createdAt: message.createdAt,
        }]
      : [];
  });
}

const CORRECTION_MIN = 280;
const CORRECTION_MAX = 560;

function initialCorrectionWidth() {
  const stored = Number(readPreference("nexiom.attachmentCorrectionWidth"));
  return Number.isFinite(stored)
    ? Math.min(CORRECTION_MAX, Math.max(CORRECTION_MIN, stored))
    : 360;
}

export function AttachmentWorkspace({
  projectName,
  messages,
  agentItems,
  files,
  activeRun,
  latestRun,
  busy,
  modelReady,
  onCorrect,
  onImport,
  onOpenFile,
  onConfigureModel,
  onCancel,
}: AttachmentWorkspaceProps) {
  const startMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user" && message.text.startsWith(ATTACHMENT_TASK_MARKER));
  const startSequence = startMessage?.sequence ?? -1;
  const manifest = useMemo(
    () => startMessage ? parseAttachmentManifest(startMessage.text, files) : [],
    [startMessage, files],
  );
  const reports = useMemo(
    () => reportMap(messages, agentItems, startSequence, manifest, activeRun?.id),
    [messages, agentItems, startSequence, manifest, activeRun?.id],
  );
  const corrections = useMemo(
    () => extractCorrections(messages, startSequence),
    [messages, startSequence],
  );
  const [activePath, setActivePath] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(() => window.innerWidth >= 1180);
  const [correctionWidth, setCorrectionWidth] = useState(initialCorrectionWidth);
  const [correctionDrafts, setCorrectionDrafts] = useState<Record<string, string>>({});
  const [restarting, setRestarting] = useState(false);
  const analysisFeed = useRef<HTMLDivElement>(null);
  const correctionResize = useRef({ active: false, pointerId: -1, startX: 0, startWidth: 360, currentWidth: 360 });
  const hasReport = reports.size > 0;
  const selectedEntry = manifest.find((entry) => entry.path === activePath) ?? manifest[0];
  const selectedReport = selectedEntry ? reports.get(selectedEntry.id) : undefined;
  const selectedFile = selectedEntry
    ? files.find((file) => normalizePath(file.path) === selectedEntry.path) ?? selectedEntry
    : undefined;
  const targetCorrections = selectedEntry
    ? corrections.filter((correction) => correction.targetPath === selectedEntry.path)
    : [];
  const correctionDraft = selectedEntry ? correctionDrafts[selectedEntry.path] ?? "" : "";
  const failed = !!startMessage && latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status);
  const currentTaskKind = activeRun ? getCurrentAgentTaskKind(agentItems, activeRun.id) : "thinking";
  const runOutcome = activeRun ? "running" : latestRun?.status === "succeeded" ? "completed" : latestRun?.status;
  const analysisItems = useMemo(() => agentItems
    .filter((record) => record.runId === activeRun?.id && record.item.type !== "reasoning")
    .sort((left, right) => left.sequence - right.sequence), [agentItems, activeRun?.id]);

  useEffect(() => {
    if (hasReport || !activeRun) return;
    const node = analysisFeed.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [activeRun, analysisItems, hasReport]);

  useEffect(() => {
    if (!manifest.length) return;
    if (!manifest.some((entry) => entry.path === activePath)) setActivePath(manifest[0].path);
  }, [manifest, activePath]);

  const correct = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedEntry || !correctionDraft.trim() || busy || activeRun) return;
    onCorrect(correctionDraft.trim(), selectedEntry);
    setCorrectionDrafts((current) => ({ ...current, [selectedEntry.path]: "" }));
  };

  const setCorrectionPanelWidth = (width: number, persist = false) => {
    const available = Math.max(CORRECTION_MIN, window.innerWidth - 620);
    const next = Math.min(CORRECTION_MAX, available, Math.max(CORRECTION_MIN, width));
    correctionResize.current.currentWidth = next;
    setCorrectionWidth(next);
    if (persist) writePreference("nexiom.attachmentCorrectionWidth", String(Math.round(next)));
  };

  const beginCorrectionResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth <= 760) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    correctionResize.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: correctionWidth,
      currentWidth: correctionWidth,
    };
  };

  const moveCorrectionResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!correctionResize.current.active || correctionResize.current.pointerId !== event.pointerId) return;
    setCorrectionPanelWidth(correctionResize.current.startWidth + correctionResize.current.startX - event.clientX);
  };

  const finishCorrectionResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!correctionResize.current.active || correctionResize.current.pointerId !== event.pointerId) return;
    correctionResize.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    writePreference("nexiom.attachmentCorrectionWidth", String(Math.round(correctionResize.current.currentWidth)));
  };

  const resizeCorrectionWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") setCorrectionPanelWidth(CORRECTION_MIN, true);
    else if (event.key === "End") setCorrectionPanelWidth(CORRECTION_MAX, true);
    else setCorrectionPanelWidth(correctionWidth + (event.key === "ArrowLeft" ? 16 : -16), true);
  };

  if ((!hasReport && !activeRun) || restarting) {
    return (
      <section className="reading-intake" aria-labelledby="attachment-intake-title">
        {hasReport && restarting && (
          <button type="button" className="reading-back-button" onClick={() => setRestarting(false)}>
            <ArrowLeft size={16} />返回分析报告
          </button>
        )}
        <div className="reading-intake-content">
          <div className="reading-intake-heading">
            <WorkspaceLogo dimension="attachments" className="reading-intake-logo" />
            <h1 id="attachment-intake-title">导入附件</h1>
          </div>
          <div className="reading-intake-layout">
            <div className="reading-file-intake">
              <button
                type="button"
                className="reading-file-picker"
                onClick={modelReady ? onImport : onConfigureModel}
                disabled={busy}
              >
                <FileUp size={19} />{busy ? "正在导入" : modelReady ? "导入附件" : "先配置模型"}
              </button>
              {failed && <div className="reading-run-error" role="alert"><AgentTaskStatus compact status={latestRun!.status === "failed" ? "failed" : latestRun!.status === "cancelled" ? "cancelled" : "interrupted"} /><p>上次分析未完成，请重新导入附件。</p></div>}
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (!hasReport && activeRun) {
    return (
      <section className="reading-analyzing attachment-analyzing" aria-labelledby="attachment-analysis-title" aria-busy="true">
        <div className="reading-analysis-shell">
          <header className="reading-analysis-header">
            <div className="reading-analysis-title">
              <WorkspaceLogo dimension="attachments" className="reading-intake-logo analyzing" />
              <div>
                <span className="reading-eyebrow"><Paperclip size={14} />{projectName}</span>
                <h1 id="attachment-analysis-title">正在分析附件</h1>
                <p>读取、核查和整理的实际步骤会显示在下方，报告生成后自动进入附件工作台。</p>
              </div>
            </div>
            <button type="button" className="secondary-button" onClick={onCancel}>停止分析</button>
          </header>
          <div className="reading-analysis-grid">
            <aside className="reading-analysis-materials" aria-label="本轮分析附件">
              <div className="reading-analysis-card-heading">
                <Paperclip size={16} />
                <div><strong>本轮附件</strong><span>{manifest.length} 个文件</span></div>
              </div>
              <div className="reading-analysis-file-list">
                {manifest.map((entry, index) => (
                  <div key={entry.path} className="reading-analysis-file">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{entry.name}</strong><small>已加入分析上下文</small></div>
                    <CheckCircle2 size={15} />
                  </div>
                ))}
              </div>
            </aside>
            <div className="reading-analysis-process">
              <div className="reading-analysis-process-heading">
                <div><strong>实时分析过程</strong><span>按实际任务切换状态，不预设进度</span></div>
                <span className="reading-analysis-live"><AgentTaskStatus kind={currentTaskKind} compact /></span>
              </div>
              <div ref={analysisFeed} className="reading-analysis-feed" aria-live="polite" aria-relevant="additions text">
                <div className="reading-analysis-event completed">
                  <span className="reading-analysis-event-icon"><AgentTaskIcon status="completed" size={26} /></span>
                  <div><strong>附件分析任务已启动</strong><p>已接收 {manifest.length} 个附件，开始检查材料。</p></div>
                </div>
                {analysisItems.map((record) => {
                  const item = record.item;
                  const kind = getAgentTaskKind(item);
                  const outcome = getAgentItemOutcome(record);
                  const detail = item.type === "command_execution" ? item.command
                    : item.type === "mcp_tool_call" ? `${item.server} · ${item.tool}`
                    : item.type === "native_tool_call" ? item.tool
                    : item.type === "web_search" ? item.query
                    : item.type === "file_change" ? item.changes.map((change) => change.path).join("、")
                    : item.type === "error" ? item.message : "";
                  return (
                    <div key={record.id} className={`reading-analysis-event ${outcome}`}>
                      <span className="reading-analysis-event-icon"><AgentTaskIcon kind={kind} status={outcome} /></span>
                      <div className="reading-analysis-event-content">
                        <strong><AgentTaskLabel kind={kind} status={outcome} /></strong>
                        {detail && <p>{detail}</p>}
                        {item.type === "agent_message" && <RichText text={item.text} />}
                        {item.type === "todo_list" && <div className="reading-analysis-plan">
                          {item.items.map((step, index) => <span key={index} className={step.completed ? "done" : ""}>
                            {step.completed ? <CheckCircle2 size={14} /> : <Square size={13} />}{step.text}
                          </span>)}
                        </div>}
                      </div>
                    </div>
                  );
                })}
                {!analysisItems.length && <div className="reading-analysis-event running">
                  <span className="reading-analysis-event-icon"><AgentTaskIcon kind={currentTaskKind} /></span>
                  <div><strong><AgentTaskLabel kind={currentTaskKind} /></strong><p>首个分析步骤到达后会显示在这里。</p></div>
                </div>}
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`reading-workspace attachment-workspace ${correctionOpen ? "" : "correction-closed"}`}
      style={{ "--reading-correction-width": `${correctionWidth}px` } as CSSProperties}
    >
      <header className="reading-report-header">
        <div className="reading-report-title">
          <WorkspaceLogo dimension="attachments" />
          <div>
            <span className="reading-eyebrow"><Paperclip size={14} />{projectName}</span>
            <h1>附件分析报告</h1>
            <p>{activeRun ? `正在更新 ${selectedEntry?.name ?? "当前附件"}` : `已生成 ${reports.size} / ${manifest.length} 个附件报告`}</p>
          </div>
        </div>
        <div className="reading-report-actions">
          {runOutcome && <AgentTaskStatus kind={currentTaskKind} status={runOutcome} compact final />}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setRestarting(true);
            }}
            disabled={!!activeRun}
          >
            <ArrowLeft size={15} />导入新附件
          </button>
          <button
            type="button"
            className={`secondary-button ${correctionOpen ? "active" : ""}`}
            aria-expanded={correctionOpen}
            onClick={() => setCorrectionOpen((value) => !value)}
          >
            {correctionOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            人工纠偏
            {!!targetCorrections.length && <span className="reading-correction-count">{targetCorrections.length}</span>}
          </button>
        </div>
      </header>
      <div className="reading-workspace-grid">
        <nav className="reading-outline attachment-outline" aria-label="附件报告目录">
          <span className="reading-outline-label">本次分析附件</span>
          {manifest.map((entry, index) => {
            const count = corrections.filter((correction) => correction.targetPath === entry.path).length;
            const ready = reports.has(entry.id);
            return (
              <button
                type="button"
                key={entry.path}
                className={selectedEntry?.path === entry.path ? "active" : ""}
                aria-current={selectedEntry?.path === entry.path ? "page" : undefined}
                onClick={() => setActivePath(entry.path)}
                title={entry.path}
              >
                <span className="reading-outline-index">{String(index + 1).padStart(2, "0")}</span>
                {ready ? <CheckCircle2 size={16} /> : <CircleDotDashed size={16} />}
                <span className="attachment-outline-name">{entry.name}</span>
                {!!count && <span className="attachment-outline-count">{count}</span>}
              </button>
            );
          })}
        </nav>
        <article className="reading-report-body" aria-live="polite">
          {activeRun && <div className="reading-updating"><AgentTaskStatus kind={currentTaskKind} compact />当前附件报告正在更新，其他附件保持不变</div>}
          {selectedEntry && (
            <div className="reading-section-heading attachment-section-heading">
              <span><FileText size={18} /></span>
              <div>
                <small>{selectedEntry.path}</small>
                <h2>{selectedEntry.name}</h2>
              </div>
              {selectedFile && (
                <button type="button" className="secondary-button" onClick={() => onOpenFile(selectedFile)}>查看原附件</button>
              )}
            </div>
          )}
          {selectedReport ? (
            <RichText text={selectedReport.body || "当前附件报告暂无内容。"} />
          ) : (
            <div className="attachment-report-missing">
              <AlertTriangle size={22} />
              <strong>这个附件还没有形成可读取的报告</strong>
              <p>{activeRun ? "分析仍在进行，完成后会自动显示。" : "本轮输出可能不完整，请返回附件选择后重新分析。"}</p>
            </div>
          )}
        </article>
        {correctionOpen && (
          <>
            <div
              className="reading-correction-resizer"
              role="separator"
              aria-label="调整当前附件人工纠偏区域宽度"
              aria-orientation="vertical"
              aria-valuemin={CORRECTION_MIN}
              aria-valuemax={CORRECTION_MAX}
              aria-valuenow={Math.round(correctionWidth)}
              tabIndex={0}
              onPointerDown={beginCorrectionResize}
              onPointerMove={moveCorrectionResize}
              onPointerUp={finishCorrectionResize}
              onPointerCancel={finishCorrectionResize}
              onDoubleClick={() => setCorrectionPanelWidth(360, true)}
              onKeyDown={resizeCorrectionWithKeyboard}
            />
            <aside className="reading-correction-panel" aria-label={`${selectedEntry?.name ?? "当前附件"}的人工纠偏`}>
              <header>
                <div><MessageSquareText size={18} /><strong>附件独立纠偏</strong></div>
                <span className="reading-correction-target">{selectedEntry?.name}</span>
              </header>
              <div className="reading-correction-history" aria-label="当前附件纠偏记录">
                {!targetCorrections.length && (
                  <div className="reading-correction-empty">
                    <MessageSquareText size={23} />
                    <p>当前附件还没有纠偏记录</p>
                    <span>这里的修改只会更新这个附件的报告。</span>
                  </div>
                )}
                {targetCorrections.map((correction, index) => (
                  <div className="reading-correction-item" key={correction.id}>
                    <span>纠偏 {String(index + 1).padStart(2, "0")}</span>
                    <p>{correction.text}</p>
                    <small>{new Date(correction.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
                  </div>
                ))}
              </div>
              <form className="reading-correction-form" onSubmit={correct}>
                <textarea
                  aria-label={`纠偏${selectedEntry?.name ?? "当前附件"}`}
                  placeholder="说明这个附件哪里识别错了、遗漏了什么，或应采用什么口径……"
                  value={correctionDraft}
                  maxLength={4000}
                  disabled={busy || !!activeRun || !selectedEntry}
                  onChange={(event) => {
                    if (!selectedEntry) return;
                    setCorrectionDrafts((current) => ({ ...current, [selectedEntry.path]: event.target.value }));
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
                    <button className="reading-correction-send" aria-label="提交当前附件纠偏" disabled={!correctionDraft.trim() || busy || !selectedEntry}>
                      <Send size={15} />
                    </button>
                  )}
                </div>
              </form>
            </aside>
          </>
        )}
      </div>
    </section>
  );
}
