import { useState, useEffect, memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Check,
  ChevronRight,
  CircleCheck,
  Copy,
  FileCode2,
  ListChecks,
  LoaderCircle,
  Search,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import type { AgentItem } from "../../../packages/contracts";
import logo from "../../../assets/brand/nexiom-desktop-icon-1024.png";

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
}: {
  text: string;
  openFile?: (path: string) => void;
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
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
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
}: {
  record: AgentItem;
  openFile: (path: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const item = record.item;
  if (item.type === "agent_message")
    return (
      <article
        className={`agent-answer ${record.status === "running" ? "streaming" : ""}`}
        aria-busy={record.status === "running"}
      >
        <div className="agent-signature">
          <img src={logo} alt="" />
          <strong>NEXIOM</strong>
        </div>
        <RichText text={item.text} openFile={openFile} />
        {record.status === "running" && (
          <span className="stream-cursor" aria-hidden="true" />
        )}
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
  if (item.type === "reasoning") return null;
  if (item.type === "todo_list")
    return (
      <div className="agent-plan">
        <div>
          <ListChecks size={15} />
          任务计划
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
  const failure =
    ("status" in item && item.status === "failed") ||
    record.status === "interrupted" ||
    item.type === "error";
  const running = record.status === "running";
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
        {running ? (
          <LoaderCircle size={14} className="spin" />
        ) : failure ? (
          <TriangleAlert size={14} />
        ) : (
          <CircleCheck size={14} />
        )}
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
                    : record.status === "interrupted"
                      ? "已中断，未确认退出码"
                      : "运行中"}
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
