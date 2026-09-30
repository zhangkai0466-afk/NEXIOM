import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Project, Thread } from "../contracts";
import { newWorkflow, workflowStateSchema, reportQuestions, routeLabel, type WorkflowState, type WorkflowAction, type ModelJob } from "../contracts/workflow";
import { atomicJson, checkedFile } from "../filesystem/safe-files";

const file = ".nexiom/workflow.json";
const timestamp = () => new Date().toISOString();
export function readWorkflow(root: string): WorkflowState {
  const target = checkedFile(root, file);
  if (!existsSync(target)) return newWorkflow();
  try { return workflowStateSchema.parse(JSON.parse(readFileSync(target, "utf8"))); }
  catch { throw new Error("项目工作流记录损坏，请从备份恢复 .nexiom/workflow.json。"); }
}
export function workflowArchived(root: string): boolean {
  try { return readWorkflow(root).archived; } catch { return false; }
}
export function saveWorkflow(root: string, state: WorkflowState) {
  state.revision++; atomicJson(root, file, state);
  const final = checkedFile(root, "modeling/final/最终模型.md");
  if ((!state.questions.length || state.questions.some(q => !q.selected)) && existsSync(final)) {
    const contents = readFileSync(final, "utf8");
    if (!contents.startsWith("> 当前版本待重新确认")) writeFileSync(final, `> 当前版本待重新确认：原题、模型或反馈已有变更，以下为历史汇总，不可作为当前最终方案。\n\n${contents}`, "utf8");
  }
}
export function writeWorkflowFile(root: string, relative: string, text: string) {
  const target = checkedFile(root, relative); mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(checkedFile(root, relative), text, "utf8");
}
function latestReading(db: DatabaseSync, projectId: string): string {
  const rows = db.prepare("SELECT messages.text,messages.sequence FROM messages JOIN threads ON threads.id=messages.threadId WHERE threads.projectId=? AND threads.stageId='reading' AND messages.role='assistant'").all(projectId);
  const items = db.prepare("SELECT agent_items.payload,agent_items.sequence FROM agent_items JOIN threads ON threads.id=agent_items.threadId JOIN runs ON runs.id=agent_items.runId WHERE threads.projectId=? AND threads.stageId='reading' AND agent_items.status='completed' AND runs.status='succeeded' AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.threadId=threads.id AND messages.role='user' AND messages.sequence=(SELECT MAX(m.sequence) FROM messages m WHERE m.threadId=threads.id AND m.role='user' AND m.sequence<agent_items.sequence) AND messages.text LIKE '%[NEXIOM赛题研读纠偏]%')").all(projectId).flatMap(row => {
    const item = JSON.parse(String(row.payload)); return item.type === "agent_message" ? [{ text: item.text, sequence: row.sequence }] : [];
  });
  return [...rows, ...items].sort((a, b) => Number(b.sequence) - Number(a.sequence)).map(row => String(row.text)).find(text => /^#\s+赛题研读报告/m.test(text)) ?? "";
}
function resultText(db: DatabaseSync, job: ModelJob) {
  const items = db.prepare("SELECT payload FROM agent_items WHERE runId=? AND status='completed' ORDER BY sequence DESC").all(job.runId);
  for (const record of items) { const item = JSON.parse(String(record.payload)); if (item.type === "agent_message") return String(item.text); }
  const user = db.prepare("SELECT sequence FROM messages WHERE threadId=? AND role='user' ORDER BY sequence DESC LIMIT 1").get(job.threadId);
  return db.prepare("SELECT text FROM messages WHERE threadId=? AND role='assistant' AND kind!='progress' AND sequence>? ORDER BY sequence DESC LIMIT 1").get(job.threadId, Number(user?.sequence ?? -1))?.text as string | undefined;
}
export function solutionDigest(root: string, folder: string): string {
  const hash = createHash("sha256");
  function walk(relative: string) {
    for (const entry of readdirSync(checkedFile(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error("建模成果不能包含符号链接。");
      if (["node_modules", ".git", "__pycache__", "feedback", "response.md"].includes(entry.name) || /^solution\.(docx|pdf|html)$/i.test(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) hash.update(child.slice(folder.length)).update(readFileSync(checkedFile(root, child)));
    }
  }
  walk(folder); return hash.digest("hex");
}
export function syncWorkflow(db: DatabaseSync, project: Project): WorkflowState {
  const state = readWorkflow(project.root);
  let changed = false;
  const report = latestReading(db, project.id);
  const digest = createHash("sha256").update(report).digest("hex");
  if (report && state.readingDigest !== digest) {
    state.readingDigest = digest; changed = true;
    for (const question of state.questions) delete question.selected;
    writeWorkflowFile(project.root, "reading/赛题研读报告.md", report);
  }
  const detected = reportQuestions(report);
  if (report && detected.length) {
    const retired = state.questions.filter(q => !detected.some(entry => entry.name === q.name));
    if (retired.length) { (state.retiredQuestions ??= []).push(...retired); state.questions = state.questions.filter(q => detected.some(entry => entry.name === q.name)); state.dependencies = state.dependencies.filter(d => !retired.some(q => q.id === d.from || q.id === d.to)); changed = true; }
  }
  for (const entry of detected) {
    let question = state.questions.find(q => q.name === entry.name);
    if (!question) {
      const existing = db.prepare("SELECT id FROM questions WHERE projectId=? AND name=?").get(project.id, entry.name);
      const id = existing ? String(existing.id) : randomUUID();
      if (!existing) db.prepare("INSERT INTO questions(id,projectId,name,createdAt) VALUES(?,?,?,?)").run(id, project.id, entry.name, timestamp());
      const retired = state.retiredQuestions?.find(q => q.id === id);
      question = retired ? { ...retired, ...entry, selected: undefined } : { id, ...entry, independent: { jobs: [], feedback: [] }, collaborative: { jobs: [], feedback: [] } };
      state.retiredQuestions = state.retiredQuestions?.filter(q => q.id !== id);
      state.questions.push(question); changed = true;
    } else if (question.source !== entry.source) { question.source = entry.source; delete question.selected; changed = true; }
  }
  for (const question of state.questions) for (const route of ["independent", "collaborative"] as const) {
    for (const job of question[route].jobs.filter(job => job.status === "running")) {
      const run = db.prepare("SELECT status FROM runs WHERE id=?").get(job.runId);
      if (!run || run.status === "running") continue;
      job.status = String(run.status); job.completedAt = timestamp();
      job.result = resultText(db, job) ?? "";
      if (job.result) writeWorkflowFile(project.root, `${job.folder}/response.md`, job.result);
      changed = true;
    }
    for (const job of question[route].jobs.filter(j => j.status === "succeeded")) {
      const output = job.task === "analysis" ? "analysis.md" : job.task === "validation" ? "review.md" : "solution.md";
      const ready = existsSync(checkedFile(project.root, `${job.folder}/${output}`));
      if (job.artifactReady !== ready) { job.artifactReady = ready; changed = true; }
    }
    if (question.selected?.route === route) {
      const job = question[route].jobs.find(j => j.runId === question.selected!.runId);
      if (!job?.artifactReady || solutionDigest(project.root, job.folder) !== question.selected.digest) { delete question.selected; changed = true; }
    }
  }
  if (changed) saveWorkflow(project.root, state);
  return state;
}
function copyMaterialTree(root: string, relative: string, destinationRoot: string, prefix: string, total = { bytes: 0 }) {
  const source = checkedFile(root, relative);
  if (!existsSync(source)) return;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("检验材料不能包含链接。");
    if (["node_modules", ".git", ".nexiom", "feedback", "__pycache__"].includes(entry.name)) continue;
    const child = `${relative}/${entry.name}`;
    const destination = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) copyMaterialTree(root, child, destinationRoot, destination, total);
    else if (entry.isFile() && !["response.md", "review.md"].includes(entry.name)) {
      const bytes = readFileSync(checkedFile(root, child)); total.bytes += bytes.length;
      if (total.bytes > 256 * 1024 * 1024) throw new Error("检验材料超过 256 MB，请精简材料后重试。");
      const target = checkedFile(destinationRoot, destination); mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(checkedFile(root, child), target);
    }
  }
}
export const lastSolution = (question: WorkflowState["questions"][number], route: "independent" | "collaborative") => question[route].jobs.filter(job => ["model", "revision"].includes(job.task) && job.status === "succeeded" && job.artifactReady).at(-1);

export function workflowMutation(db: DatabaseSync, project: Project, action: Exclude<WorkflowAction, { action: "start" }>): WorkflowState {
  const state = syncWorkflow(db, project);
  if (action.action === "sync") return state;
  if (action.action === "check") state.checks[action.key] = action.checked;
  if (action.action === "dependency") {
    if (action.from === action.to || ![action.from, action.to].every(id => state.questions.some(q => q.id === id))) throw new Error("请选择两个不同的本项目问题。");
    const value = { from: action.from, to: action.to, decision: action.decision, evidence: action.evidence, updatedAt: timestamp() };
    state.dependencies = [...state.dependencies.filter(d => d.from !== action.from || d.to !== action.to), value];
    writeWorkflowFile(project.root, "modeling/shared/dependencies.md", state.dependencies.map(d => `- ${state.questions.find(q => q.id === d.from)!.name} → ${state.questions.find(q => q.id === d.to)!.name}：${d.decision}\n  ${d.evidence}`).join("\n"));
  }
  if (action.action === "research") {
    const record = { id: randomUUID(), category: action.category, title: action.title, body: action.body, source: action.source, createdAt: timestamp() };
    state.research.push(record);
    writeWorkflowFile(project.root, `reading/research/${record.id}.md`, `# ${record.title}\n\n分类：${record.category}\n来源：${record.source || "待核实"}\n\n${record.body}`);
  }
  if (action.action === "feedback" || action.action === "confirm") {
    const question = state.questions.find(q => q.id === action.questionId);
    if (!question) throw new Error("问题不属于本项目。");
    const job = lastSolution(question, action.route);
    if (!job) throw new Error("这条路线还没有完成的建模成果。");
    if (action.action === "feedback") {
      const id = randomUUID();
      const relative = `modeling/${question.name}/${action.route}/feedback/${id}.md`;
      writeWorkflowFile(project.root, relative, `# 模型检验反馈\n\n来源路线：${routeLabel(action.route)}\n成果：${job.folder}\n\n${action.text}\n\n修订必须在人机协同下完成，保持另一条路线独立。`);
      question[action.route].feedback.push({ id, text: action.text, createdAt: timestamp(), path: relative });
      delete question.selected;
    } else {
      if (!existsSync(checkedFile(project.root, `${job.folder}/solution.md`))) throw new Error("缺少 solution.md，请先完成并保存建模方案。");
      const digest = solutionDigest(project.root, job.folder);
      const validation = question[action.route].jobs.findLast(j => j.task === "validation" && j.status === "succeeded" && j.artifactReady && j.reviewedDigest === digest);
      if (!validation || question[action.route].jobs.indexOf(validation) < question[action.route].jobs.indexOf(job)) throw new Error("请先检验当前版本，再确认最终模型。");
      if (question[action.route].feedback.some(f => f.createdAt > (job.completedAt ?? ""))) throw new Error("还有尚未处理的检验反馈，请先协同修订并重新检验。");
      question.selected = { route: action.route, runId: job.runId, confirmedAt: timestamp(), digest };
    }
  }
  saveWorkflow(project.root, state);
  writeWorkflowFile(project.root, "modeling/shared/index.md", sharedMemory(project.root, state));
  if (state.questions.length && state.questions.every(q => q.selected)) {
    const contents = state.questions.map(q => {
      const job = q[q.selected!.route].jobs.find(j => j.runId === q.selected!.runId)!;
      return `## ${q.name} · ${routeLabel(q.selected!.route)}\n\n${readFileSync(checkedFile(project.root, `${job.folder}/solution.md`), "utf8")}`;
    }).join("\n\n");
    const final = `# 最终模型\n\n确认时间：${timestamp()}\n后续修改后需要重新检验和确认。\n\n${contents}`;
    writeWorkflowFile(project.root, "modeling/final/最终模型.md", final);
    if (action.action === "confirm") writeWorkflowFile(project.root, `modeling/final/versions/最终模型-r${state.revision}.md`, final);
  }
  return state;
}
export function sharedMemory(root: string, state = readWorkflow(root)) {
  return `# 各问共享进展\n\n${state.questions.map(q => `## ${q.name}\n${["independent", "collaborative"].map(r => {
    const route = r as "independent" | "collaborative";
    const latest = lastSolution(q, route);
    return `${routeLabel(route)}：${latest ? `${latest.folder}/solution.md\n${(latest.result ?? "").slice(0, 2500)}` : "尚未完成"}`;
  }).join("\n")}\n最终选择：${q.selected ? routeLabel(q.selected.route) : "待确认"}`).join("\n\n")}\n\n## 依赖决定\n${JSON.stringify(state.dependencies)}`;
}

export function prepareWorkflowJob(db: DatabaseSync, project: Project, action: Extract<WorkflowAction, { action: "start" }>) {
  const state = syncWorkflow(db, project);
  const question = state.questions.find(q => q.id === action.questionId);
  if (!question) throw new Error("请先完成赛题研读，自动识别问题后再开始建模。");
  if (state.questions.some(q => [...q.independent.jobs, ...q.collaborative.jobs].some(j => j.status === "running"))) throw new Error("本项目已有任务正在运行。");
  const branch = question[action.route];
  const solution = lastSolution(question, action.route);
  if (["validation", "revision"].includes(action.task) && !solution) throw new Error("请先完成这条路线的建模。");
  if (action.task === "model" && ![...question.independent.jobs, ...question.collaborative.jobs].some(j => j.task === "analysis" && j.status === "succeeded" && j.artifactReady)) throw new Error("请先进行初步建模分析并保存 analysis.md。");
  if (action.task === "model" || action.task === "analysis") {
    const ready = db.prepare("SELECT threads.stageId FROM runs JOIN threads ON threads.id=runs.threadId WHERE runs.projectId=? AND runs.status='succeeded' AND threads.stageId IN ('reading','attachments')").all(project.id);
    if (!ready.some(r => r.stageId === "reading")) throw new Error("请先完成赛题研读。");
    const attachments = existsSync(checkedFile(project.root, "inputs")) && readdirSync(checkedFile(project.root, "inputs")).some(n => !/\.pdf$/i.test(n));
    if (attachments && !ready.some(r => r.stageId === "attachments")) throw new Error("请先完成附件分析。");
  }
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const folder = action.task === "validation" ? `validation/${question.name}/${action.route}/${suffix}` : `modeling/${question.name}/${action.route}/${action.task}-${suffix}`;
  const cwd = action.task === "validation" ? checkedFile(project.root, folder) : project.root;
  mkdirSync(checkedFile(project.root, folder), { recursive: true });
  let prompt: string;
  if (action.task === "validation") {
    copyMaterialTree(project.root, "inputs", cwd, "inputs");
    copyMaterialTree(project.root, solution!.folder, cwd, "solution");
    prompt = `独立检验${question.name}的${routeLabel(action.route)}。本轮仅使用当前工作目录的 inputs/ 原题与附件、solution/ 建模方案及代码。不要读取父目录、研读报告、附件分析、项目记忆或模型库。不把作者的结论当证据。逐项检验：模型适配性、逻辑、创新性（标准尚未定义，明确不确定）、数字口径、题意偏离、公式目的与符号、结果质量、跨问衔接、机械套模风险（标准尚未定义）。每条问题写明证据、影响、复现方式、改进意见和严重程度。跨问材料不足标为无法检验。可以运行代码验证，不修改被检验材料。报告保存到 review.md，最后输出完整报告。`;
  } else {
    writeWorkflowFile(project.root, "modeling/shared/index.md", sharedMemory(project.root, state));
    const mode = action.task === "analysis" ? "只做初步分析：完整可读地说明模型构建思路与算法求解思路、候选方案依据和取舍，不执行正式建模。若 plugins/ 有用户提供的模型库可以查阅，不编造已有模型库。"
      : action.task === "revision" ? "以人机协同方式修订已有方案：先读取反馈文件与原方案，回应人的意见，依据讨论改进模型和求解。修订仍归入来源路线的独立目录，不覆盖另一条路线。"
      : action.route === "independent" ? "一口气完成模型建立、代码求解及结果分析，实际运行代码，不执行独立模型检验。" : "与用户共同讨论建模。先回应其想法，给出依据与取舍；有未决定的关键分歧时先讨论，不自动替用户定案。确认的方法可以执行模型构建与代码求解。";
    prompt = `${question.name} · ${action.task === "analysis" ? "初步建模分析" : routeLabel(action.route)}\n${mode}\n\n先读取原题、附件、已完成的研读与附件分析；读取 modeling/shared/index.md 了解其他小问已经做了什么。问题之间是否继承取决于原题证据和用户决定，不能按顺序默认继承。\n\n当前问题的研读内容（待对照原题）：\n${question.source}\n\n${solution ? `已有方案：${solution.folder}/solution.md\n` : ""}反馈文件：${branch.feedback.map(f => f.path).join("、") || "无"}\n\n本轮成果必须放入 ${folder}/。${action.task === "analysis" ? "保存 analysis.md。" : "保存 solution.md，包含模型名称、基本组成、创新点（区分证据与主张）、公式与符号、建模思想、建模过程、求解算法、可运行代码、结果与分析。代码、数据与运行结果一起存放于本目录。缺失数据或运行失败要如实报告，不得假称求解完成。"}\n\n用户想法：\n${action.text || "请按以上任务开始。"}`;
    if (action.task !== "analysis") delete question.selected;
  }
  const thread: Thread = { id: randomUUID(), projectId: project.id, questionId: question.id, title: `${question.name} · ${routeLabel(action.route)} · ${action.task === "analysis" ? "初步分析" : action.task === "validation" ? "模型检验" : action.task === "revision" ? "协同修订" : "建模"}`, stageId: action.task === "validation" ? "validation" : "model", createdAt: timestamp(), unread: false, archivedAt: null };
  return { state, question, branch, folder, cwd, prompt, thread, reviewedDigest: action.task === "validation" ? solutionDigest(project.root, solution!.folder) : undefined };
}
