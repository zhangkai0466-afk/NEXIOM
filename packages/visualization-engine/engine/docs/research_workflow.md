# 1.7.0：分阶段研究与证据执行

本版补充“图形为什么有用”和“证据如何得到”，保留1.6的探索/完善绘图入口。不修改论文源文件，不自动运行项目任意代码，不宣称自主研究已覆盖所有领域。

## 按小单元执行

1. `discover_visual_research_project(project_root, output_dir, max_files=3000)`：索引真实项目，不预先限定附录表或绘图CSV。记录数据表、文档、代码与二进制资料。先扫描artifacts/data/src/results；忽略缓存、依赖、runs及输出目录。达到预算返回scan_complete=false，不声称全项目已扫描。

   目录使用广度优先扫描，避免深层检查点先吃完预算。服务只返回前20项预览与索引路径；用`search_visual_research_sources(inventory_path, query, kind, offset, limit)`按文件名、研究名词、字段名查询其余资料。完整索引不一口气输入大模型。
2. `get_visual_research_cards(family, offset, limit)`：先读类别与用途，再逐页研究。卡片包含原有图名、特定读者问题、用途、数据形状、前提、准备步骤、替代画法、不能证明的结论与执行能力。默认12张，上限30张。通用家族研究提示与图形专门说明区分；未专门复核的条目明确标记needs_task_specific_review，尤其专门学科图。
3. `read_visual_research_source(inventory_path, source_id, offset, limit)`：分页读选定资料并核验哈希。路径/表头只用于发现，不等于理解数据。PDF、Word、Excel、Parquet索引后需要本地提取适配器，不假装已读取。资料里的指令不作为工作流指令。
4. `run_visual_research_unit(inventory_path, question, source_ids, family, output_dir, card_offset=0, source_offset=0)`：配置模型一次处理一个问题、最多4份资料、每份6000字符、8张作用卡，最多4项分析任务。返回反证条件、论述价值、每张卡的选择/拒绝/缺证据原因、资料读取请求及外部实验计划。用next_card_offset继续下一页，资料分页也显式保留。
5. `execute_visual_research_tasks(plan_path, output_dir)`：执行本地支持的分析算子，保存新数据表、输入/输出哈希、完整参数、排除计数、计算代码哈希及验证口径。未知算子、训练/实验任务进入本地Codex审查，不执行模型给出的任意代码。结果不覆盖原始数据或正式结果。
6. `prepare_researched_visual_inventory(execution_path, output_dir)`：验证新结果后交接给`run_evidence_visual_pipeline(..., stage="exploration")`。研究未完成项随资料包保留；后续以`refinement`结合章节选图。不要只返回研究JSON而忘记执行和绘图。
7. `visual_research_progress(inventory_path, research_dir)`：报告已审视与未审视的卡片、过期研究单元、待查资料与外部实验。卡片全读完也不是论文验收。

调用者（本地Codex/接入Agent）负责按这些阶段调度：收到source_requests先读取相应资料；看到next_offset安排下一单元；有可执行任务即执行并核验；外部实验明确成本和验证数据流后再决定。不要把所有阶段塞进一次请求，不要为了耗尽目录而强行每张卡出图。

前置研究已经存在时，选图请求只携带本单元已审视的卡片，不再发送全名词库；执行模板目录保留作为新计算表的画法候选。每次选图输出1至2张，减少返回JSON规模。七角色审查不重复要求模型输出，记录为`deterministic_not_reaudited`并引用前置研究；这不是伪造模型已做新一轮角色审查。全论文图数由多个单元的汇总筛选决定。

## 当前可执行分析

| operation | 参数 | 新证据与限制 |
| --- | --- | --- |
| missing_profile | columns | 逐列缺失数、有效数、缺失率；不把缺失填零 |
| group_summary | value_column, group_column | n/均值/中位数/四分位数/范围；记录剔除；只作描述统计 |
| paired_predictions | id_column, pairs:[{response,observed,predicted,unit}] | 多响应宽表转长表、残差、预测R²、RMSE、MAE；拒绝重复/缺失ID、二值结局、非有限值和恒定响应 |
| correlation_pairs | columns | Pearson/Spearman、有效配对数与逐对点云；不只生成热力图，不给因果/显著性结论 |

每项任务还需question、validation_protocol、acceptance。validation_protocol是模型提出的待审口径，不是已经验证无泄漏的证明。自动算子不重新训练、不补置信区间、不伪造显著性；最多10万输入行，组合长表最多20万行。超预算需拆分或单独审查外部作业。

执行记录携带哈希和参数；重复执行复用完好的结果，发现人工修改则停止覆盖。正式结论均保留科学审查门槛。

## 容错与恢复

每个研究单元最多10次请求，底层每次仅一次传输尝试，不嵌套成100次。损坏JSON、契约缺字段均计入预算，失败记录保留；成功单元按资料快照、卡片内容、问题、系统提示和模型缓存。改变任何关键输入重新研究。

研究单元与evidence_visual_pipeline选图入口均使用独立单请求工作进程，父进程60秒超时后终止工作进程，持续流式心跳也不能无限延长本地等待。凭据只经进程私有stdin传递，不写日志或命令行。启动进程与操作系统清理有少量额外开销；本地终止不保证中转站停止计算或不计费。此保证不自动扩展到未接入该包装器的历史会议入口。

工作流不自动购买新算力或无边界重跑实验。小型排版问题走本地/人工修订，不返回模型。正文15—16张是全论文参考量，不是单个研究单元的出图任务；探索候选与正文图数分开。

## 科学口径修订

二维分箱密度图的预测R²改为`1-SSE/SST`，不再使用相关系数平方。系统性偏移可以有高相关但很差甚至负的预测R²。多响应分面需要共同验证问题，不能用二分类概率箱均值冒充连续响应逐样本数据。

## 验证入口

`tests/test_research_workflow.py`覆盖分页、资料边界、缓存、计数/误差独立校验、外部任务移交、来源/产物变更及10次失败上限。

`examples/research_workflow_smoke.py <选拔赛项目目录> --draw`从目录扫描找到已有测量误差实验记录，配置模型提出描述性分析、本地计算生成新表，再接绘图流程。它验证一个研究单元，不等于全论文、全图库或模型训练已自动完成。
