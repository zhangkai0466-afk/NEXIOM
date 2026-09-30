import { useState, useEffect, memo, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Check,
  ChevronRight,
  Copy,
  FileCode2,
  ListChecks,
  Search,
  Terminal,
} from "lucide-react";
import type { AgentItem } from "../../../packages/contracts";
import logo from "../../../assets/brand/nexiom-desktop-icon-1024.png";
import { AgentTaskStatus } from "./AgentTaskStatus";
import { getAgentItemOutcome, getAgentTaskKind } from "./agent-task-state";
import { readingProseTables } from "./reading-prose-tables";
import { repairCjkStrong } from "./markdown-repair";

const visualOperationNames: Record<string, string> = {
  health_check: "检查绘图环境",
  list_available_templates: "查看绘图模板",
  search_visual_templates: "匹配绘图模板",
  list_available_palettes: "查看配色",
  list_visual_grammar_index: "查看图种索引",
  search_visual_grammar_terms: "检索图种",
  get_visual_reference: "查看参考图",
  render_visual_template: "生成图表",
  render_preview: "生成配色预览",
  analyze_data_file: "分析绘图数据",
  check_code_quality: "检查图表质量",
  render_and_inspect_visual_design: "渲染并检查图表",
  discover_visual_research_project: "读取项目资料",
  run_visual_research_unit: "研究图表方案",
  run_visual_design_meeting: "制定图表方案",
  run_evidence_visual_pipeline: "设计证据图表",
  run_paper_visualization_pipeline: "设计论文图表",
};

export function RichText({
  text,
  openFile,
  reading = false,
}: {
  text: string;
  openFile?: (path: string) => void;
  reading?: boolean;
}) {
  return (
    <div className="markdown">
      <Markdown
        urlTransform={(url) =>
          /^(?:https?:|mailto:)/i.test(url) ||
          !/^[a-z][a-z\d+.-]*:/i.test(url) ||
          /^[a-z]:[\\/]/i.test(url)
            ? url
            : ""
        }
        remarkPlugins={reading ? [remarkGfm, remarkMath, repairCjkStrong, readingProseTables] : [remarkGfm, remarkMath, repairCjkStrong]}
        rehypePlugins={[rehypeKatex]}
        components={{
          table({ children }) {
            return (
              <div className="markdown-table-frame">
                <table>{children}</table>
              </div>
            );
          },
          a({ href, children }) {
            if (href && !/^(https?:|mailto:|#)/i.test(href) && openFile)
              return (
                <button
                  className="file-link"
                  onClick={() => openFile(decodeURIComponent(href))}
                >
                  {children}
                </button>
              );
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          img() {
            return null;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export const AgentOutput = memo(function AgentOutput({
  record,
  openFile,
  showProgress = true,
  activity,
}: {
  record: AgentItem;
  openFile: (path: string) => void;
  showProgress?: boolean;
  activity?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const item = record.item;
  const outcome = getAgentItemOutcome(record);
  const running = outcome === "running";
  const showStatus = showProgress || !running;
  if (item.type === "agent_message")
    return (
      <article
        className={`agent-answer ${running ? "streaming" : ""}`}
        aria-busy={running}
      >
        <div className="agent-signature">
          <img src={logo} alt="" />
          <strong>NEXIOM</strong>
        </div>
        {activity}
        <RichText text={item.text} openFile={openFile} />
        <button
          className="icon-button copy-answer"
          aria-label="复制答复"
          title="复制答复"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(item.text);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </article>
    );
  if (item.type === "reasoning" || item.type === "agent_activity") return null;
  if (item.type === "todo_list")
    return (
      <div className="agent-plan">
        <div>
          <ListChecks size={15} />
          任务计划
          {showStatus && <AgentTaskStatus kind="planning" status={outcome} compact className="nexiom-task-plan-status" />}
        </div>
        {item.items.map((step, index) => (
          <p key={index} className={step.completed ? "done" : ""}>
            {step.completed ? (
              <Check size={14} />
            ) : (
              <span className="step-number">{index + 1}</span>
            )}
            {step.text}
          </p>
        ))}
      </div>
    );
  const failure = outcome === "failed";
  const title =
    item.type === "command_execution"
      ? `运行命令${item.exit_code !== undefined ? ` · 退出码 ${item.exit_code}` : ""}`
      : item.type === "file_change"
        ? `修改 ${item.changes.length} 个文件`
        : item.type === "native_tool_call"
          ? `图表设计 · ${visualOperationNames[item.tool] ?? item.tool}`
        : item.type === "mcp_tool_call"
          ? `${item.server} · ${item.tool}`
          : item.type === "web_search"
            ? item.query
            : item.message;
  const Icon =
    item.type === "file_change"
      ? FileCode2
      : item.type === "web_search"
        ? Search
        : Terminal;
  return (
    <div
      className={`agent-tool ${item.type === "file_change" ? "file-changes" : ""} ${failure ? "failed" : ""}`}
    >
      <button
        className="tool-summary"
        type="button"
        aria-expanded={expanded}
        aria-controls={`tool-${record.id}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <ChevronRight
          className={`disclosure ${expanded ? "open" : ""}`}
          size={13}
        />
        <Icon size={15} />
        <span>{title}</span>
        {showStatus && <AgentTaskStatus kind={getAgentTaskKind(item)} status={outcome} compact />}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={`tool-${record.id}`}
            className="agent-tool-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {item.type === "command_execution" && (
              <>
                <pre>{item.command}</pre>
                <pre>{item.aggregated_output || "暂无输出"}</pre>
                <div className="tool-meta">
                  {item.exit_code !== undefined
                    ? `退出码 ${item.exit_code}`
                    : outcome === "interrupted"
                      ? "已中断，未确认退出码"
                      : outcome === "cancelled"
                        ? "已停止，未确认退出码"
                        : outcome === "failed"
                          ? "失败，未返回退出码"
                          : running ? "运行中" : "完成"}
                </div>
              </>
            )}
            {item.type === "file_change" &&
              item.changes.map((change) => (
                <button
                  key={change.path}
                  className="changed-file"
                  disabled={change.kind === "delete"}
                  onClick={() => openFile(change.path)}
                >
                  <FileCode2 size={14} />
                  <span>{change.path}</span>
                  <em>
                    {change.kind === "add"
                      ? "新增"
                      : change.kind === "delete"
                        ? "删除"
                        : "修改"}
                  </em>
                </button>
              ))}
            {item.type === "mcp_tool_call" && (
              <pre>
                {JSON.stringify(
                  item.result ?? item.error ?? item.arguments,
                  null,
                  2,
                )}
              </pre>
            )}
            {item.type === "native_tool_call" && (
              <pre>{JSON.stringify(item.result ?? item.error ?? item.arguments, null, 2)}</pre>
            )}
            {item.type === "error" && <p>{item.message}</p>}
            {item.type === "web_search" && <p>{item.query}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
