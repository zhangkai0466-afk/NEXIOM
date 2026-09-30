import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import service from "../.build/service.cjs";
import JSZip from "jszip";

const report = `# 赛题研读报告
## 赛题概览
这是集成测试题。
## 问题一
### 问题重述
建立线性关系并求解。
## 问题2
预测新的观测值。正文提到问题3不应创建新问题。
## 待人工核对
- [ ] 确认单位
## 文献调研
未联网，来源待核实。
## 交付清单
两问结果。`;

async function setup(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "nexiom-guide-"));
  const calls = [];
  const runner = {
    async probe(p) { return { connected: true, available: true, authenticated: true, label: "Fixture", version: "fixture", hasApiKey: false, activeProviderId: p.id, activeProviderName: p.name, activeModel: p.model, activeModelProvider: "nexiom" }; },
    async listModels() { return ["fixture"]; },
    async *run(input) {
      calls.push(input); await delay(25);
      yield { type: "thread.started", thread_id: randomUUID() };
      let text = "本轮只进行了讨论，尚未生成方案。";
      if (input.stageId === "reading") text = report;
      else if (input.stageId === "validation") { text = "# 检验报告\n## 严重\n本测试发现一个需要修订的问题。"; await writeFile(path.join(input.cwd, "review.md"), text); }
      else {
        const folder = input.prompt.match(/本轮成果必须放入 (.+?)\//s)?.[1];
        const match = input.prompt.match(/本轮成果必须放入 ([^\n]+)\/。/);
        if (match) {
          const destination = path.join(input.cwd, match[1]); await mkdir(destination, { recursive: true });
          const analysis = input.prompt.includes("只做初步分析");
          text = analysis ? "# 初步思路\n核实线性关系及其假设。" : "# 建模方案\n## 模型名称\n线性模型\n**拟合结果**为2。\n\n公式 $y=2x$。\n\n| 指标 | 结果 |\n| --- | --- |\n| 斜率 | 2 |";
          await writeFile(path.join(destination, analysis ? "analysis.md" : "solution.md"), text);
          if (!analysis) await writeFile(path.join(destination, "solve.py"), "print(2)\n");
        }
      }
      yield { type: "item.completed", item: { id: "answer", type: "agent_message", text } };
      yield { type: "turn.completed", usage: null };
    },
  };
  const core = new service.CoreService(dir, () => {}, { runner });
  t.after(async () => { await core.close(); await rm(dir, { recursive: true, force: true }); });
  await core.request({ type: "provider.upsert", provider: { id: "nexiom-default", name: "Fixture", kind: "responses", endpoint: "http://127.0.0.1:1/v1", model: "fixture", auth: "none" } });
  await core.request({ type: "runtime.check" });
  const { project } = await core.request({ type: "project.create", name: "指南集成测试" });
  const { thread } = await core.request({ type: "thread.ensure", projectId: project.id, stageId: "reading" });
  await writeFile(path.join(project.root, "inputs", "原题.pdf"), "%PDF-fixture");
  const { runId } = await core.request({ type: "agent.submit", threadId: thread.id, text: "[NEXIOM赛题研读任务]", clientRequestId: randomUUID() });
  const settle = async id => { for (let i = 0; i < 200; i++) { const run = core.snapshot().snapshot.runs.find(r => r.id === id); if (run?.status !== "running") { assert.equal(run.status, "succeeded"); return; } await delay(10); } throw new Error("fixture timed out"); };
  await settle(runId);
  const read = async () => (await core.request({ type: "workflow.read", projectId: project.id })).workflow;
  const update = change => core.request({ type: "workflow.update", projectId: project.id, change });
  return { core, dir, project, calls, settle, read, update };
}

test("guide workflow persists questions, separates review inputs, revisions, feedback and current-version confirmation", async t => {
  const { core, project, calls, settle, read, update } = await setup(t);
  let state = await read();
  assert.deepEqual(state.questions.map(q => q.name), ["问题1", "问题2"]);
  const first = state.questions[0]; const second = state.questions[1];
  const start = async (task, route = "independent", questionId = first.id) => { const result = await update({ action: "start", task, route, questionId }); await settle(result.runId); return read(); };
  await assert.rejects(update({ action: "start", questionId: first.id, route: "independent", task: "model" }), /初步/);
  await update({ action: "dependency", from: first.id, to: second.id, decision: "pending", evidence: "需要根据预测结果讨论是否继承" });
  await assert.rejects(update({ action: "dependency", from: first.id, to: first.id, decision: "inherit", evidence: "非法自环" }));
  await update({ action: "check", key: "reading:确认单位", checked: true });
  await update({ action: "research", category: "术语口径", title: "测试定义", body: "尚未取得原文，不作已核实结论", source: "问题1" });
  assert.equal((await read()).research.length, 1);
  await start("analysis"); state = await start("model");
  let solution = state.questions[0].independent.jobs.at(-1);
  assert.equal(solution.artifactReady, true);
  const originalPath = path.join(project.root, solution.folder, "solution.md");
  await assert.rejects(update({ action: "confirm", questionId: first.id, route: "independent" }), /检验/);
  state = await start("validation");
  const reviewInput = calls.at(-1);
  assert.notEqual(reviewInput.cwd, project.root);
  assert.equal(reviewInput.projectMemory, "");
  assert.equal(reviewInput.threadId, undefined);
  assert.ok((await readdir(reviewInput.cwd)).includes("inputs"));
  assert.ok(!(await readdir(reviewInput.cwd)).includes("reading"));
  assert.equal(await readFile(path.join(reviewInput.cwd, "solution/solve.py"), "utf8"), "print(2)\n");
  await update({ action: "confirm", questionId: first.id, route: "independent" });
  assert.ok((await read()).questions[0].selected);
  await writeFile(originalPath, "# 外部修改\n模型已经改变。");
  assert.equal((await read()).questions[0].selected, undefined);
  await assert.rejects(update({ action: "confirm", questionId: first.id, route: "independent" }), /检验/);
  await update({ action: "feedback", questionId: first.id, route: "independent", text: "重新验证假设并补充结果。" });
  const feedback = (await read()).questions[0].independent.feedback[0];
  assert.match(await readFile(path.join(project.root, feedback.path), "utf8"), /重新验证/);
  state = await start("revision");
  assert.match(calls.at(-1).prompt, /以人机协同方式修订/);
  assert.equal(state.questions[0].collaborative.jobs.length, 0);
  const revised = state.questions[0].independent.jobs.at(-1);
  assert.notEqual(revised.folder, solution.folder);
  await start("validation"); await update({ action: "confirm", questionId: first.id, route: "independent" });
  await start("analysis", "collaborative", second.id); await start("model", "collaborative", second.id);
  assert.match(await readFile(path.join(project.root, "modeling/shared/index.md"), "utf8"), /问题1/);
  await start("validation", "collaborative", second.id); await update({ action: "confirm", questionId: second.id, route: "collaborative" });
  assert.match(await readFile(path.join(project.root, "modeling/final/最终模型.md"), "utf8"), /问题1[\s\S]*问题2/);
  const exported = await core.request({ type: "workflow.export", projectId: project.id, path: `${revised.folder}/solution.md` });
  assert.equal((await readFile(path.join(project.root, exported.exported.docx))).subarray(0, 2).toString(), "PK");
  const html = await readFile(path.join(project.root, exported.exported.html), "utf8");
  assert.match(html, /<strong>拟合结果<\/strong>/); assert.match(html, /katex/); assert.match(html, /<table>/);
  const word = await JSZip.loadAsync(await readFile(path.join(project.root, exported.exported.docx)));
  assert.match(await word.file("word/document.xml").async("string"), /<m:oMath>/);
  await assert.rejects(core.request({ type: "workflow.export", projectId: project.id, path: "../../secret.md" }));
  await assert.rejects(core.request({ type: "thread.delete", threadId: revised.threadId }), /关联建模成果/);
  const versions = await readdir(path.join(project.root, "modeling/final/versions"));
  assert.equal(versions.length, 1);
  await writeFile(path.join(project.root, revised.folder, "solve.py"), "print(3)\n");
  await assert.rejects(core.request({ type: "workflow.export", projectId: project.id, path: "modeling/final/最终模型.md" }), /重新检验/);
  assert.match(await readFile(path.join(project.root, "modeling/final/最终模型.md"), "utf8"), /^> 当前版本待重新确认/);
  await core.request({ type: "project.archive", projectId: project.id, archived: true });
  assert.equal(core.snapshot().snapshot.projects[0].archived, true);
  await core.request({ type: "project.archive", projectId: project.id, archived: false });
  assert.equal(core.snapshot().snapshot.projects[0].archived, undefined);
  const preview = await core.request({ type: "project.reset.preview", projectId: project.id });
  await update({ action: "check", key: "another", checked: true });
  await assert.rejects(core.request({ type: "project.reset", projectId: project.id, revision: preview.resetPreview.revision }), /已变化/);
  const updated = await core.request({ type: "project.reset.preview", projectId: project.id });
  await core.request({ type: "project.reset", projectId: project.id, revision: updated.resetPreview.revision });
  assert.equal((await read()).questions.length, 0);
  await writeFile(path.join(project.root, ".nexiom/workflow.json"), '{"version":1,"questions":[{}]}');
  assert.doesNotThrow(() => core.snapshot());
  await assert.rejects(read(), /记录损坏/);
});

test("PDF saves update the current document; terminal sessions are project scoped; plugins reach modeling but not validation", async t => {
  const { core, project, read, update, settle, calls } = await setup(t);
  const saved = await core.request({ type: "pdf.save", projectId: project.id, path: "inputs/原题.pdf", base64: Buffer.from("%PDF-1.7\nannotations").toString("base64") });
  assert.equal(saved.savedPath, "inputs/原题.pdf");
  assert.equal(await readFile(path.join(project.root, "inputs/原题.pdf"), "utf8"), "%PDF-1.7\nannotations");
  await assert.rejects(core.request({ type: "pdf.save", projectId: project.id, path: "inputs/原题.pdf", base64: Buffer.from("not pdf").toString("base64") }));
  const plugins = await core.request({ type: "plugins.install", projectId: project.id, manifest: JSON.stringify({ id: "model-notes", name: "基础模型库", description: "fixture", instructions: "PLUGIN_FIXTURE", documents: [] }) });
  assert.equal(plugins.plugins.length, 1);
  const questionId = (await read()).questions[0].id;
  const run = await update({ action: "start", task: "analysis", route: "collaborative", questionId }); await settle(run.runId);
  assert.match(calls.at(-1).projectMemory, /PLUGIN_FIXTURE/);
  const terminal = (await core.request({ type: "terminal.open", projectId: project.id })).terminal;
  await assert.rejects(core.request({ type: "terminal.read", projectId: randomUUID(), id: terminal.id }));
  await core.request({ type: "terminal.write", projectId: project.id, id: terminal.id, text: "echo NEXIOM_TERMINAL_OK" });
  let output = "";
  for (let n = 0; n < 80; n++) { output = (await core.request({ type: "terminal.read", projectId: project.id, id: terminal.id })).terminal.output; if (output.includes("NEXIOM_TERMINAL_OK")) break; await delay(25); }
  assert.match(output, /NEXIOM_TERMINAL_OK/);
  await core.request({ type: "terminal.close", projectId: project.id, id: terminal.id });
});

test("CJK emphasis repair preserves literal escaped stars, code, and mathematics", async () => {
  const output = await build({ stdin: { contents: 'export { repairCjkStrong } from "./apps/desktop/renderer/markdown-repair";', resolveDir: process.cwd() }, bundle: true, platform: "node", format: "esm", write: false });
  const { repairCjkStrong } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
  const { unified } = await import("unified"); const { default: parse } = await import("remark-parse");
  const parseValue = value => unified().use(parse).use(repairCjkStrong).runSync(unified().use(parse).parse(value), { value });
  const tree = parseValue('这是**“重点”**的解释。 `**code**`');
  assert.ok(tree.children[0].children.some(n => n.type === "strong"));
  assert.ok(tree.children[0].children.some(n => n.type === "inlineCode" && n.value === "**code**"));
  assert.ok(!parseValue('\\*\\*literal\\*\\*').children[0].children.some(n => n.type === "strong"));
});
