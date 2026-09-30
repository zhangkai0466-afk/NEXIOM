import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Circle, FileText, FileUp, MessageSquareText, PanelRightClose, PanelRightOpen, Paperclip, RotateCcw, Send, Square } from "lucide-react";
import type { AgentItem, Message, ProjectFile, Run } from "../../../packages/contracts";
import { ATTACHMENT_TASK_MARKER, ATTACHMENT_CORRECTION_MARKER, attachmentTargets, type AttachmentTarget } from "../../../packages/contracts/attachment-workflow";
import { RichText } from "./AgentOutput";
import { AgentTaskIcon, AgentTaskStatus } from "./AgentTaskStatus";
import { attachmentAnalysis } from "./attachment-progress";
import { getAgentItemOutcome } from "./agent-task-state";
import { AttachmentPaneDivider } from "./AttachmentPaneDivider";
import { readPreference, writePreference } from "./preferences";
import "./attachment-workspace.css";
import { AutoTextarea } from "./AutoTextarea";
import { WorkspaceHeading } from "./WorkspaceHeading";

export { ATTACHMENT_TASK_MARKER, ATTACHMENT_CORRECTION_MARKER, ATTACHMENT_ANALYSIS_LIMIT } from "../../../packages/contracts/attachment-workflow";
export { parseAttachmentReports } from "./attachment-progress";
export type AttachmentCorrectionTarget = AttachmentTarget;

interface AttachmentWorkspaceProps {
  projectName: string;
  messages: Message[];
  agentItems: AgentItem[];
  files: ProjectFile[];
  runs?: Run[];
  activeRun?: Run;
  latestRun?: Run;
  busy: boolean;
  modelReady: boolean;
  onCorrect: (correction: string, target: AttachmentTarget) => void;
  onRetry: (targets: AttachmentTarget[]) => void;
  onImport: () => void;
  onOpenFile: (file: ProjectFile) => void;
  onConfigureModel: () => void;
  onCancel: () => void;
}

const normalizePath = (value: string) => value.replaceAll("\\", "/");
export function parseAttachmentManifest(text: string, files: ProjectFile[] = []) {
  return attachmentTargets(text).map(target => {
    const file = files.find(file => normalizePath(file.path) === target.path);
    return { ...target, name: file?.name ?? target.name, size: file?.size ?? 0, extension: file?.extension ?? "" };
  });
}

function extractCorrections(messages: Message[], after: number) {
  return messages.flatMap(message => {
    if (message.sequence <= after || message.role !== "user" || !message.text.startsWith(ATTACHMENT_CORRECTION_MARKER)) return [];
    const target = attachmentTargets(message.text)[0];
    const text = message.text.match(/【人工纠偏】\n([\s\S]*?)\n\n【更新要求】/)?.[1]?.trim();
    return target && text ? [{ id: message.id, targetPath: target.path, text, createdAt: message.createdAt }] : [];
  });
}
function initialWidth(key: string, fallback: number, min: number, max: number) {
  const stored = Number(readPreference(key));
  return Number.isFinite(stored) && stored > 0 ? Math.min(max, Math.max(min, stored)) : fallback;
}
const phaseNames = { reading: "阅读", analyzing: "分析", thinking: "思考", writing: "输出" };
const statusNames = { pending: "未开始", running: "进行中", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "未完成" };

export function AttachmentWorkspace({
  projectName, messages, agentItems, files, runs = [], activeRun, latestRun, busy, modelReady,
  onCorrect, onRetry, onImport, onOpenFile, onConfigureModel, onCancel,
}: AttachmentWorkspaceProps) {
  const start = messages.filter(message => message.role === "user" && message.text.startsWith(ATTACHMENT_TASK_MARKER))
    .sort((a, b) => b.sequence - a.sequence)[0];
  const states = useMemo(() => attachmentAnalysis(messages, agentItems, [...new Map([...runs, latestRun, activeRun]
    .filter((run): run is Run => !!run).map(run => [run.id, run])).values()]), [messages, agentItems, runs, latestRun, activeRun]);
  const corrections = useMemo(() => extractCorrections(messages, start?.sequence ?? -1), [messages, start?.sequence]);
  const [activePath, setActivePath] = useState("");
  const followCurrent = useRef(true);
  const [restarting, setRestarting] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(() => initialWidth("nexiom.attachmentOutlineWidth", 240, 180, 420));
  const [correctionWidth, setCorrectionWidth] = useState(() => initialWidth("nexiom.attachmentCorrectionWidth", 360, 280, 560));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [paneWidth, setPaneWidth] = useState(1000);
  const layout = useRef<HTMLDivElement>(null);
  const current = states.find(state => state.runId === activeRun?.id && state.status === "running");
  const selected = states.find(state => state.target.path === activePath) ?? current ?? states[0];
  const selectedFile = files.find(file => normalizePath(file.path) === selected?.target.path);
  const targetCorrections = corrections.filter(correction => correction.targetPath === selected?.target.path);
  const draft = selected ? drafts[selected.target.path] ?? "" : "";
  const finished = states.filter(state => state.status === "completed").length;
  const unfinished = states.filter(state => state.status !== "completed").map(state => state.target);
  const failed = !!start && !activeRun && latestRun && ["failed", "cancelled", "interrupted"].includes(latestRun.status);
  const missingReport = !!start && !activeRun && unfinished.length > 0;
  const kind = current?.steps.find(step => step.status === "running")?.phase;
  const outlineMax = Math.max(180, Math.min(420, paneWidth - 368 - (correctionOpen ? correctionWidth + 8 : 0)));
  const correctionMax = Math.max(280, Math.min(560, paneWidth - Math.min(outlineWidth, outlineMax) - 376));
  const rawOutput = agentItems.filter(record => record.sequence > (start?.sequence ?? -1) && record.item.type === "agent_message");
  const failureMessage = failed ? [...messages].reverse().find(message => message.sequence > (start?.sequence ?? -1) &&
    message.role === "assistant" && message.kind === "answer")?.text : undefined;

  useEffect(() => {
    followCurrent.current = true;
    setActivePath("");
    setRestarting(false);
  }, [start?.id]);
  useEffect(() => {
    if (current && followCurrent.current) setActivePath(current.target.path);
  }, [current?.target.path, start?.id]);
  useEffect(() => {
    const node = layout.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setPaneWidth(node.clientWidth));
    observer.observe(node);
    setPaneWidth(node.clientWidth);
    return () => observer.disconnect();
  }, [!!start, restarting]);

  const correct = (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !draft.trim() || busy || activeRun) return;
    onCorrect(draft.trim(), selected.target);
    setDrafts(current => ({ ...current, [selected.target.path]: "" }));
  };

  if ((!start && !activeRun) || restarting) return (
    <section className="reading-intake workspace-intake" aria-labelledby="attachment-intake-title">
      <header className="workspace-state-header"><WorkspaceHeading dimension="attachments" projectName={projectName} title="附件分析"/></header>
      {start && <button type="button" className="reading-back-button" onClick={() => setRestarting(false)}><ArrowLeft size={16} />返回附件工作台</button>}
      <div className="reading-intake-content">
        <div className="reading-intake-heading"><h2 id="attachment-intake-title">导入附件</h2></div>
        <div className="reading-intake-layout">
          <div className="reading-file-intake"><button type="button" className="reading-file-picker" onClick={modelReady ? onImport : onConfigureModel} disabled={busy}>
            <FileUp size={19} />{busy ? "正在导入" : modelReady ? "导入附件" : "先配置模型"}
          </button></div>
        </div>
      </div>
    </section>
  );

  return (
    <section className={"reading-workspace attachment-workspace " + (correctionOpen ? "" : "correction-closed")}
      style={{ "--attachment-outline-width": Math.min(outlineWidth, outlineMax) + "px", "--reading-correction-width": Math.min(correctionWidth, correctionMax) + "px" } as CSSProperties}>
      <header className="reading-report-header">
        <WorkspaceHeading dimension="attachments" projectName={projectName} title="附件分析" detail={`${current ? "正在分析：" + current.target.name + " · " : ""}已完成 ${finished} / ${states.length} 个附件`}/>
        <div className="reading-report-actions">
          {activeRun && kind && <AgentTaskStatus kind={kind} compact label={phaseNames[kind] + "中"} />}
          {activeRun ? <button type="button" className="secondary-button" onClick={onCancel}><Square size={14} />停止分析</button>
            : <button type="button" className="secondary-button" onClick={() => setRestarting(true)} disabled={busy}><FileUp size={15} />导入新附件</button>}
          <button type="button" className={"secondary-button " + (correctionOpen ? "active" : "")} aria-expanded={correctionOpen} onClick={() => setCorrectionOpen(value => !value)}>
            {correctionOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}人工纠偏
          </button>
        </div>
      </header>
      {(failed || missingReport) && <div className="attachment-run-notice" role="alert">
        <AlertTriangle size={17} /><div>
          <strong>{failed ? latestRun?.status === "cancelled" ? "分析已停止" : "本轮分析未完成" : "部分附件尚未生成完整报告"}</strong>
          <p>已收到的报告和进度保留在下方，可以单独重试或继续未完成的附件。</p>
          {failureMessage && <details><summary>查看原因</summary><p>{failureMessage}</p></details>}
        </div>
        {!!unfinished.length && <button type="button" className="secondary-button" disabled={busy || !modelReady} onClick={() => onRetry(unfinished)}><RotateCcw size={14} />继续未完成附件</button>}
      </div>}
      <div ref={layout} className="attachment-workspace-layout">
        <div className="attachment-workspace-grid">
          <nav className="reading-outline attachment-outline" aria-label="本次分析附件">
            <span className="reading-outline-label">逐个分析附件</span>
            {states.map((state, index) => <button type="button" key={state.target.path} title={state.target.path}
              className={selected?.target.path === state.target.path ? "active" : ""} aria-current={selected?.target.path === state.target.path ? "page" : undefined}
              onClick={() => { followCurrent.current = false; setActivePath(state.target.path); }}>
              <span className="attachment-file-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="attachment-file-label"><strong>{state.target.name}</strong><small data-status={state.status}>{statusNames[state.status]}</small></span>
              {state.status === "completed" && <CheckCircle2 size={15} />}
            </button>)}
            {current && selected?.target.id !== current.target.id && <button type="button" onClick={() => { followCurrent.current = true; setActivePath(current.target.path); }}>查看当前分析附件</button>}
          </nav>
          <AttachmentPaneDivider label="调整附件列表宽度" area="outline-resizer" width={Math.min(outlineWidth, outlineMax)} min={180} max={outlineMax}
            onChange={setOutlineWidth} onCommit={width => writePreference("nexiom.attachmentOutlineWidth", String(width))} />
          <article className="reading-report-body attachment-report" aria-label={selected ? selected.target.name + "的分析" : "附件分析内容"}>
            {selected ? <>
              <div className="reading-section-heading attachment-section-heading"><span><FileText size={18} /></span><div>
                <small>{selected.target.path}</small><h2>{selected.target.name}</h2>
              </div>{selectedFile && <button type="button" className="secondary-button" onClick={() => onOpenFile(selectedFile)}>查看原附件</button>}</div>
              {selected.report && !selected.runId ? <p className="attachment-progress-note">已恢复这份历史报告；旧任务未记录每个附件的四阶段进度。</p> : <ol className="attachment-phase-chain" aria-label={selected.target.name + "的四阶段进度"} aria-live="polite">
                {selected.steps.map(step => <li key={step.phase} data-status={step.status}>
                  {step.status === "pending" ? <Circle size={28} strokeWidth={1.5} aria-hidden="true" /> : <AgentTaskIcon kind={step.phase} status={step.status} size={28} />}
                  <strong>{phaseNames[step.phase]}</strong><small>{statusNames[step.status]}</small>
                </li>)}
              </ol>}
              {selected.status === "running" && <p className="attachment-progress-note">每个阶段按实际工作推进，读取和核查较多时会持续一段时间。</p>}
              {selected.status === "pending" && <p className="attachment-progress-note">{activeRun ? "等待前面的附件完成后，单独分析这个附件。" : "这个附件尚未开始，可单独分析或继续未完成附件。"}</p>}
              {["failed", "cancelled", "interrupted"].includes(selected.status) && <p className="attachment-progress-note" role="status">本次分析{statusNames[selected.status]}。{selected.report ? "已保存的报告仍可查看。" : "已保留收到的记录，可以重试这个附件。"}</p>}
              {selected.report ? <div className="attachment-saved-report"><RichText text={selected.report.body} /></div>
                : <div className="attachment-report-placeholder"><FileText size={22} /><span>该附件完成输出后，报告会显示在这里。</span></div>}
              {!activeRun && <button type="button" className="secondary-button" disabled={busy || !modelReady} onClick={() => onRetry([selected.target])}><RotateCcw size={14} />{selected.status === "pending" ? "分析这个附件" : "重新分析这个附件"}</button>}
              {!!selected.records.length && <details className="attachment-analysis-technical attachment-records">
                <summary>查看这个附件的执行记录</summary>
                {selected.records.map(record => {
                  const item = record.item;
                  if (item.type === "command_execution") return <details key={record.id}><summary>内部处理 · {statusNames[getAgentItemOutcome(record)]}</summary><pre>{item.command}</pre>{item.aggregated_output && <pre>{item.aggregated_output}</pre>}</details>;
                  if (item.type === "agent_message") return <div key={record.id}><RichText text={item.text} /></div>;
                  return null;
                })}
              </details>}
            </> : <div className="attachment-report-placeholder"><AlertTriangle size={22} /><p>尚未识别附件清单，已保留本轮记录，请重新导入需要分析的附件。</p></div>}
            {!activeRun && rawOutput.length > 0 && !states.some(state => state.report) && <details className="attachment-analysis-technical">
              <summary>查看已收到的原始输出</summary>
              {rawOutput.map(record => record.item.type === "agent_message" && <RichText key={record.id} text={record.item.text} />)}
            </details>}
          </article>
          {correctionOpen && <>
            <AttachmentPaneDivider label="调整当前附件人工纠偏区域宽度" area="resizer" width={Math.min(correctionWidth, correctionMax)} min={280} max={correctionMax} reverse
              onChange={setCorrectionWidth} onCommit={width => writePreference("nexiom.attachmentCorrectionWidth", String(width))} />
            <aside className="reading-correction-panel" aria-label={(selected?.target.name ?? "当前附件") + "的人工纠偏"}>
              <header><div><MessageSquareText size={18} /><strong>附件独立纠偏</strong></div><span className="reading-correction-target">{selected?.target.name}</span></header>
              <div className="reading-correction-history">
                {!targetCorrections.length && <div className="reading-correction-empty"><MessageSquareText size={23} /><p>当前附件还没有纠偏记录</p><span>这里的修改只更新这个附件的报告。</span></div>}
                {targetCorrections.map((correction, index) => <div className="reading-correction-item" key={correction.id}><span>纠偏 {index + 1}</span><p>{correction.text}</p><small>{new Date(correction.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small></div>)}
              </div>
                <form className="reading-correction-form compact-correction-form" onSubmit={correct}>
                  <AutoTextarea aria-label={"纠偏" + (selected?.target.name ?? "当前附件")} placeholder="讨论当前附件…"
                  value={draft} maxLength={4000} disabled={busy || !!activeRun || !selected}
                  onChange={event => { if (selected) setDrafts(current => ({ ...current, [selected.target.path]: event.target.value })); }}
                  onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); correct(event); } }} />
                <div><button className="reading-correction-send" aria-label="提交当前附件纠偏" disabled={!draft.trim() || busy || !!activeRun || !selected}><Send size={15} /></button></div>
              </form>
            </aside>
          </>}
        </div>
      </div>
    </section>
  );
}
