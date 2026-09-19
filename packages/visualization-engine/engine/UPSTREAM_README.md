# AI可视化设计 MCP

1.7.1 赛前冻结：[比赛使用说明](docs/competition-1.7.1.md)。新增 `run_visual_stage_unit` 与 `visual_stage_report`：第一层开放候选池，第二层独立正文15—20张目标；独立目录、单元输入绑定、数量不足检查。第二层不强制依赖第一层。沿用60秒/最多10次模型请求容错，不扩展绘图后端。

1.7.0 新增[分阶段研究与证据执行](docs/research_workflow.md)：项目发现→图形用途卡与资料分页→配置模型小单元研究→确定性分析生成新证据→核验→原有选图/绘图→叙事完善。研究卡经搜索接口及分页接口提供；支持明确的覆盖进度，不再只把图名交给模型。新增8个工具，不改变论文撰写/本地Codex职责边界。

1.6.0 新增[证据先行、叙事完善双阶段流程](docs/two_stage_visual_design.md)：先从数据及研究资料建立候选图池，再结合章节选择、复用和完善。新增雷达图、三维柱阵列、三维曲面/线框执行模板，当前共62种可执行模板。模型读取中央配置，不固定为某个型号；本次实测使用 GPT-6 Astra。新流程返回 `review_required`，不会把成功出图直接当成论文验收通过。

## 科研绘图依赖

绘图采用 Matplotlib + Seaborn + SciPy。`boxplot` 使用 Seaborn 分类箱线图；
`histogram_density` 使用 Seaborn 密度直方图与 KDE（Scott 带宽、cut=0，常量或单样本组跳过 KDE）；
`qq_plot` 使用 SciPy 正态理论分位数，保留原有概率位置和标准化口径。
其他模板继续使用 Matplotlib。Seaborn 不调用全局 set_theme，直接使用现有 Studio 配色、
中文字体、图层和 PDF/PNG/SVG 导出流程。KDE 是描述性平滑，不是置信区间，
也不会重新训练模型或生成评价指标。库优先检索及冻结证据流程保持原有入口。

安装或迁移生成脚本时，在实际绘图解释器中运行：

```powershell
python -m pip install "matplotlib>=3.8,<4" "seaborn>=0.13.2,<0.14" "scipy>=1.11,<2" "pandas>=2.1,<4"
```

`health_check` 的 `plotting_libraries` 返回绘图依赖版本和导入状态；缺失或导入失败时状态为 `needs_configuration`。

既有入口继续保留：消费上游 `visual_requests[]` 的单批执行入口，以及从完整 LaTeX 论文与冻结数据目录出发的全文可视化入口。全文入口从问题重述、本文工作、数据理解与预处理一直扫描到各问建模、求解、验证、稳健性、评价和应用；忽略原有图片形式，先由配置模型完成视觉论证规划，再由本地确定性链批量生成、渲染、检查灰度与交付完整性。

正式落地的责任边界固定如下：AI 只处理“该画什么、删什么、合并什么、选择何种视觉语法、哪些语义标注不可缺失”等设计问题；标签旋转、图例遮挡、边距、字号等常规排版问题由模板中的确定性规则先行修复，剩余项目进入人工微调队列，禁止为了这些小问题再次调用 AI。

1.5.0 将“模板库”和“图名发现库”继续分开：59 个 `executable` 条目有确定性 Jinja 渲染器，另外 243 个 `name_index_only` 条目用于解决“见过但不知道叫什么、只知道用途”的检索问题，总索引 302 项。其中 159 项映射到 OriginLab 官方 Graphing 分类或图种；新增的 32 张用户科研绘图截图已经逐张登记图名、数据形状、适用条件与禁用条件。MCP 工具 `search_visual_grammar_terms` 同时支持中文名、英文名、别名和读者问题片段，`list_visual_grammar_index` 返回当前覆盖规模。`name_index_only` 绝不伪装成已经能直接生成的模板；模型若选中它，只能提出扩展请求。

本轮又新增 6 个可执行科研图：多特征分面密度—地毯图、双组分裂豆荚图、多模型观测—预测诊断分面图、共箱分组堆叠渐变直方图与理论正态拟合、SHAP 依赖—边际分布分面图、排序坐标分组椭圆图。SHAP、回归统计量、显著性、区间、断点、PERMANOVA 和空间边界均受证据门槛约束；模板只消费冻结结果或执行明示的确定性汇总，不代替算法会议计算或虚构统计量。

模板库包含 59 个已注册 Jinja2 模板，包括基础比较、分布、关系研究、预处理前后对照、时序/采样诊断、分类错误、阈值权衡、不确定性、空间、排程、网络和结果验证等类别。生成脚本均支持 PDF、PNG、SVG，并强制执行 PS-FILL-001 与 PS-LAYER-001。柱图默认使用“同色系浅填充＋较深有色细描边”，有原始重复观测时优先叠加点和误差区间；禁止厚黑边。渐变柱只在顺序或堆叠语义明确、柱宽足够且输出不依赖灰度复印时启用。配色不在 MCP 内维护副本：每次构建设计包都实时读取 `../可视化审美研究/studio/data/palettes.json`，将色板名称、语义标签、背景/墨色、强调色和完整 HEX 提供给 GPT-5.6 Sol；模型只能从平台已注册色板中选择并说明理由。热力图优先推荐“雾蓝陶橙”，但语义与可读性理由充分时可改选其他连续色板。

知识库与渲染模板库分离：`corpus/pattern_library.json` 保存“读者问题—候选表达—使用前提—禁用情景”，只负责发现视觉机会，不会把问题类型机械映射为固定图种；`templates/manifests/core.json` 才声明可执行渲染器。当前案例模式由 1 条扩充到 11 条，覆盖领域解释、全文路线、预处理证据、关系研究、时序、迭代求解、概率采样、分类验证、优化权衡与稳健性边界。

同一冻结数据文件允许生成回答不同读者问题的互补视图，例如“整体相关结构”和“重点变量非线性关系”；系统只删除“同一证据 + 同一视觉角色 + 同一读者问题”的语义重复项。正式完成同时要求 `render_ready=true` 与 `argument_coverage_ready=true`，不以图片成功落盘或为凑数量作为完成标准；同时以 20 图作为数据图与结构图的全文建议上限，超出后阻断自动落地，必须逐图压缩或由本地 Codex 明确批准必要性例外。概念图机会和缺失实验会进入 `structural_decisions` 与 `evidence_gaps`，未裁决时阻断正式落地。

默认采用一图一面板，但不设置固定面板数。多个响应量、情景或对象若共享同一读者问题、视觉角色、坐标和图例语义，并且必须联合扫读才能得出结论，可由 GPT-5.6 Sol 自行决定面板数量；本地确定性审计只检查语义关系与正文栏宽可读性。仅仅“属于同一问”或“都和同一模型有关”不构成合并理由。机理示意、数据关系、结果验证、约束诊断和 KPI 汇总是不同阅读任务，原则上应分别放到对应论述位置。`(a)(b)` 只是标签，不是允许或禁止的判据。所有热力图类连续色条的外轮廓和 spine 均被公共模板强制隐藏，右侧渐变色条不画黑框。

模板选择遵循“数据列和类型兼容性 > visual kind > template family > 语义关键词”的确定性检索顺序。模板库无匹配时会阻断模型调用并返回 `blocked_by_template_catalog`，要求先扩充注册模板；模型阶段只能从已注册目录中选择。

## 扩展模板库

可执行模板现在由 [`templates/manifests/core.json`](templates/manifests/core.json) 的 `template_manifest/1.0.0` 声明驱动；启动时会校验 manifest 合同、模板 ID 是否重复，以及 `template_path` 是否安全且实际存在。新增模板时，先在 `contracts/template_manifest-1.0.0.schema.json` 的约束下添加 manifest 条目，再添加对应 Jinja2 渲染文件。每项必须声明数据列、数据类型、适用的论文任务、读者问题、统计前提、禁用情景和质量规则。

模板检索先执行列/类型兼容和 manifest 硬过滤（最少行数、关键列不得复用、调用方要求的必要事实），再按 kind、family 和语义排序。硬过滤失败会作为 `hard_filter_reasons` 回传；显式指定但不满足约束的模板不会静默回退为另一种图形。

PS-LAYER-001 要求所有网格线、横纵参考线和坐标辅助线先绘制并固定在数据层下方；柱、折线、散点、热图等核心图形后绘制且具有更高 `zorder`，禁止任何横竖辅助线穿过或分割核心图形。

## 两次介入与路由门禁

可视化 MCP 在两个时点介入：算法/结果冻结后做低成本预分析、模板优先检索和缺图检查；全文初步组装后再做正式重渲染、版面和灰度验收。图题、图前任务和图后结论始终由论文撰写 MCP 单一归属，可视化 MCP 只回填模板、编码、标注和脚本凭据。

`derived_evidence` 只有在冻结证据足以支持确定性派生、推导公式非空且不新增列/不重跑时才是 L2；需要新列、新运行或新实验的是 L3 `new_experiment`，必须回算法会议；改模型、评价口径或问题解释的是 L3 `model_change`，必须先回建模会议。L3 在可视化模型席位调用前阻断。

预检固定登记正文 30 页上限、全文 20 图建议上限及超额数，并要求正式渲染时完成灰度/黑白打印可读性检查。输出合同中的 `python_code_sha256` 与 `data_sha256` 共同构成可重渲染凭据。

## 启动

```powershell
.\run_mcp_server.cmd
```

配置唯一来源为 `../AI大模型配置中心/config/model_registry.json` 与配置中心 `.env`。开发测试可使用：

```powershell
$env:PYTHONPATH = "$PWD\src;$PWD\..\PaperSpec\src;$PWD\..\可视化审美研究\studio\src"
C:\Users\zhuka\AppData\Local\Programs\Python\Python314\python.exe -m pytest
```

MCP 不修改 LaTeX、BibTeX 或论文 PDF。`update_visual_request_fields` 默认写入新 JSON；只有调用方显式传入与源文件相同的输出路径时才会原位更新。

## MVP 复现

下面的命令使用 mock 席位执行完整的确定性链路，不产生外部模型费用，并渲染 5 张示例图的 PDF/PNG/SVG：

```powershell
$env:PYTHONPATH = "$PWD\src;$PWD\..\PaperSpec\src;$PWD\..\可视化审美研究\studio\src"
C:\Users\zhuka\AppData\Local\Programs\Python\Python314\python.exe .\examples\run_mvp_demo.py
```

只有显式增加 `--real-models` 才会调用配置中心登记的三个真实席位。`--no-render` 只生成源码与设计输出，不执行绘图脚本。

## MCP 工具

| 工具 | 责任 |
|---|---|
| `health_check` | 检查单模型配置、Studio、模板与配色 |
| `create_visual_design_run` | 创建带 UTC 时间戳的运行目录 |
| `preflight_visual_design_inputs` | 在模型调用前校验 21 字段请求、数据和映射 |
| `analyze_data_file` | 分析 CSV/TSV 表头、类型、缺失和哈希 |
| `build_visual_design_packet` | 构造冻结的会议输入包 |
| `run_visual_design_meeting` | 单次模型调用完成设计与模板确认，随后执行本地确定性质量门禁 |
| `build_paper_visual_inventory` | 读取完整 LaTeX 论文、剥离既有 figure/TikZ 设计并建立冻结数据清单 |
| `run_paper_visualization_pipeline` | 按问题分批执行 AI 全文语义规划，随后本地合并去重、批量生成、确定性排版、渲染和交付判定 |
| `execute_saved_paper_visual_plan` | 对已保存的全文规划重新执行证据门禁、代码生成与渲染，不追加模型调用 |
| `render_and_inspect_visual_design` | 不调用 AI，批量渲染设计输出并生成生产清单和人工微调队列 |
| `check_request_fulfillment` | 检查必需标注、参考线等语义要求是否真正进入编码结构 |
| `validate_visual_design_output` | 校验 `visual_design_output/1.0.0` |
| `detect_missing_figures` | 依据标注语料检测读者障碍对应的缺图 |
| `generate_principle_figure_prompt` | 为 B 类机制/流程/概念图生成受证据约束的提示词 |
| `check_code_quality` | 执行填充、轴线层级、中文字体和读者层静态检查 |
| `list_available_templates` | 列出 59 个已注册模板与 Studio 渲染器，并返回目录选择策略 |
| `search_visual_templates` | 按请求语义及真实数据列检索、排序可执行模板；无匹配时明确要求扩库 |
| `list_available_palettes` | 列出 Studio 当前注册的配色（本次健康检查为 14 套） |
| `render_preview` | 生成可调 DPI/尺寸/背景的 PDF、PNG、SVG 预览 |
| `update_visual_request_fields` | 仅在门禁通过后回填设计字段，默认保留原包 |
