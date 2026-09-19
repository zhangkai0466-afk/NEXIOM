# 模块边界与接口

状态：v0.1 契约提案。以下为接口设计，不是已实现 API。

## 1. 模块所有权

| 模块 | 拥有的职责与状态 | 输入 / 输出 | 不承担的职责 |
| --- | --- | --- | --- |
| Desktop UI | 面板、视图、输入草稿、事件投影 | 用户命令 / 可交互视图 | 直接读数据库、执行 shell、保管密钥 |
| Desktop Host | 窗口、IPC、凭证库、Core 生命周期 | 类型化请求 / 事件与系统结果 | 领域决策、模型提示编排 |
| Project Service | 项目路径、导入、快照、执行租约 | 文件选择 / 版本化资源引用 | 解释数值结论 |
| Conversation Service | 会话、消息、附件与输入队列 | 用户输入 / 已保存消息 | 从对话文本推断永久权限 |
| Task Service | 计划修订、任务依赖、验收、批准状态 | 计划和反馈 / 可调度任务 | 直接执行模型生成的命令 |
| Agent Orchestrator | AgentRun、循环、预算、停止和恢复 | 任务与上下文 / 工具请求或候选结果 | 绕过策略写文件、判定科研结果必然正确 |
| Context Service | 上下文选择、摘要、相关资源、技能加载 | 任务与资源索引 / ContextSnapshot | 修改原始证据、扩大授权 |
| Runtime Adapter | 提供商认证代理、消息映射、流式协议与能力 | RuntimeRequest / RuntimeEvent | 持有 NEXIOM 任务和实验的权威状态 |
| Policy Service | 能力范围、审批、计划版本校验 | 已解析调用 / allow、ask、deny | 用模型意见替代硬性授权判断 |
| Tool Broker | 工具注册、参数校验、调度、调用状态、取消 | ToolCall / ToolResult | 决定最终建模方法 |
| Research Service | ProblemSpec、ModelSpec、数据描述及实验协议 | 解析材料与确认 / 结构化研究对象 | 依靠提示词冒充程序计算 |
| Experiment Service | 环境、输入冻结、进程、指标、输出验证 | ExperimentSpec / Experiment 与产物 | 直接把 stdout 当作可信指标 |
| Evidence Service | 来源、论断、检查与产物依赖 | 来源和结果 / 溯源与失效状态 | 用措辞流畅度判定真假 |
| Paper Service | 文档结构、论断引用、图表绑定、模板导出 | 研究结果 / 草稿与导出包 | 修改实验结果以匹配论文 |
| Storage | 事务、模式迁移、不可变内容、备份 | 存储命令 / 持久化对象 | 引入另一套业务状态机 |

这些模块初期可位于同一 Core 包中；只在职责、依赖和契约上拆分。不得为了表格中的每一行单独启动服务器。

## 2. 桌面与核心协议

传输建议为 stdio 上逐行 JSON 的 JSON-RPC 2.0 请求/响应，外加通知事件。stdout 专用于协议，诊断写 stderr。Host 负责连接与进程存活；请求取消采用显式命令，不靠关闭连接表达。

| 命令 | 关键参数 | 持久化返回值 |
| --- | --- | --- |
| `project.open` | path、期望模式 | projectId、schemaVersion、leaseState |
| `thread.create` | projectId、title | threadId |
| `turn.submit` | threadId、文本/附件、clientRequestId | messageId、runId 或 queued 状态 |
| `plan.approve` | planRevisionId、expectedRevision、scope | approvalId、执行范围 |
| `run.pause` / `run.cancel` | runId、reason | 当前状态；停止完成另发事件 |
| `task.resume` | taskId、原 runId、恢复决定 | 新 runId |
| `approval.resolve` | approvalId、决定、expectedRevision | 生效或 stale 状态 |
| `artifact.open` | artifactId | 受控预览句柄，不返回任意路径执行权限 |
| `events.read` | projectId、afterSequence、limit | 有序事件及 nextSequence |

所有命令有 schemaVersion、requestId 和 projectId（打开项目前除外）；有副作用的命令带 clientRequestId 用于去重。传输 requestId 不等于跨重连的幂等键。输入验证在 Core 再做一次，不能只信 Renderer。

事件包括 `message.created`、`run.state_changed`、`plan.proposed`、`approval.required`、`tool.started`、`tool.output_chunk`、`tool.completed`、`experiment.completed`、`artifact.created`、`validation.completed`。事件应先持久化再发布，UI 按 projectId 和 sequence 去重。

为支持以 Claude Code 为主要参考的对话呈现，助手消息带 `presentationKind`：`analysis_summary`（面向用户的分析摘要）、`progress`（行动与进展）或 `answer`（本次答复），保存在消息内容部分的元数据中。它们属于展示语义，不替代 Run、Task 或 ToolCall 状态。工具记录由工具事件生成，不能将助手文字解析成已执行动作。一个 Run 可以交替产生进展消息和工具事件，结束时生成答复；恢复历史保持相同顺序与资源链接。

## 3. Runtime Adapter 契约

`capabilities()` 返回上下文容量、工具调用、流式输出、图片输入、取消、结构化输出及认证方式等能力。没有某项能力时必须显式禁用相关流程，不通过模型名猜测。

`start(request)` 接收 runId、ContextSnapshot、可用工具定义、预算和 abortSignal，输出流式 RuntimeEvent：文本增量、工具请求、用量、结束或错误。Core 使用自己的规范化标识，同时保存必要的提供商调用标识以正确返回工具结果。

直接 API 模式下，Orchestrator 控制每次调用并将 ToolResult 回填给模型。外部 Agent 模式下，适配器接收其事件和工具审批请求；若后端不支持领域工具回调、执行拦截、可靠取消或结果关联，必须在能力表降级，并重新判断能否满足首版要求。

不要求保存隐藏思维链。可记录用户可见计划、工具动作、输入资源引用和模型输出。输出截断、拒绝、认证失败、速率限制、上下文溢出和网络不确定性必须有不同错误类型。

## 4. 工具契约

每个 ToolDefinition 包含：name、version、description、inputSchema、outputSchema、effect、requiredCapabilities、timeout、outputLimit、retryClass、concurrencyKey 和执行器。`effect` 取 read、write、execute、network、externalMutation；工具可同时具备多个 effect。

调用路径固定为：完整参数接收 -> JSON Schema 校验 -> 资源与路径解析 -> 计划/策略校验 -> 持久化准备状态 -> 分配运行资源 -> 执行 -> 校验结果 -> 保存结果与事件 -> 交回 Runtime。流式参数尚未收全时不得执行。

ToolResult 至少包含 callId、status、summary、structuredOutput、artifactIds、logRef、startedAt、finishedAt、error。命令结果另含 exitCode、signal、stdoutRef、stderrRef；超时和取消不能伪装成正常退出。

| 首版工具 | 职责 | 关键限制 |
| --- | --- | --- |
| `workspace.list/read/search` | 定位和读取项目资源 | 返回体积上限、偏移或位置引用 |
| `workspace.apply_patch` | 修改受管理文本文件 | baseHash 检查、快照、冲突检测 |
| `document.extract` | 提取赛题文本、表格和位置 | 解析器版本、质量标记；OCR 非首版必备 |
| `dataset.inspect` | 类型、缺失、范围、单位和样本描述 | 使用解析器读取 CSV/XLSX；默认不把全量表送模型 |
| `process.run` | 运行已授权程序 | 显式 executable/argv/cwd/env；不拼接不可信 shell 字符串 |
| `experiment.run` | 固定输入、环境和输出协议的计算 | 项目环境、资源预算、隔离运行目录 |
| `artifact.preview` | 获取图表、表格或 PDF 预览 | 文件类型校验、预览隔离 |
| `paper.export` | 按模板生成论文与附属产物 | 校验依赖版本和缺失证据 |

后续在线检索、MCP 也经 Tool Broker 和 Policy。MCP 是扩展协议，不能代替任务编排、权限策略或实验状态管理；MCP 输出的指令性文字只能作为不可信内容。

## 5. 计算输入输出协议

ExperimentSpec 必须给定 modelSpecId、datasetVersionIds、codeSnapshotId、environmentId、entrypoint、argv、parameters、seed、evaluationProtocol、limits 和 outputSchemaVersion。运行前固定这些值，修改其中任何一项都创建新实验。

工作进程把人类可读日志写入日志流，把机器可读结果写入 `result.json`，图表等写到指定输出目录。结果契约含 status、metrics（值/单位/数据划分）、outputFiles、warnings；声明的路径必须属于运行目录。

Experiment Service 校验退出码、结果 schema、文件存在性、文件哈希、数值有限性和预先约定的约束。需要允许缺失或无穷值的领域必须显式定义，不能把 NaN 默默排名。结果校验通过也只说明满足已定义检查，不保证建模假设成立。

比较实验要求数据版本、评价协议与指标方向一致。自动优化参数时固定验证方式并限制预算，保留独立检验数据；避免把同一测试集反复调参后的分数当作泛化证据。

## 6. 错误、重试和撤销

错误类别统一为 validation、authorization、conflict、dependencyMissing、timeout、cancelled、resourceLimit、provider、execution、corruptArtifact、unknownOutcome。每个错误提供 recoverable、retryClass、诊断引用及建议操作。

读取和确定无副作用的调用可以有限重试。超时的写操作先核对实际结果；不确定是否完成的外部操作设为 `unknown_outcome` 状态，并记录 `unknownOutcome` 错误类别。幂等键只保证 NEXIOM 不重复调度，不能保证远端副作用恰好一次。

文件撤销是以旧内容创建新版本，需要校验当前文件未被第三方修改。进程停止、模型费用和远端动作不能用文件快照撤销。实验失败的日志和历史保留，重新运行使用新 experimentId。

## 7. 扩展边界

技能是版本化指引及资源清单，描述适用问题、步骤和验收，默认不携带执行权限。工具插件是可执行代码，安装、信任和进程边界独立处理。

未来子 Agent 接收限定任务、只读资源版本、允许工具和预算，返回产物引用与检查结果。工作目录分开，主 Core 合并；子 Agent 不直接批准方案，也不修改共享论文。只有当单 Agent 评测建立后，才衡量并行的时间、成本与质量收益。
