import { useEffect, useState } from "react";
import { Check, FileText, LoaderCircle, RefreshCw, Save } from "lucide-react";
import type { ProjectMemory, ThreadContext } from "../../../packages/contracts";
import { request } from "./bridge";

const tokens = (value: number | null | undefined) =>
  value == null ? "尚无数据" : value.toLocaleString("zh-CN");
export function ContextDetails({ context }: { context?: ThreadContext }) {
  const percent =
    context?.modelContextWindow && context.lastInputTokens != null
      ? Math.min(
          100,
          (context.lastInputTokens / context.modelContextWindow) * 100,
        )
      : null;
  return (
    <div className="context-details">
      <div className="section-heading">
        <h3>会话上下文</h3>
        <span>NEXIOM</span>
      </div>
      <div className="context-meter">
        <span style={{ width: `${percent ?? 0}%` }} />
      </div>
      <dl>
        <dt>上次输入</dt>
        <dd>{tokens(context?.lastInputTokens)} tokens</dd>
        <dt>上下文窗口</dt>
        <dd>
          {tokens(context?.modelContextWindow)}
          {context?.modelContextWindow ? " tokens" : ""}
        </dd>
        <dt>上次输出</dt>
        <dd>{tokens(context?.lastOutputTokens)} tokens</dd>
        <dt>缓存输入</dt>
        <dd>{tokens(context?.cachedInputTokens)} tokens</dd>
        <dt>压缩次数</dt>
        <dd>{context?.compactions ?? 0}</dd>
        <dt>会话恢复</dt>
        <dd>{context?.engineThreadId ? "可继续当前对话" : "等待首次运行"}</dd>
      </dl>
    </div>
  );
}
export function ProjectMemoryEditor({
  projectId,
  running,
  onDirtyChange,
}: {
  projectId: string;
  running: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    onDirtyChange?.(!!memory && text !== memory.text);
  }, [memory, text, onDirtyChange]);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await request({ type: "memory.read", projectId });
      if (result.memory) {
        setMemory(result.memory);
        setText(result.memory.text);
        setSaved(false);
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [projectId]);
  async function save() {
    if (!memory) return;
    setBusy(true);
    setError("");
    try {
      const result = await request({
        type: "memory.write",
        projectId,
        text,
        expectedRevision: memory.revision,
      });
      if (result.memory) setMemory(result.memory);
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="memory-editor">
      <div className="memory-path">
        <FileText size={15} />
        <span>.nexiom/MEMORY.md</span>
        <button
          className="icon-button"
          aria-label="重新读取记忆"
          title="重新读取记忆"
          onClick={() => void load()}
          disabled={busy || text !== memory?.text}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <textarea
        aria-label="项目记忆"
        spellCheck={false}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setSaved(false);
        }}
        disabled={!memory || busy}
        placeholder={
          "# 项目约定\n\n## 研究目标\n\n## 已确认的假设\n\n## 数据与实验约定"
        }
        maxLength={20000}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <span className="muted">
          {saved
            ? "已保存，下次任务生效"
            : running
              ? "任务正在运行"
              : "项目共享记忆"}
        </span>
        <button
          className="primary-button"
          onClick={() => void save()}
          disabled={!memory || busy || running || text === memory.text}
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : saved ? (
            <Check size={15} />
          ) : (
            <Save size={15} />
          )}
          保存记忆
        </button>
      </footer>
    </div>
  );
}
