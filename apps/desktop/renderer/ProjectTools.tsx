import { useEffect, useState } from "react";
import { request } from "./bridge";
import type { CoreResponse, Project, Command } from "../../../packages/contracts";

export function ProjectTools({ project, kind }: { project: Project; kind: "terminal" | "plugins" | "git" }) {
  const [data, setData] = useState<CoreResponse>({});
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function execute(command: Command) {
    setBusy(true); setError("");
    try { const result = await request(command); setData(current => ({ ...current, ...result })); return result; }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { void execute({ type: kind === "terminal" ? "terminal.open" : kind === "plugins" ? "plugins.list" : "git.inspect", projectId: project.id }); }, [kind, project.id]);
  const terminalId = data.terminal?.id;
  useEffect(() => {
    if (!terminalId || data.terminal?.exited) return;
    let active = true;
    const poll = setInterval(() => { void request({ type: "terminal.read", projectId: project.id, id: terminalId }).then(result => { if (active) setData(result); }).catch(e => { if (active) setError(e.message); }); }, 700);
    return () => { active = false; clearInterval(poll); };
  }, [terminalId, data.terminal?.exited, project.id]);
  return <div className="project-tools"><p>{project.name}</p>{error && <p className="form-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {kind === "terminal" && <><p>终端与 Agent 共用项目文件。这里的命令不会自动发给 Agent；运行结果可复制到讨论中。</p><pre className="project-terminal" aria-label="终端输出">{data.terminal?.output}</pre><form onSubmit={async e => { e.preventDefault(); if (!terminalId || !draft.trim()) return; const result = await execute({ type: "terminal.write", projectId: project.id, id: terminalId, text: draft }); if (result) setDraft(""); }}><label>命令<input autoFocus aria-label="终端命令" value={draft} onChange={e => setDraft(e.target.value)} disabled={data.terminal?.exited} /></label><div className="workflow-actions"><button className="primary-button" disabled={busy || !terminalId || data.terminal?.exited}>运行</button><button type="button" className="secondary-button" onClick={() => terminalId && void execute({ type: "terminal.close", projectId: project.id, id: terminalId })}>结束终端</button>{data.terminal?.exited && <button type="button" className="secondary-button" onClick={() => void execute({ type: "terminal.open", projectId: project.id })}>重新打开</button>}</div></form></>}
    {kind === "plugins" && <><p>导入 NEXIOM 项目插件 JSON，可提供领域指引和模型库资料。启用后用于后续 Agent 任务，独立检验不载入这些资料。</p><label className="secondary-button">导入插件<input type="file" accept=".json,application/json" hidden onChange={async e => { const file = e.target.files?.[0]; e.target.value = ""; if (!file) return; if (file.size > 2000000) { setError("插件文件不能超过 2 MB。"); return; } await execute({ type: "plugins.install", projectId: project.id, manifest: await file.text() }); }} /></label>{data.plugins?.map(p => <article className="plugin-entry" key={p.id}><label className="workflow-check"><input type="checkbox" checked={p.enabled} disabled={busy} onChange={e => void execute({ type: "plugins.toggle", projectId: project.id, id: p.id, enabled: e.target.checked })} /><strong>{p.name}</strong></label><p>{p.description}</p><details><summary>查看插件内容 · {p.documents.length} 份资料</summary><pre>{p.instructions}</pre>{p.documents.map((d, i) => <div key={i}><h4>{d.name}</h4><pre>{d.content}</pre></div>)}</details></article>)}<details><summary>插件格式</summary><pre>{JSON.stringify({ id: "my-model-library", name: "我的基础模型库", description: "团队积累的模型与使用条件", instructions: "先检查适用条件，不机械套用模型。", documents: [{ name: "模型说明", content: "在这里填写模型、假设、适用范围及参考依据。" }] }, null, 2)}</pre></details></>}
    {kind === "git" && <><p>Git 保存文件修改历史；工作树用不同文件夹和分支尝试建模路线，共享同一个仓库。创建工作树不复制尚未提交的修改。</p><h3>当前修改</h3><pre>{data.git?.status}</pre><h3>最近提交</h3><pre>{data.git?.log || "暂无提交"}</pre><h3>工作树</h3><pre>{data.git?.worktrees || "暂无工作树"}</pre><form onSubmit={async e => { e.preventDefault(); const result = await execute({ type: "git.worktree", projectId: project.id, name: draft }); if (result?.savedPath) { setNotice(`已创建工作树：${result.savedPath}。可通过“添加项目”打开。`); setDraft(""); await execute({ type: "git.inspect", projectId: project.id }); } }}><label>新工作树名称<input value={draft} onChange={e => setDraft(e.target.value)} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}" placeholder="model-alternative" /></label><button className="primary-button" disabled={busy || !data.git?.available || !draft}>创建工作树</button></form></>}
  </div>;
}
