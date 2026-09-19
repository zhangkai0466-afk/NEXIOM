# 双阶段证据驱动可视化（1.6.0）

## 入口与产物

先调用 build_evidence_visual_inventory(data_files, context_files, output_dir)。
data_files 为明确选择的 CSV/TSV；context_files 为原题、挖掘结论、方案说明、
实验与验证记录的 MD/TXT/JSON。PDF/DOCX 需先提取文本。输入错误逐项报告，
不会声称读取了未支持格式。所有源文件登记哈希，变化后须重建快照。

再调用 run_evidence_visual_pipeline(inventory_path, output_dir, stage="exploration")。
不要求章节包和 LaTeX。完整名称库及执行模板参与规划，七类证据角色逐项审查：
数据认识、关系、处理、比较、验证、稳健性、决策。每张候选记录读者问题、
列绑定、两个备选图形、选图理由、证据缺口、待核验观察及叙事影响。
前期图数量不设正文上限；不是把每个图形类型强制绘制一次。

论文论述确定后调用同一工具，stage="refinement"，提供 section_context 和
previous_plan_path。候选以稳定ID识别复用关系，保留未再选中清单，
区分正文、附录和探索记录。正文超过20张返回待筛选信号，不偷偷删图凑数。
两阶段都输出同一 evidence_visual_plan/1.0.0 清单及 PNG/PDF/SVG 和绘图代码。

## 状态与科学边界

review_required 表示设计/生产完成但结论与视觉效果待核验；partial 表示某批
请求、候选绑定或渲染失败，其他结果保留。不得等同于正式论文验收。
样例行不能证明相关性、效应大小或模型优劣。统计检验、归一化、训练、调参、
校准、置信区间等新证据应由建模/实验流程生成，不能由绘图模型猜造。
全部图的 claim_status 保持 requires_verification，交由本地Codex结合原始
结果及验证数据流审查。生成图不修改正文源文件。

请求沿用配置中心模型；每次最多10次传输尝试、单次超时60秒。
每3份证据独立成批，模型响应按输入、完整提示和模型指纹保存，续跑可复用。
输入过大明确报错，不静默截断资料。小型排版问题由本地/人工处理。

## 新执行模板

- radar_profile：同向、0到1尺度的少量多指标方案轮廓。必须显式设置
  normalized_to_unit_interval=true 与 higher_is_better=true；不自动归一化。
- bar_3d：行类别、列类别、数值；柱阵列留空隙，支持视角设置；缺失组合
  留空、不自动填零，重复组合需先说明聚合口径。
- surface_3d：x/y/z连续响应网格；拒绝缺失、重复、非有限数值。
  surface_style="wireframe" 可切换线框。颜色来自审美平台。

普通分组/双指标/前后对照柱状图实际柱宽为中心间距的84%，保留组内细缝。
直方图相邻箱、堆叠柱分段具有不同含义，不机械应用分组柱间距规则。

## 验证

tests/test_evidence_upgrade.py 验证导出、非法网格、雷达归一化前提、
两阶段ID、缓存、源文件变更及柱间留白。examples/evidence_upgrade_smoke.py
用选拔赛真实证据执行配置模型；examples/preview_new_templates.py 的数据
仅供模板展示，图内明确标注演示，不得作为论文数值结果。

保存的计划可用 `python examples/rerender_evidence_plan.py <计划JSON路径>` 在不请求模型的情况下重新渲染，检查源数据哈希并生成 `gallery.html`。正文小型排版修订后可使用此入口。

当前60秒设置属于传输层超时；持续返回数据的流式响应并不等同于严格60秒墙钟终止。不能以该配置宣称硬截止已通过验收。
