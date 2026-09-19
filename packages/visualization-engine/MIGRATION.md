# NEXIOM 原生可视化引擎

本目录把原 AI 可视化设计 MCP 1.7.1 的绘图实现、模板、图形知识、配色和真实图库迁入 NEXIOM 自有代码。NEXIOM 通过原生动态函数直接调用本地 JSON worker，运行时不启动 MCP 服务、不使用 MCP SDK，不需要原 D 盘工作区、PaperSpec 或原配置中心。

- `engine/src/nexiom_visualization/`：研究、证据分析、选图、生成、质量检查等业务实现。
- `engine/templates/`、`engine/contracts/`、`engine/corpus/`：62 个可执行模板、合同与 308 条图形索引。
- `studio/`：内置配色与确定性科研绘图实现，17 套配色。
- `references/`：32 张原始科研参考截图。
- `previews/`：790 组 PNG/SVG 预览，包含不同配色和参数变体。
- `catalog.json`：给 NEXIOM 图库使用的统一索引，所有资源位置相对本目录。
- `manifest.json`：来源版本、导入时间、文件 SHA-256 和导入时的适配记录。
- `native.py`、`native_registry.py`、`native-tools.json`：NEXIOM 原生 JSON 调用入口、参数验证和 36 个函数定义。
- `native_functions.py`：真实参考图读取，以及直接消费当前项目数据的单图渲染入口。
- `adapter.py`、`boot.py`：独立 Responses 模型调用、只读范围、项目内读写及渲染验证。

原来的 `paperspec_core` 仅为旧传输提供帮助函数。现在模型请求完全由 NEXIOM Responses 适配负责，不保留该依赖。原配置中心的 registry、`.env` 和密钥没有导入。`PS-*` 标识保留为已有绘图质量规则编号。`engine/UPSTREAM_README.md` 与 `engine/docs/` 是导入版本的历史说明，若与本文件冲突，以 NEXIOM 入口为准。

应用将一份 JSON 写入 `native.py` 的标准输入：`{operation,name,arguments,projectRoot,mode,network,provider,runsDir}`。`operation` 是 `check`、`list` 或 `call`；`mode` 是 `plan` 或 `execute`。凭据仅经此私有输入管道传入，不写命令行或图库文件。模型 provider 使用 NEXIOM 独立配置 `{id,name,endpoint,model,auth,apiKey}`，支持 `auth:none`。运行产物默认位于项目 `outputs/visual-design`，`runsDir` 只能指定当前项目的其他子目录。worker 内部以 `NEXIOM_VISUAL_*` 变量传递执行上下文，应用不必设置它们。

入口：`python -I -B -X utf8 -u packages/visualization-engine/native.py`，一次进程处理一次原生函数调用。依赖检查可直接追加 `--check`，静态函数清单可用 `--list`；依赖见 `requirements.txt`。Plan 仅提供 18 个只读函数，Execute 提供全部 36 个函数。会写报告的 `visual_stage_report` 只在 Execute 提供。网络关闭时模型请求及其子进程被拒绝；参考图读取和确定性单图渲染无需联网。

`get_visual_reference` 返回图库真实图像及元数据，图像压缩为最长边 1600 像素的 JPEG，仅作为外观参考。`render_visual_template` 对明确给出的 CSV/TSV 列映射和模板合同进行验证，然后生成 PDF、PNG、SVG；不要求构造旧会议请求，也不使用示例数据冒充项目结果。

已有绘图 Python 代码在执行前必须与当前安装模板重新生成的源码一致；自定义改图应编辑本目录的模板后重新生成。文件保护用于约束本地函数读写及渲染子进程，不替代操作系统沙箱。

后续直接在 NEXIOM 内修改模板、配色和参考资料，再运行 `python -B -X utf8 packages/visualization-engine/export_catalog.py` 重建图库索引。导入脚本 `scripts/import-visual-design.mjs` 只用于显式重新导入上游，不应加入常规构建；它会覆盖上游业务文件，但独立适配文件不被覆盖。

验证：`python -I -X utf8 packages/visualization-engine/tests/test_bundle.py`。测试使用本地数据及本地 HTTP Responses 服务，无外部模型费用。

上游未提供 LICENSE 文件。保留已有 OriginLab 与用户参考截图来源记录，不把仅登记图名的条目描述为可执行模板，也不把模板可运行描述为已复现参考截图中的所有统计细节。
