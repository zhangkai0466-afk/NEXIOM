# 交互设计与 Agent 底层研究

访问日期：2026-09-18，Asia/Shanghai。本文是来源核验、设计决定及验收建议，不代表其中所有能力已经实现；实际交付以版本状态文档和运行验证为准。

本轮先通过 AnySearch 检索，再读取官方文档、仓库 README、许可证和相关源码。GitHub 树接口仅用于定位源码。未执行第三方仓库的安装脚本或研究代码，也未把网页中的提示词作为本项目指令。项目选择依据是与工作流的相关性，不以 star 数排序。

## 1. 基座决定

NEXIOM 继续直接使用 Codex 的开源执行引擎，在自己的桌面界面中提供更接近 Claude Code 的连续输出、工具过程与明确的任务状态。保持可替换的运行时边界；以后需要 Claude 引擎时接入官方 Agent SDK。

这样可以保留已运行的模型调用、工具循环、沙箱、会话恢复和取消路径，把新增工作集中在桌面体验、上下文可见性与数学建模工作流。模型推理和工具循环不在 React 或 NEXIOM Core 里重新实现。

| 对象 | 核验结果 | 对 NEXIOM 的实际含义 |
| --- | --- | --- |
| [OpenAI Codex](https://github.com/openai/codex) | 公共源码许可为 [Apache-2.0](https://raw.githubusercontent.com/openai/codex/main/LICENSE)。本项目已固定 `rust-v0.154.0` / `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`，来源见 `vendor/codex-sdk/provenance.json` | 可以复用 SDK 和执行引擎并保留相应许可。公开仓库不等于完整 Codex Desktop 前端源码；截图中的桌面布局由 NEXIOM 自行实现 |
| [Claude Code 公共仓库](https://github.com/anthropics/claude-code) | [LICENSE.md](https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md) 为 “All rights reserved”，使用受 Anthropic Commercial Terms 约束 | 不能将公开仓库称为可任意照搬的开源内核，也不能把公开 issue、文档和插件示例当作完整客户端源码 |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 官方明确提供 Claude Code 同样的工具、agent loop 和 context management；整体使用受 Commercial Terms 约束。[TypeScript 仓库许可](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/LICENSE.md) 为 All rights reserved；[Python 包装层许可](https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/main/LICENSE) 为 MIT | 可通过官方 SDK 使用 Claude 引擎；Python 包装层的 MIT 不会让捆绑的 Claude Code 运行时一并变成 MIT。未经预先批准，官方不允许第三方产品提供 claude.ai 登录或订阅配额，产品集成走文档允许的 API key 方式 |
| [OpenCode](https://github.com/anomalyco/opencode) | [MIT](https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE)，仓库包含 `packages/app` 和 `packages/desktop` | 是可以实际研究的完整开源 Agent 产品。采用其客户端/服务端分离、权限与上下文组织思想；当前不再同时引入一套 OpenCode 执行循环 |
| [Cursor Rules](https://cursor.com/docs/context/rules) | 官方文档可读，支持项目、用户、团队规则与 AGENTS.md；本轮没有发现可直接替代 Codex 的官方完整开源 Agent 内核 | 借鉴按文件、相关性、手动选择的上下文注入体验，不宣称复用了 Cursor 内核 |

Claude 的官方品牌指南允许在合适位置说明 “Powered by Claude”，但不允许把第三方产品叫作 “Claude Code” 或复用其品牌 ASCII 图案和造成混淆的视觉元素。NEXIOM 采用自身名称与标识，复现连续文字、工具状态、收起过程这些交互规律。具体推理、输出速度和记忆行为仍取决于所选引擎与模型，不能承诺两个引擎行为完全一致。

## 2. 交互与动画来源

| 来源 | 实际读到的内容 | 采用方式与边界 |
| --- | --- | --- |
| [Thinking Orbs 展示站](https://libraries.dev/orbs) / [源码](https://github.com/Jakubantalik/thinking-orbs) | 9 种状态；React 包 `thinking-orbs`；20px 和 64px 两套独立调校；2D Canvas；主题自动解析；reduced-motion 静态帧；离屏与页面隐藏时暂停；共享时钟；DPR 上限 2。[许可 MIT](https://raw.githubusercontent.com/Jakubantalik/thinking-orbs/main/LICENSE) | 使用小尺寸作为真实任务状态指示。根据事件选择 working、searching、solving、composing；不把一段未知等待假装为搜索或实验。错误、取消后停止。页面正文无需大型装饰性光球 |
| [Motion](https://motion.dev/) | [可访问性](https://motion.dev/docs/react-accessibility)提供 `MotionConfig reducedMotion="user"`；[包体积指南](https://motion.dev/docs/react-reduce-bundle-size)说明 `LazyMotion`、`m` 与按需功能包。[许可 MIT](https://raw.githubusercontent.com/motiondivision/motion/main/LICENSE.md) | 作为统一动画层，管理面板切换、工具展开与少量新增内容过渡。CSS 完成简单 hover，复杂布局交给 Motion，避免多套动画引擎互相影响 |
| [React Bits](https://reactbits.dev/) / [仓库](https://github.com/DavidHDev/react-bits) | 文本、互动组件和背景的源码式组件集合；JS/TS 与 CSS/Tailwind 版本。[实际许可](https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md)为 MIT + Commons Clause，允许作为产品的一部分使用，限制组件本身的销售/再分发等 | 参考过渡节奏、焦点反馈、互动细节。代码编辑器、公式与论文正文不采用模糊入场、逐字旋转或背景特效；不把它简称为纯 MIT 依赖 |
| [Animate UI](https://animate-ui.com/docs) | 基于 Motion 的源码式 React 组件分发，包括动画基础控件和 Lucide 动画图标。[实际许可](https://raw.githubusercontent.com/imskyleen/animate-ui/main/LICENSE.md)为 MIT + Commons Clause | 借鉴折叠、对话框和图标状态衔接。不为一个动画控件整体迁移现有组件栈；与 React Bits 一样按实际组件许可核验 |
| [21st.dev](https://21st.dev/) | 多作者 React/Tailwind 组件、模板、主题 registry，支持实时预览与源码式安装，存在免费与付费内容 | 作为组件发现与交互比较站。每个作者/模板的许可单独确认，不能把全站都算作 MIT，也不能把购买模板等同于可再分发整个素材库 |

Thinking Orbs 的旧站 `orbs.jakubantalik.com` 已指向新站。安装版本的类型声明是实际 API 依据：展示站和 README 的主题字段存在版本差异，不能只凭示例把 `dark` 和 `theme` 混用。

## 3. Claude 式输出应怎样实现

依据 [Claude 官方流式输出文档](https://code.claude.com/docs/en/agent-sdk/streaming-output)：默认消息是生成完成的内容块，启用 `includePartialMessages` 后才会收到 `stream_event`；正文增量来自 `content_block_delta` 中的 `text_delta`。完整消息也会到达，必须按 message/block 标识去重。文档还明确：子 Agent 的 token 级增量并不按主会话同样方式转发，不能虚构该能力。

NEXIOM 的可见体验需要来自真实事件：

1. 请求发出后立即出现真实运行状态、已用时间与停止按钮。
2. 可见正文到达时增量追加；更新合并到每帧或短批次，避免逐 token 重排整棵 Markdown 树。
3. 工具开始时插入稳定位置的紧凑工具行；执行输出属于该工具，完成后显示真实退出状态。
4. 最终回答与中途进度分开；完成后静止，不再次播放整段打字效果。
5. 只有上游实际提供的可公开分析摘要才进入“分析摘要”。状态动画、耗时和文字生成均不代表展示了模型完整内部推理。
6. 历史会话打开时直接呈现已保存内容；断线重连按事件序号或完整 item 覆盖恢复，不能产生重复段落。

如果当前 SDK 只暴露内容块完成事件，前端的字符动画只能称为显示过渡。真正的逐块/逐段实时性应由引擎支持的增量协议解决，不能在回答全部生成后做慢速回放来冒充实时输出。

## 4. 上下文与记忆

| 来源与已核验能力 | NEXIOM 采用的决定 |
| --- | --- |
| [Claude Memory](https://code.claude.com/docs/en/memory)区分用户编写的 CLAUDE.md 与自动记忆；强调这些是上下文，不是强制权限；长规则应拆成按需规则或 skills | 区分“项目指令”“长期记忆”“当前任务状态”。用户可检查记忆内容与来源、编辑和删除。文件规则不能绕过 Core 的运行权限 |
| [OpenCode Rules](https://opencode.ai/docs/rules/)支持 AGENTS.md 和显式 instruction 文件；[Agents](https://opencode.ai/docs/agents/)区分 plan/build、只读探索与专用子 Agent | 保持规划和执行在运行时的真实边界，不能只改输入框标签。为未来专用建模、实验、论文角色保留接口，但不把每次简单问题拆成多 Agent |
| [OpenCode compaction.ts](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/compaction.ts)实际实现了近期内容预算、旧工具结果裁剪、独立压缩总结、压缩后继续以及溢出失败处理 | 学习“保留近期事实与目标、旧日志可回取”的策略。压缩首先委托现有引擎；不照抄 OpenCode 的固定 token 阈值，不在外层再次压缩同一历史造成事实丢失 |
| [Cursor Rules](https://cursor.com/docs/context/rules)用 alwaysApply、description、globs 和手动引用决定何时加入规则 | 上下文查看器应列出本轮实际使用的项目规则、记忆和附件来源。长期规则只放跨任务稳定信息，专项方法以 skills 按需载入 |
| Codex 现有固定版本运行时负责 session/thread 恢复与模型工具循环 | 保存并恢复引擎 thread ID；UI 的聊天历史不等于引擎的全部上下文。更换运行时或服务商时，明确创建新引擎会话，并提供有来源的交接摘要 |

记忆建议分为四层：

- 项目指令：语言、路径、工具和团队约定。保持精简，文件可版本管理。
- 稳定事实：数据单位、已确认假设、用户明确选择、失败方法。每条带来源和更新时间，出现冲突时保留修订记录。
- 任务交接：当前目标、已完成步骤、未解问题、下一步与关键产物。用于新会话继续工作，不用于扩大已授权的范围。
- 大型证据：完整工具日志、实验结果、数据和论文版本留在文件/数据库中，按需读取。不能把全部材料塞进一条永久提示词。

不能仅凭累计输入/输出 token 推出“上下文已占用 70%”。累计用量、当前上下文、压缩次数是不同指标；引擎不返回当前占用时，界面应不显示精确占用百分比或明确标为估计。记忆过期也不能让旧结果恢复为当前事实。

## 5. 数学建模与科学 Agent 项目

### 5.1 MM-Agent

来源：[usail-hkust/LLM-MM-Agent](https://github.com/usail-hkust/LLM-MM-Agent)，读取 README、LICENSE 和 [Coordinator 源码](https://github.com/usail-hkust/LLM-MM-Agent/blob/main/MMAgent/agent/coordinator.py)。

职责：问题分析、模型方法检索、代码求解、报告生成；HMML 按领域/子领域/方法组织知识。源码将子任务表示为依赖图，进行拓扑排序并检查循环，体现了题目各小问之间的依赖。

值得借鉴：模型选择依据要可见；各问的输入输出关系先于调度；方法库应记录适用条件、假设与验证手段。

NEXIOM 决定：依赖图使用自身领域数据与 schema 校验，节点关联实际成果。研究源码中的内存字典与宽泛解析重试不直接作为持久化任务系统；不把方法检索命中当成模型有效性的证明。

许可边界：访问时 [LICENSE](https://raw.githubusercontent.com/usail-hkust/LLM-MM-Agent/main/LICENSE) 是 GPL-3.0 正文，但 README 写 CC BY-NC 4.0，存在声明冲突。本轮只研究设计，不复制其实现；未来若复用具体文件，须先核清该版本适用许可。

### 5.2 CUMCM Skills

来源：[Jiaobin-1/cumcm-skills](https://github.com/Jiaobin-1/cumcm-skills)，[MIT](https://raw.githubusercontent.com/Jiaobin-1/cumcm-skills/main/LICENSE)。读取 README 及 [claim-evidence-mapping.md](https://github.com/Jiaobin-1/cumcm-skills/blob/main/skills/cumcm-paper/references/claim-evidence-mapping.md)。

职责：运行在现有 coding agent 之上的数模 skills 和确定性验证脚本，不是独立桌面执行内核。包含角色分工、质量关口、图表和论文工具。

值得借鉴：模型与基线先实际运行；论文数字关联机器生成结果；图表关联生成脚本；缺少证据时明确指出缺失。

NEXIOM 决定：落实原有 `Experiment -> Metric/Artifact -> Claim -> PaperBlock` 关系，增加哈希、数据版本、评价协议。不能仅凭论文里出现相同数值就判为“证据一致”；相同数字可能来自不同指标、单位或数据集。竞赛页数和规则必须绑定当年官方来源，不能直接采用 README 内的固定限制。

### 5.3 Math Modeling Agent Flow

来源：[mantou6666/Math-Modeling-Agent-Flow](https://github.com/mantou6666/Math-Modeling-Agent-Flow)，[MIT](https://raw.githubusercontent.com/mantou6666/Math-Modeling-Agent-Flow/main/LICENSE)。读取 README 和 [evidence-ref.schema.json](https://github.com/mantou6666/Math-Modeling-Agent-Flow/blob/main/math-modeling-finalizer/schemas/evidence-ref.schema.json)。

职责：Solver、Paper、Finalizer、Growth 四阶段 skills，围绕阶段交接、结果验证、提交冻结和赛后复盘组织任务。证据 schema 明确区分结果证书、文件产物和人工审查记录，并包含 SHA-256。

值得借鉴：阶段之间传递已确认事实；提交前审查附件与论文版本一致性；赛后提炼可复用经验。

NEXIOM 决定：交接与复盘进入可追溯的项目记忆，但交接文档不替代数据库中的任务状态、权限和证据引用。默认工作流可跳转和回退，不把三天竞赛锁成不可调整的线性四步向导。

### 5.4 AIDE ML

来源：[WecoAI/aideml](https://github.com/WecoAI/aideml)，[MIT](https://raw.githubusercontent.com/WecoAI/aideml/main/LICENSE)。读取 README 和 [aide/journal.py](https://github.com/WecoAI/aideml/blob/main/aide/journal.py)。

职责：在代码方案空间进行 draft/debug/improve 搜索，由真实运行和评价指标指导下一次尝试。源码的 Node 包含父子关系、代码、计划、执行耗时、异常、分析和评价指标；Journal 维护实验节点与最优结果。

值得借鉴：保留失败实验，显式区分“修复错误”和“改进有效方案”；比较指标必须同时保存优化方向；最优方案需要可回溯。

NEXIOM 决定：先建设独立 Experiment 记录和固定评价协议，再增加受预算约束的候选方案比较。国赛的解释性、约束满足、稳健性和可写性不应被单个 leaderboard 指标代替；不照搬无预算的搜索树。

### 5.5 The AI Scientist

来源：[SakanaAI/AI-Scientist](https://github.com/SakanaAI/AI-Scientist)，读取 README 和 [LICENSE](https://raw.githubusercontent.com/SakanaAI/AI-Scientist/main/LICENSE)。

职责：围绕可编码研究模板生成想法、运行实验、绘图、写作和评审。README 实际描述的标准模板主要面向 Linux、CUDA、PyTorch；`experiment.py`、`plot.py`、结果目录及 LaTeX 模板形成约定。

值得借鉴：基线与改进实验使用统一产物协议；绘图从结果文件重新生成；写作与运行结果有明确联系。

NEXIOM 决定：采用显式环境和输出契约，保持本地 Windows 与 CPU 数学建模路径。模型评审作为辅助检查，计算验证与用户判断保留独立地位。不把它包装成已验证的全国大学生数学建模竞赛系统。

许可边界：访问时为 2025-12 的 The AI Scientist Source Code License，基于 Responsible AI Source Code License，并包含生成论文的披露要求。不是纯 MIT/Apache；本轮不导入源码。

## 6. 八项可执行设计决定

| 决定 | 实现要点 | 可检查的验收 |
| --- | --- | --- |
| 1. 从主题 token 重建视觉基础 | 暗色用深灰主区、略有冷调的侧栏和明晰层级，浅色使用对应语义 token；系统/浅色/暗色可持久化；原生标题栏同步主题 | 重启后主题保留，切换系统模式时同步；正文、工具、公式、弹窗、滚动条和文件预览全部可读 |
| 2. 修正文字符号与像素表现 | 系统优先字体如 Segoe UI Variable Text、Segoe UI、Microsoft YaHei UI；侧栏约 14px、正文约 15px、代码约 13px，固定字号并允许应用缩放；统一 Lucide 尺寸与线宽 | Windows 100%、125%、150% 缩放截图；正文无 transform/scale/blur；图标和字体不靠图片放大；公式和中英文换行不遮挡 |
| 3. 圆角服务于交互层级 | 输入区约 20-24px、用户消息约 14-18px、选中行约 8-10px；正文保持开放排版，工具明细集中折叠 | 对照用户截图检查侧栏密度、会话宽度、顶部留白和底部输入区；圆角不会造成行高和 hit area 变化 |
| 4. 动画与真实状态绑定 | Thinking Orbs 小尺寸状态指示；控件反馈约 120-160ms，面板/工具展开约 180-240ms；Motion 统一时序；动画只在需要表达状态变化时运行 | 工作时状态可见；完成/取消后静止；隐藏窗口和离屏时暂停；reduced-motion下仍能读懂状态 |
| 5. 连续输出与阅读位置稳定 | 接收真实增量、合并刷新、工具结果按 ID 更新；仅在用户接近底部时自动跟随；用户上滚后显示回到底部入口 | 长回答无重复和丢字；历史内容不重播；用户阅读旧内容时不会被强制拉回；长代码、表格和公式不撑破会话宽度 |
| 6. 上下文与记忆可以检查 | 原生 session恢复；显示已加载的指令/记忆/附件；项目记忆可编辑和删除；区分上下文状态与累计用量 | 重启续接能使用已保存事实；跨项目隔离；删除记忆后后续注入消失；没有引擎数据时不显示假精度百分比 |
| 7. 数学建模结果有证据链 | 复用原有领域模型，逐步实现输入版本、代码快照、执行记录、结果指标与论文引用；把验证结果和模型自述分开 | 改输入后旧指标/论文引用标为过期；失败实验不成为有效结果；每个最终数字能定位实际运行和文件版本 |
| 8. 桌面软件有完整生命周期 | 桌面快捷方式、独立窗口、持久项目、单实例焦点、版本信息、停止和重启恢复；打包时携带真实引擎与第三方许可 | 从快捷方式启动，无开发服务器也能运行；关闭活动任务时进程可回收；升级不覆盖项目数据；错误可见且可诊断 |

动画时长和字号是 NEXIOM 的起始设计值，不是从 Codex 或 Claude 源码读取的官方参数。性能目标为常规窗口下接近显示器刷新率；需通过实际 Chromium/Windows 录制和截图验证，不能仅凭使用 Motion 就宣称稳定 60fps。Thinking Orbs 的 DPR 上限只作用于状态 Canvas，不应限制整个 Electron 窗口的文字渲染分辨率。

## 7. 实施顺序与完成定义

本轮优先完成真实桌面入口、双主题、字形与图标基线、圆角与动画、过程输出可见，以及可以检查和维护的项目记忆。保持现有 Codex 执行内核，先验证工具、取消、会话恢复和增量显示之间的完整链路。

下一步继续既有架构中的实验与证据模块：固定输入与环境、重复计算、结果比较、论断绑定、论文导出。这部分不能因为增加了数模提示词或持久化聊天记录，就宣布已经具备完整科学工作流。

Claude Agent SDK 作为可选引擎接入时，需要实现独立适配器、能力声明、认证配置、流式消息去重、session恢复、权限映射和取消测试。其凭证、session ID 与上下文不与 Codex 混用；没有真实连接验收的引擎不在产品里显示为已可用。
