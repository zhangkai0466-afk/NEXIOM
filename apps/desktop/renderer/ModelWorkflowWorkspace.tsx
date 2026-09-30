import { useEffect, useState } from "react";
import { CheckCircle2, GitBranch, Play, RotateCcw, ShieldCheck, Square } from "lucide-react";
import type { Project, Snapshot, Thread } from "../../../packages/contracts";
import { routeLabel, type ModelRoute, type WorkflowAction, type WorkflowState } from "../../../packages/contracts/workflow";
import { request } from "./bridge";
import { RichText, AgentOutput } from "./AgentOutput";
import "./workflow.css";
import { ProjectOverview } from "./ProjectOverview";
import type { OverviewStage } from "./project-status";
import { WorkspaceHeading } from "./WorkspaceHeading";

export function ModelWorkflowWorkspace({ project, snapshot, stage, selectedThread, selectedQuestionId, onChanged, onOpenFile, onNavigate }: {
  project: Project; snapshot: Snapshot; stage: "model" | "validation" | "overview"; selectedThread?: Thread; selectedQuestionId?: string;
  onChanged: () => Promise<void>; onOpenFile: (path: string) => void;
  onNavigate?: (stage: OverviewStage, threadId?: string) => void;
}) {
  const [state, setState] = useState<WorkflowState>();
  const [questionId, setQuestionId] = useState(selectedQuestionId ?? "");
  useEffect(() => { if (selectedQuestionId) setQuestionId(selectedQuestionId); }, [selectedQuestionId]);
  const [route, setRoute] = useState<ModelRoute>("collaborative");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  async function exportFiles(relative: string) {
    setExporting(true); setError("");
    try { const result = await request({ type: "workflow.export", projectId: project.id, path: relative }); setNotice(result.exported?.pdfReady ? "Markdown、Word 和 PDF 已保存在成果目录。" : "Word 已保存；PDF 自动导出需在 NEXIOM 桌面版中运行。"); }
    catch (error) { setError((error as Error).message); } finally { setExporting(false); }
  }
  const signature = snapshot.runs.filter(r => r.projectId === project.id).map(r => r.id + r.status).join("|");
  useEffect(() => {
    let active = true;
    void request({ type: "workflow.read", projectId: project.id }).then(result => { if (active) { setState(result.workflow); setError(""); } }).catch(e => { if (active) setError(String(e.message)); });
    return () => { active = false; };
  }, [project.id, signature]);
  useEffect(() => {
    if (selectedThread?.questionId) setQuestionId(selectedThread.questionId);
    if (selectedThread?.title.includes("AI独立建模")) setRoute("independent");
    else if (selectedThread?.title.includes("协同AI建模")) setRoute("collaborative");
  }, [selectedThread?.id]);
  const question = state?.questions.find(q => q.id === questionId) ?? state?.questions[0];
  const branch = question?.[route];
  const jobs = branch?.jobs.filter(j => stage === "validation" ? j.task === "validation" : j.task !== "validation") ?? [];
  const job = jobs.at(-1);
  const running = snapshot.runs.find(r => r.projectId === project.id && r.status === "running");
  const outputs = snapshot.items.filter(item => item.runId === job?.runId);
  const history = snapshot.messages.filter(message => message.threadId === job?.threadId && message.role === "assistant" && message.kind !== "progress");
  const hasSolution = branch?.jobs.some(j => ["model", "revision"].includes(j.task) && j.status === "succeeded" && j.artifactReady);
  async function change(action: WorkflowAction) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request({ type: "workflow.update", projectId: project.id, change: action });
      setState(result.workflow); await onChanged();
      if (action.action === "feedback") { setDraft(""); setNotice("反馈已保存到来源路线的记忆文件。切换到开始建模，发起协同修订。"); }
      if (action.action === "confirm") setNotice("已确认当前版本。所有问题确认后会自动汇总最终模型。");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const start = (task: "analysis" | "model" | "validation" | "revision") => question && void change({ action: "start", questionId: question.id, route, task, text: draft });
  if (stage === "overview") return <section className="workflow-workspace">
    <ProjectOverview project={project} snapshot={snapshot} workflow={state} onNavigate={(stage, threadId) => onNavigate?.(stage, threadId)} />
    {error && <p role="alert" className="form-error">{error}</p>}
    <details id="project-final-models" className="project-final-models"><summary>最终模型与交付核对 · {state?.questions.filter(q => q.selected).length ?? 0} / {state?.questions.length ?? 0} 问已确认</summary>
    {!state?.questions.length && <p>完成赛题研读后，这里会自动生成问题清单。</p>}
    {state?.questions.map(q => <article key={q.id} className="workflow-question-summary"><h2>{q.name}</h2><p>{q.selected ? `已选择：${routeLabel(q.selected.route)} · ${new Date(q.selected.confirmedAt).toLocaleString()}` : "尚未确认最终模型"}</p>{(["independent", "collaborative"] as const).map(r => {
      const solution = q[r].jobs.filter(j => ["model", "revision"].includes(j.task) && j.status === "succeeded" && j.artifactReady).at(-1);
      return solution && <div key={r} className="workflow-actions"><button className="secondary-button" onClick={() => onOpenFile(`${solution.folder}/solution.md`)}>{routeLabel(r)} · 查看方案</button><button className="secondary-button" disabled={busy || !!running} onClick={() => void change({ action: "confirm", questionId: q.id, route: r })}><CheckCircle2 size={15} />确认此版本</button></div>;
    })}</article>)}
    {!!state?.questions.length && state.questions.every(q => q.selected) && <div className="workflow-actions"><button className="primary-button" onClick={() => onOpenFile("modeling/final/最终模型.md")}>查看最终模型汇总</button><button className="secondary-button" disabled={exporting} onClick={() => void exportFiles("modeling/final/最终模型.md")}>导出 Word / PDF</button></div>}
    <h2>交付总控</h2><p>逐项核实论文、代码、结果、支撑材料与图表；题面专属要求另见研读报告。</p>
    {["论文文档", "可复现的求解代码", "数据与支撑材料", "全部小问的结果与检验", "论文所需图表"].map(item => <label className="workflow-check" key={item}><input type="checkbox" checked={!!state?.checks[`delivery:${item}`]} onChange={e => void change({ action: "check", key: `delivery:${item}`, checked: e.target.checked })} disabled={busy} />{item}</label>)}
    </details>{notice && <p role="status">{notice}</p>}
  </section>;
  return <section className="workflow-workspace">
    <header className="workflow-page-heading"><WorkspaceHeading dimension={stage} projectName={project.name} title={stage === "model" ? "开始建模" : "模型检验"}/></header>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!state ? <p>正在读取工作流…</p> : !question ? <div className="workflow-empty"><GitBranch size={32} /><h2>等待赛题研读</h2><p>研读完成后，自动根据每问的标题建立问题分区，无需新建对话。</p></div> : <>
      <nav className="workflow-tabs" aria-label="问题">{state.questions.map(q => <button key={q.id} className={question.id === q.id ? "active" : ""} onClick={() => { setQuestionId(q.id); setDraft(""); }}>{q.name}{q.selected && <CheckCircle2 size={14} />}</button>)}</nav>
      <nav className="workflow-tabs routes" aria-label="建模路线">{(["collaborative", "independent"] as const).map(r => <button key={r} className={route === r ? "active" : ""} onClick={() => { setRoute(r); setDraft(""); }}>{routeLabel(r)}</button>)}</nav>
      <div className="workflow-actions">
        {stage === "model" ? <><button className="secondary-button" disabled={busy || !!running} onClick={() => start("analysis")}>初步建模分析</button><button className="primary-button" disabled={busy || !!running} onClick={() => start("model")}><Play size={15} />{route === "independent" ? "AI 独立建立模型并求解" : "开始共同建模"}</button>{hasSolution && <button className="secondary-button" disabled={busy || !!running} onClick={() => start("revision")}><RotateCcw size={15} />协同修订</button>}</>
          : <button className="primary-button" disabled={busy || !!running || !hasSolution} onClick={() => start("validation")}><ShieldCheck size={16} />检验当前方案</button>}
        {running && <button className="secondary-button" onClick={async () => { try { await request({ type: "run.cancel", runId: running.id }); await onChanged(); } catch (e) { setError((e as Error).message); } }}><Square size={14} />停止任务</button>}
      </div>
      {stage === "validation" && !hasSolution && <p>这条路线还没有完成的建模方案，完成后即可检验。</p>}
      <div className="workflow-discussion"><label htmlFor="workflow-ideas">{stage === "model" ? "你的想法、依据与需要一起推敲的地方" : "把需要修改的问题反馈给上游"}</label><textarea id="workflow-ideas" value={draft} onChange={e => setDraft(e.target.value)} maxLength={12000} placeholder={stage === "model" ? "写下你的思路，我们一起讨论模型、假设和求解方法…" : "引用检验依据，说明模型哪里需要改进…"} />
        {stage === "model" && job && (route === "collaborative" || job.task === "revision") && <button className="secondary-button" disabled={busy || !!running || !draft.trim()} onClick={async () => {
          setBusy(true); setError("");
          try { await request({ type: "agent.submit", threadId: job.threadId, text: draft, clientRequestId: crypto.randomUUID() }); setDraft(""); await onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>继续讨论</button>}
        {stage === "validation" && <button className="secondary-button" disabled={busy || !!running || !hasSolution || !draft.trim()} onClick={() => void change({ action: "feedback", questionId: question.id, route, text: draft })}>保存反馈并返回上游</button>}
      </div>
      {!!branch?.feedback.length && <details><summary>本路线的检验反馈 · {branch.feedback.length} 条</summary>{branch.feedback.map(f => <article key={f.id}><time>{new Date(f.createdAt).toLocaleString()}</time><RichText text={f.text} /></article>)}</details>}
      {job && <div className="workflow-result"><div className="workflow-result-heading"><h2>{job.task === "analysis" ? "初步建模思路" : stage === "validation" ? "检验报告" : "建模进展与成果"}</h2><span>{({ running: "执行中", succeeded: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断" } as Record<string, string>)[snapshot.runs.find(r => r.id === job.runId)?.status ?? job.status]}</span></div><p className="workflow-path">成果目录：{job.folder}</p>
        {outputs.length ? outputs.map(item => <AgentOutput key={item.id} record={item} openFile={onOpenFile} />) : history.length ? history.map(message => <RichText key={message.id} text={message.text} openFile={onOpenFile} />) : <p>等待 Agent 输出。完成的方案和代码会保存在本路线目录。</p>}
        {job.status === "succeeded" && job.artifactReady && <div className="workflow-actions"><button className="secondary-button" onClick={() => onOpenFile(`${job.folder}/${job.task === "analysis" ? "analysis.md" : job.task === "validation" ? "review.md" : "solution.md"}`)}>打开成果文件</button>{["model", "revision"].includes(job.task) && <button className="secondary-button" disabled={exporting} onClick={() => void exportFiles(`${job.folder}/solution.md`)}>导出 Word / PDF</button>}</div>}
        {job.status === "succeeded" && !job.artifactReady && <p role="status">本轮对话已结束，成果文件尚未生成。继续讨论或要求 Agent 完成方案并保存。</p>}
      </div>}
      {jobs.length > 1 && <details><summary>此前版本 · {jobs.length - 1}</summary>{jobs.slice(0, -1).map(j => <article key={j.runId}><button className="secondary-button" onClick={() => onOpenFile(`${j.folder}/response.md`)}>{j.task} · {j.status} · {j.completedAt ? new Date(j.completedAt).toLocaleString() : "未完成"}</button></article>)}</details>}
    </>}
  </section>;
}
