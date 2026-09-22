# NEXIOM 图表设计与资源库

0.6.0 起，NEXIOM 直接拥有图表设计引擎、模板与图库。原 AI 可视化设计 MCP 1.7.1 是迁移来源；最终实现已拆除 MCP 服务、客户端连接与协议依赖，改由 NEXIOM 核心调度内部 Python 计算模块。图表设计首页提供可搜索的模板、参考图库、配色与图种索引。

## 已迁入的资源与能力

| 内容 | 本次导入 |
| --- | --- |
| 可执行模板 | 62 个，数据形状、字段、统计前提与禁用条件随模板保留 |
| 图种索引 | 308 项，其中 246 项仅供发现与参考，不能直接当作渲染模板 |
| 配色 | 17 套，保留真实 HEX 与语义说明 |
| 图库 | 32 张科研参考原图、790 组 Studio PNG/SVG 预览 |
| 内置能力 | 模板检索、数据分析、研究资料、证据检查、设计规划、代码生成、渲染与质量检查；另提供直接按模板生成图表与读取参考图的原生入口 |

图库是设计参考，不是用户当前项目的实验结果；预览集合中也保留了历史配色变体，不代表每种预览都有同名的可执行模板。选中模板、配色或参考图后，“开始设计”创建图表对话并填入草稿，由用户补充数据和任务后发送。

## 原生能力的执行方式

NEXIOM 根据当前图表任务向自身 Agent 注册原生函数。模型选择操作后，由应用核心校验并启动内部 Python 计算任务，以标准输入传递参数、接收结构化结果，再把生成的文件展示给用户。停止任务会终止对应计算进程。这里没有 MCP 服务注册、MCP 客户端连接或需要用户另行启动的外部服务。图库浏览则直接通过 NEXIOM 的资源接口读取本地索引和图片。

## 独立运行

- **不依赖 PaperSpec 安装或项目目录。** 原传输调用已由 NEXIOM Responses 适配替代；绘图质量规则保留在图表组件内，旧规则编号仅用于追溯。
- 不读取旧 AI 大模型配置中心、`.env`、个人 Codex 配置、其他项目的模型名单或登录信息。
- 原 Studio 绘图代码、色板与图库资源已随包迁入，不需要旧 Studio 服务或网页继续运行。
- 图表设计使用本次 NEXIOM 运行选中的模型供应商。内部设计规划使用 Responses API，凭据仅经标准输入传给本次内部计算任务，不存入目录索引或运行参数快照。
- 图表工具在开始建模、图表设计和论文写作维度按需启用，统一任务流程可读取或创建素材。关闭网络时不会从绘图引擎另行请求模型。
- 产物默认放在当前赛题项目的 `outputs/visual-design/`。工具路径受到项目范围检查，不能把绘图输出写进内置模板库或其他项目。

内置资源可直接浏览。生成图表需要独立安装的 Python 3.11+ 及科学绘图库；本次不把个人 Codex 的 Python 环境打包成 NEXIOM 依赖。首页显示实际组件检查结果。源码环境可执行：

```powershell
python -m pip install -r packages/visualization-engine/requirements.txt
npm run visual:check
```

便携版可在 `resources/app/` 下运行相同的 Python 命令。若有多个 Python，可通过 `NEXIOM_VISUAL_PYTHON` 指定已安装依赖的解释器绝对路径。图库浏览不要求配置 API Key；需要模型参与的设计任务使用 NEXIOM 设置里的模型连接。

## 后续修复与精进

以下目录是 NEXIOM 自己的工作副本，日常构建不会从旧项目重新覆盖它们。

| 位置 | 用途 |
| --- | --- |
| `packages/visualization-engine/native.py`、`adapter.py` | NEXIOM 内部计算入口、权限与 Responses 配置适配 |
| `packages/visualization-engine/engine/src/nexiom_visualization/` | 核心设计、检索、证据、生成与质量检查 |
| `packages/visualization-engine/engine/templates/manifests/` | 模板注册、字段要求和适用条件 |
| `packages/visualization-engine/engine/templates/` | Jinja 绘图源码模板 |
| `packages/visualization-engine/engine/corpus/` | 图种名称、参考图元数据和研究卡 |
| `packages/visualization-engine/studio/data/palettes.json` | 配色库 |
| `packages/visualization-engine/references/` | 参考原图 |
| `packages/visualization-engine/previews/` | 按配色组织的预览图库 |
| `packages/visualization-engine/catalog.json` | 供 NEXIOM 首页读取的目录索引 |

修改模板、色板或图库元数据后运行 `npm run visual:catalog` 重建索引，再运行 `npm run build` 或 `npm run package:win`。不需要原目录存在，也不需要任何模型凭据。单独增加图片时，需要同步相应的参考元数据，确保图片有图名与适用条件。

`npm run visual:import -- "原 MCP 目录"` 用于明确决定从上游重新导入时使用，会更新导入副本；正常维护无需执行。源文件清单与哈希保存在 `manifest.json`，迁移适配另有说明。图片与上游实现按用户已有本地项目导入，来源记录保留，不将参考图片声明为 NEXIOM 自有版权。

## 验证范围

自动检查覆盖资源计数与文件存在、图库读取边界、图表维度原生函数注册、规划与执行隔离、网络开关、Responses 传输和最小绘图产物。界面检查覆盖搜索、资源切换、详情、图库翻页、创建草稿和深浅主题。

本次迁移不等于逐个复审 62 个模板的统计合理性，也不自动修复旧流程中的全部专业假设；后续可以在独立副本上继续调整。真实云模型设计质量取决于用户配置的供应商，本地验收不借用旧项目凭据发起付费调用。
