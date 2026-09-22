import { useEffect, useState } from "react";
import { LoaderCircle, RotateCcw } from "lucide-react";
import type { Command, Project, ProjectResetPreview } from "../../../packages/contracts";
import { request } from "./bridge";
import { formatBytes } from "./StorageSettings";
import "./cleanup.css";

export function ProjectResetPanel({ project, busy, running, onClose, onReset }: {
  project: Project; busy: boolean; running: boolean; onClose: () => void;
  onReset: (command: Extract<Command, { type: "project.reset" }>) => Promise<void>;
}) {
  const [preview, setPreview] = useState<ProjectResetPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteGenerated, setDeleteGenerated] = useState(false);
  const [name, setName] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true); setPreview(null); setError("");
    setDeleteGenerated(false); setName("");
    void request({ type: "project.reset.preview", projectId: project.id }).then(response => {
      if (!response.resetPreview) throw new Error("无法读取重置清单，请重试。");
      if (!disposed) setPreview(response.resetPreview);
    }).catch(failure => { if (!disposed) setError((failure as Error).message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [project.id, attempt]);
  const bytes = preview?.generatedFiles.reduce((sum, file) => sum + file.size, 0) ?? 0;
  async function reset() {
    if (!preview || busy || running) return;
    setError("");
    try { await onReset({ type: "project.reset", projectId: project.id, revision: preview.revision, deleteGenerated, confirmationName: name }); }
    catch (failure) { setError((failure as Error).message); }
  }
  return <div className="project-reset-panel">
    <p>重置“{project.name}”后，该赛题将重新开始。此操作无法撤销。</p>
    <code className="cleanup-project-path">{project.root}</code>
    <div className="reset-scope"><strong>将清空</strong><p>全部研读与分析报告、纠偏记录、对话、问题划分、运行记录、项目记忆、上下文和草稿。</p>
      {preview && <span>{preview.threads} 个对话 · {preview.messages} 条消息 · {preview.runs} 次运行</span>}
    </div>
    <div className="reset-scope"><strong>将保留</strong><p>项目名称、工作文件夹、原始赛题及附件。默认保留磁盘中的代码、图表和论文。</p></div>
    {loading ? <p className="muted" role="status"><LoaderCircle size={15} className="spin" /> 正在核对项目内容…</p> : preview && <>
      <label className="reset-output-option"><input type="checkbox" checked={deleteGenerated} disabled={busy || !preview.generatedFiles.length} onChange={event => setDeleteGenerated(event.target.checked)} /><span>同时删除 NEXIOM 生成的成果文件<small>{preview.generatedFiles.length} 个可清理文件 · {formatBytes(bytes)}</small></span></label>
      <p className="muted">仅清理有创建记录且未被修改的文件；早期版本生成、来源不明或已修改的文件会保留。</p>
      {!!preview.generatedFiles.length && <details className="reset-file-list"><summary>查看成果文件清单</summary><ul>{preview.generatedFiles.map(file => <li key={file.path}><span>{file.path}</span><small>{formatBytes(file.size)}</small></li>)}</ul></details>}
      {preview.warnings.map(warning => <p key={warning} className="muted">{warning}</p>)}
      {deleteGenerated && <label className="reset-name-confirmation">输入项目名称“{project.name}”以确认删除<input value={name} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="off" maxLength={80} /></label>}
    </>}
    {running && <p className="form-error" role="status">项目正在运行，请先停止任务后再重置。</p>}
    {error && <p className="form-error" role="alert">{error} <button className="secondary-button" disabled={busy || loading} onClick={() => setAttempt(value => value + 1)}>重新核对</button></p>}
    <footer><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="danger-button" disabled={busy || loading || running || !preview || (deleteGenerated && name !== project.name)} onClick={() => void reset()}>{busy ? <LoaderCircle size={15} className="spin" /> : <RotateCcw size={15} />}{busy ? "正在重置…" : "重置项目"}</button></footer>
  </div>;
}
