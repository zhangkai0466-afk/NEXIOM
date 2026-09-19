# MathModelAgent 逆向分析

分析对象：`jihe520/MathModelAgent`，本地快照提交 `487f350`（2026-09-13）。

## 结论

MathModelAgent 不是一个单一 Agent，而是两套架构并存：

1. **新版 Skills 工作流**：把 Codex、Claude Code 等现成执行器当作运行时，用若干 `SKILL.md` 规定阶段、文件契约、工具权限和验收规则。这是仓库当前重点。
2. **旧版 Web 多 Agent 系统**：Vue 前端、FastAPI 后端、Redis/WebSocket 消息总线，后端显式创建 Coordinator、Modeler、Coder、Writer 四个 Agent。

新版真正有价值的设计不是“多 Agent 数量”，而是阶段隔离和可验证产物：上一阶段通过文件向下一阶段交付，最终再编译、扫描并目视检查 PDF。

## 新版调用链

```text
用户题目与附件
  -> 1start-mathmodel（偏好、plan.md、todo.md）
  -> 2analysis-modeling（题意、歧义、模型、实现接口）
  -> 3coding-visual（代码执行、结果、数据图）
  -> 4drawio（流程图、架构图）
  -> 5writing（套用 Typst/LaTeX 模板、写论文）
  -> 6verity（文本门禁、数值核对、编译、PDF 视觉检查）
```

阶段间的关键文件契约：

- `plan.md`、`todo.md`
- `reports/ANALYSIS_MODELING_REPORT.md`
- `code/`、`results/`、`reports/RESULTS_REPORT.md`
- `figures/`、`reports/DRAWIO_REPORT.md`
- `paper/main.typ` 或 `paper/main.tex`
- `reports/VERIFY_REPORT.md`

这是一种“黑板式工作流”：共享文件系统承担状态和 Agent 间通信。优点是透明、可恢复、方便人工修改；缺点是缺乏强类型状态和事务控制。

## 旧版 Web 调用链

```text
POST 建模任务
  -> 后台 asyncio task
  -> Coordinator：判断是否为数模题并拆分子问题
  -> Modeler：为 EDA、各子问题、灵敏度分析生成方案
  -> 创建本地 Jupyter 解释器
  -> 对每个求解节点串行执行：
       Coder -> execute_code -> 错误反馈 -> 重试
       Writer -> 按模板写对应章节 -> 可选 search_papers
  -> Writer 再生成摘要、问题重述、假设、符号、评价
  -> 保存汇总结果
```

四个角色：

| 角色 | 输入 | 输出 | 工具 |
|---|---|---|---|
| Coordinator | 原始题目 | 背景、子问题数量和子问题文本 | 无 |
| Modeler | 结构化题目 | 每问求解路线 | 无 |
| Coder | 建模方案、数据文件列表 | 执行代码、结果、图片 | `execute_code` |
| Writer | 题目、代码结果、模板、图片 | 论文章节 | `search_papers` |

Coder 是旧架构中唯一形成真实闭环的 Agent：模型生成代码，Jupyter 执行，错误消息回灌给模型，直到成功、达到重试上限或聊天轮次上限。Writer 的文献检索接入 OpenAlex。

## 模型与基础设施

- 后端：Python 3.12、FastAPI、Pydantic、asyncio。
- 前端：Vue 3、Vite、Pinia、Tailwind。
- LLM：OpenAI Chat Completions、OpenAI Responses、Anthropic 三类适配器；四个角色可配置不同模型。
- 执行环境：本地 Jupyter kernel；仓库还包含 E2B 实现，但主工作流硬编码选择 `local`。
- 任务通信：Redis 发布消息，WebSocket 推送前端。
- 结果资产：Notebook、图片、Markdown，以及新版中的 Typst/LaTeX/PDF。

## 真正的“护城河”

1. **提示词与规范资产**：数模题型防错、模型选择、图表规范、论文结构和验收规则。
2. **模板资产**：多种中文赛事及 MCM/ICM 的 Typst/LaTeX 模板。
3. **执行反馈**：代码必须实际运行，错误可进入重试回路。
4. **数据来源约束**：写作阶段只能引用结果报告、结果表和生成图表中的数值。
5. **最终质量门禁**：占位符、内部路径泄露、图片缺失、数值冲突、编译错误及版式问题都属于硬错误。

## README 宣称与代码现实

以下能力在配置或 README 中出现，但在旧版主工作流中没有形成完整闭环：

- HIL：存在 `HIL_ENABLED`、超时和检查点配置，但主工作流未执行审批暂停/恢复。
- RAG：存在 ChromaDB、Embedding、Reranker 配置与依赖，但未找到主工作流中的检索调用。
- Tavily：存在 API Key 配置，实际 Writer 使用的是 OpenAlex。
- Fallback handoff / evaluator shadow mode：主循环只有基础重试，没有完整 evaluator 或自动模型切换。
- 多 Agent 并行：求解和写作节点使用普通 `for` 循环串行执行，源码也保留了 parallel TODO。
- E2B：实现存在，但主流程传入 `kind="local"`。

这说明仓库正在从旧 Web Agent 框架迁移到 Skills 架构；不能把 README 的所有特性都视为已实现。

## 主要工程风险

1. **可信边界过宽**：新版 Skills 允许广泛的 Bash、读写和网络操作；处理不可信赛题附件时需要沙箱、路径白名单和资源限额。
2. **代码执行风险**：旧版默认本地执行 LLM 生成的 Python，适合个人环境，但不适合直接暴露为多租户服务。
3. **结果污染**：Writer 使用持续累积的聊天历史，章节之间可能发生信息串扰；应为每节提供显式、最小化上下文。
4. **工具调用不完整**：Writer 只处理第一个工具调用，检索后只再调用一次模型，连续或多工具调用可能丢失。
5. **状态不强类型**：新版依赖 Markdown 文件作为阶段接口，便于查看但难以自动保证字段完整性和数值血缘。
6. **许可证限制**：仓库文档声明仅限个人免费使用、禁止商业用途、禁止闭源分发和基于其提供商业服务。复刻应采用 clean-room 方式，不直接搬运提示词、模板、图片或代码。

## 可独立复刻的最小架构

推荐保留它的工作流思想，但重做实现：

```text
Orchestrator
  |- Intake：解析题面、附件和竞赛约束
  |- Modeling：输出强类型 ModelSpec
  |- Solver：生成代码，在隔离容器执行
  |- Evaluator：约束、基线、敏感性和数值一致性检查
  |- Writer：只消费已验证 ArtifactManifest
  `- Publisher：模板渲染、PDF 编译和视觉 QA
```

建议的核心对象：

```text
ProblemSpec     = 题目、子问题、附件清单、单位、歧义
ModelSpec       = 变量、假设、目标、约束、算法、验证方法
RunManifest     = 环境、代码哈希、随机种子、输出文件、指标
ArtifactManifest= 表格、图、可引用数值及其来源
Verification    = 检查项、证据、PASS/WARN/FAIL
```

关键改进：

- 每个数值带来源 ID，论文只能引用 ArtifactManifest 中已验证的值。
- 本地宿主不直接执行模型代码，改用无网络容器、CPU/内存/时长限制。
- 把重试分成语法修复、数据修复、模型修复，不使用无界重试。
- Evaluator 独立于 Writer，避免同一个模型既生成又给自己验收。
- 阶段使用状态机，支持 checkpoint、人工审批和从失败节点恢复。
- Skills 只保留流程规则；赛事知识、模板、验证器分别版本化。

## 复刻优先级

1. 先实现 `ProblemSpec -> ModelSpec -> Solver -> Verification`，暂不做论文。
2. 加入 ArtifactManifest 和严格数值血缘。
3. 接入一个 Typst 模板和 PDF 编译/渲染检查。
4. 再扩展比赛模板、文献检索、HIL 与多模型路由。
5. 最后才做 Web UI、桌面打包和多用户任务系统。

最小可用版本不需要四个长期对话 Agent。一个状态机编排器、三个短上下文角色（Modeler、Solver、Writer）和一个确定性验证层，通常会更稳、更容易复现。
