import type { AgentItem } from "../../../packages/contracts";
import type { ThreadItem } from "../../../packages/runtime";
import { parseReadingProgress } from "../../../packages/contracts/reading-workflow";

export const AGENT_TASK_STATES = {
  thinking: { label: "思考中", color: "#ffa000" },
  reading: { label: "阅读中", color: "#20ad65" },
  analyzing: { label: "分析中", color: "#ff6055" },
  searching: { label: "检索中", color: "#4b8dff" },
  planning: { label: "规划中", color: "#a273ff" },
  executing: { label: "执行中", color: "#ff7c35" },
  writing: { label: "编写中", color: "#12b8c9" },
} as const;

export type AgentTaskKind = keyof typeof AGENT_TASK_STATES;
export type AgentTaskOutcome = "running" | "completed" | "failed" | "cancelled" | "interrupted";

// Match the native registry by tool name; arguments and generated content are not activity signals.
const visualTaskKinds: Record<string, AgentTaskKind> = {
  ensure_visual_libraries: "executing",
  list_visual_assets: "reading",
  get_visual_asset: "reading",
  create_visual_asset: "writing",
  run_visual_stage_unit: "analyzing",
  visual_stage_report: "analyzing",
  get_visual_research_cards: "reading",
  discover_visual_research_project: "reading",
  search_visual_research_sources: "searching",
  read_visual_research_source: "reading",
  run_visual_research_unit: "analyzing",
  execute_visual_research_tasks: "executing",
  prepare_researched_visual_inventory: "planning",
  visual_research_progress: "reading",
  build_evidence_visual_inventory: "planning",
  run_evidence_visual_pipeline: "executing",
  health_check: "analyzing",
  create_visual_design_run: "executing",
  preflight_visual_design_inputs: "analyzing",
  analyze_data_file: "analyzing",
  build_visual_design_packet: "planning",
  run_visual_design_meeting: "planning",
  build_paper_visual_inventory: "planning",
  run_paper_visualization_pipeline: "executing",
  execute_saved_paper_visual_plan: "executing",
  render_and_inspect_visual_design: "analyzing",
  check_request_fulfillment: "analyzing",
  validate_visual_design_output: "analyzing",
  detect_missing_figures: "analyzing",
  generate_principle_figure_prompt: "writing",
  check_code_quality: "analyzing",
  list_available_templates: "reading",
  list_visual_grammar_index: "reading",
  search_visual_grammar_terms: "searching",
  search_visual_templates: "searching",
  list_available_palettes: "reading",
  render_preview: "executing",
  update_visual_request_fields: "writing",
  get_visual_reference: "reading",
  render_visual_template: "executing",
};

function toolTaskKind(tool: string): AgentTaskKind {
  const name = tool.split(/__|\./).at(-1)!
    .replace(/([a-z\d])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
  if (Object.hasOwn(visualTaskKinds, name)) return visualTaskKinds[name];
  if (/^(?:search|find|query|lookup|browse)(?:_|$)/.test(name)) return "searching";
  if (/^(?:read|get|list|fetch|open|view|extract)(?:_|$)/.test(name)) return "reading";
  if (/^(?:analyze|analyse|inspect|check|validate|verify|compare|evaluate|audit)(?:_|$)/.test(name)) return "analyzing";
  if (/^(?:plan|update_plan|create_plan|set_plan|todo)(?:_|$)/.test(name)) return "planning";
  if (/^(?:write|edit|patch|apply_patch|create|save|update|generate)(?:_|$)/.test(name)) return "writing";
  return "executing";
}

type CommandToken = { text: string; operator: boolean };

// A small lexical pass keeps words inside quoted arguments out of command classification.
function commandTokens(command: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let text = "";
  let quote = "";
  const flush = () => { if (text) tokens.push({ text, operator: false }); text = ""; };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = "";
      else text += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/[;|&<>\r\n]/.test(char)) {
      flush();
      tokens.push({ text: char, operator: true });
    } else if (/\s/.test(char)) flush();
    else text += char;
  }
  // Malformed shell syntax is deliberately left as execution.
  if (quote) return [];
  flush();
  return tokens;
}

function commandTaskKind(command: string, depth = 0): AgentTaskKind {
  if (depth > 2 || /[`]/.test(command)) return "executing";
  const tokens = commandTokens(command);
  if (tokens[0]?.text === "&") tokens.shift(); // PowerShell's explicit executable invocation.
  if (!tokens.length || tokens.some(token => token.operator)) return "executing";
  const executable = tokens[0].text.split(/[\\/]/).at(-1)!.replace(/\.exe$/i, "").toLowerCase();
  if (/^(?:powershell|pwsh|bash|sh|zsh|cmd)$/.test(executable)) {
    const marker = tokens.findIndex((token, index) => index > 0 && /^(?:-command|-c|-lc|-ic|\/c)$/i.test(token.text));
    if (marker < 0) return "executing";
    return commandTaskKind(tokens.slice(marker + 1).map(token => token.text).join(" "), depth + 1);
  }
  if (/^(?:cat|head|tail|less|more|type|get-content|gc|pdftotext|pdfinfo)$/.test(executable)) return "reading";
  if (/^(?:rg|grep|egrep|fgrep|findstr|select-string|search)$/.test(executable)) return "searching";
  return "executing";
}

export function getAgentTaskKind(item?: ThreadItem, fallback: AgentTaskKind = "thinking"): AgentTaskKind {
  if (item?.type === "native_tool_call" && item.namespace === "nexiom_reading" && item.tool === "set_reading_stage") {
    return parseReadingProgress(item.arguments)?.phase ?? fallback;
  }
  switch (item?.type) {
    case "agent_activity": return item.phase;
    case "reasoning": return "thinking";
    case "agent_message":
    case "file_change": return "writing";
    case "todo_list": return "planning";
    case "web_search": return "searching";
    case "command_execution": return commandTaskKind(item.command);
    case "mcp_tool_call":
    case "native_tool_call": return toolTaskKind(item.tool);
    default: return fallback;
  }
}

function resultFailed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return result.isError === true || result.success === false || result.ok === false;
}

export function getAgentItemOutcome(record: AgentItem): AgentTaskOutcome {
  const item = record.item;
  const outer = record.status.toLowerCase();
  const inner = "status" in item ? String(item.status).toLowerCase() : "";
  const states = [outer, inner];
  if (states.some(status => status === "cancelled" || status === "canceled")) return "cancelled";
  if (states.some(status => status === "interrupted" || status === "aborted")) return "interrupted";
  if (states.some(status => ["failed", "error", "declined", "denied", "timed_out"].includes(status)) ||
      item.type === "error" ||
      (item.type === "command_execution" && item.exit_code !== undefined && item.exit_code !== 0) ||
      ("error" in item && Boolean(item.error)) ||
      ("result" in item && resultFailed(item.result)) ||
      (item.type === "mcp_tool_call" && resultFailed(item.result?.structured_content))) return "failed";
  if (states.some(status => status === "running" || status === "in_progress")) return "running";
  // Unknown inner statuses are not proof of success, even after an outer completion event.
  if (inner && inner !== "completed") return "running";
  if (outer === "completed" && item.type === "todo_list" && item.items.some(step => !step.completed)) return "interrupted";
  if (outer === "completed") return "completed";
  return "running";
}

function isThinkingItem(item: ThreadItem) {
  return item.type === "reasoning" || (item.type === "agent_activity" && item.phase === "thinking");
}

// Keep the answer hidden until the thought that started before it has finished.
export function outputBlockedByThinking(items: AgentItem[], message: AgentItem) {
  if (message.item.type !== "agent_message" || getAgentItemOutcome(message) !== "running") return false;
  return items.some(record =>
    record.runId === message.runId &&
    record.sequence < message.sequence &&
    isThinkingItem(record.item) &&
    getAgentItemOutcome(record) === "running");
}

export function getCurrentAgentTaskKind(
  items: AgentItem[], runId: string, fallback: AgentTaskKind = "thinking",
): AgentTaskKind {
  const progress = items.filter(record => record.runId === runId && record.item.type === "native_tool_call" &&
    record.item.namespace === "nexiom_reading" && record.item.tool === "set_reading_stage" && getAgentItemOutcome(record) === "completed")
    .sort((a, b) => b.sequence - a.sequence)[0];
  if (progress?.item.type === "native_tool_call") {
    const stage = parseReadingProgress(progress.item.arguments);
    if (stage?.status === "running") return stage.phase;
  }
  // Plans stay "running" for the entire turn. Once execution has moved on,
  // an old plan is not evidence that the agent has started planning again.
  const visible = items.filter(record => !outputBlockedByThinking(items, record));
  const latestNonPlanSequence = visible.reduce((sequence, record) =>
    record.runId === runId && record.item.type !== "todo_list" ? Math.max(sequence, record.sequence) : sequence, -Infinity);
  let latest: AgentItem | undefined;
  for (const record of visible) {
    if (record.runId !== runId || record.status !== "running" || getAgentItemOutcome(record) !== "running") continue;
    if (record.item.type === "todo_list" && record.sequence < latestNonPlanSequence) continue;
    if (!latest || record.sequence > latest.sequence) latest = record;
  }
  return latest ? getAgentTaskKind(latest.item, fallback) : fallback;
}
