import { useState } from "react";
import type { WorkflowState, WorkflowAction } from "../../../packages/contracts/workflow";
import { RichText } from "./AgentOutput";
import "./workflow.css";

export function ReadingSectionBody({ kind, body, state, onChange }: { kind: string; body: string; state?: WorkflowState; onChange: (action: WorkflowAction) => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [showChecked, setShowChecked] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [decision, setDecision] = useState<"pending" | "inherit" | "modify" | "none">("pending");
  const [evidence, setEvidence] = useState("");
  const [saving, setSaving] = useState(false);
  const labels = { pending: "待核实", inherit: "继承", modify: "调整后继承", none: "不继承" };
  if (kind === "pending") {
    const entries = body.split(/\n(?=###\s|[-*]\s+(?:\[[ xX]\]\s*)?|\d+[.、]\s)/).map(s => s.trim()).filter(Boolean);
    const visible = entries.filter(text => showChecked || !state?.checks[`reading:${text.slice(0, 1900)}`]);
    return <><p>勾选并确认后，已核对事项会从待核对清单移出。</p><label className="workflow-check"><input type="checkbox" checked={showChecked} onChange={e => setShowChecked(e.target.checked)} />显示已核对</label><table className="reading-checklist"><thead><tr><th>状态</th><th>核对事项与依据</th></tr></thead><tbody>{visible.map(text => { const key = `reading:${text.slice(0, 1900)}`; return <tr key={key}><td><input aria-label={`核对 ${text.slice(0, 50)}`} type="checkbox" checked={selected.includes(key) || !!state?.checks[key]} onChange={e => { if (state?.checks[key]) void onChange({ action: "check", key, checked: false }).catch(() => { /* parent displays the save error */ }); else setSelected(current => e.target.checked ? [...current, key] : current.filter(k => k !== key)); }} /></td><td><RichText text={text.replace(/^[-*]\s+\[[ xX]\]\s*/, "")} /></td></tr>; })}</tbody></table>{!visible.length && <p>当前没有待核对事项。</p>}<button className="primary-button" disabled={saving || !selected.length} onClick={async () => { setSaving(true); try { for (const key of selected) await onChange({ action: "check", key, checked: true }); setSelected([]); } catch { /* preserve unsaved selections; parent displays the error */ } finally { setSaving(false); } }}>确认已核对（{selected.length}）</button></>;
  }
  if (kind === "source") {
    const blocks = body.split(/\n\s*\n(?=>)/).filter(Boolean);
    return <div>{blocks.map((block, index) => { const quote = block.match(/^((?:>[^\n]*(?:\n|$))+)([\s\S]*)/); return quote ? <div className="reading-annotation" key={index}><blockquote><RichText text={quote[1].replace(/^>\s?/gm, "")} /></blockquote><aside><RichText text={quote[2]} /></aside></div> : <RichText key={index} text={block} reading />; })}</div>;
  }
  if (kind === "trap") return <div>{body.split(/\n(?=###\s)/).filter(Boolean).map((block, index) => <article key={index} className="reading-risk" data-level={block.match(/严重|中等|轻度/)?.[0] ?? "待判断"}><RichText text={block} reading /></article>)}</div>;
  if (kind === "dependency") return <><div className="dependency-graph" aria-label="问题依赖关系图">{state?.questions.map(q => <article key={q.id}><strong>{q.name}</strong>{state.dependencies.filter(d => d.to === q.id).map(d => <p key={d.from}>{state.questions.find(x => x.id === d.from)?.name} → {labels[d.decision]}<br /><small>{d.evidence}</small></p>)}{!state.dependencies.some(d => d.to === q.id) && <small>继承关系尚待讨论</small>}</article>)}</div><RichText text={body} reading /><form className="workflow-discussion" onSubmit={async e => { e.preventDefault(); setSaving(true); try { await onChange({ action: "dependency", from, to, decision, evidence }); setEvidence(""); } catch { /* preserve the draft; parent displays the error */ } finally { setSaving(false); } }}><h3>共同确认问题之间的衔接</h3><div className="workflow-actions"><select aria-label="来源问题" value={from} onChange={e => setFrom(e.target.value)}><option value="">来源问题</option>{state?.questions.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select><span>→</span><select aria-label="目标问题" value={to} onChange={e => setTo(e.target.value)}><option value="">目标问题</option>{state?.questions.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select><select aria-label="继承决定" value={decision} onChange={e => setDecision(e.target.value as typeof decision)}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div><textarea aria-label="继承依据" value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="记录原题依据、传递的数据/模型/口径，以及当前结果带来的新判断…" maxLength={4000} /><button className="primary-button" disabled={saving || !from || !to || from === to || !evidence.trim()}>保存当前决定</button></form></>;
  if (kind === "research") return <><RichText text={body} reading />{["术语口径", "题目背景", "方法与概念", "背景插图"].map(category => { const entries = state?.research.filter(item => item.category === category) ?? []; return !!entries.length && <section key={category}><h2>{category}</h2>{entries.map(item => <article key={item.id}><h3>{item.title}</h3><p className="workflow-path">来源板块：{item.source || "未标注"} · {new Date(item.createdAt).toLocaleString()}</p><RichText text={item.body} /></article>)}</section>; })}</>;
  return <RichText text={body || "本板块暂无内容。"} reading />;
}
