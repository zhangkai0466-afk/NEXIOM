# 1.7.1 赛前冻结使用说明

本版仅升级两层工作流和验收，不扩大模板后端。已实现不等于第三方中转站永不失败；不得以渲染成功替代科学验收。

## 第一层：研究可视化候选池

输入题意解读、数据挖掘、已落地完整建模求解与答案。先发现资料和分页研究图形卡，再执行可信计算。按研究问题生成小证据包，不把全文或整个名词库放入一次绘图请求。

先调用 discover_visual_research_project，随后 search_visual_research_sources / read_visual_research_source 与 get_visual_research_cards，按单元 run_visual_research_unit → execute_visual_research_tasks → prepare_researched_visual_inventory。

每个就绪清单调用 run_visual_stage_unit，stage=exploration，unit_id使用稳定短名，research_question明确独立论证问题。每次1至2张是小请求容量，不是整层上限。继续处理分布、关系、预处理、比较、验证、稳健性和决策等适用问题，累计可20、30张或更多。不适用也记录理由，不按类型凑数。

第一层不需要章节包。候选的reader_question、selection_reason、verification_needed和证据绑定用于人工遴选；图像本身不证明叙事假说。反例和不确定性也保留。不能依据现有汇总均值伪造原始分布。需要训练或额外实验时由本地Codex核验范围、成本与验证数据流，绘图模板不偷偷训练。

## 第二层：正文可视化设计

stage=refinement，section_context提供论文框架/相关章节和该单元的插图需要。previous_plan_path可空；第一层不是强制依赖。可选择第一层单元清单用于参考，但不覆盖它。

第二层独立检查问题重述背景、本文工作、数据处理、各问建模求解与检验。背景对象示意不以数值图或算法流程冒充。目标正文15至20张，超过20需遴选，实际已渲染正文图少于15则报告coverage_review_required，查遗漏或说明证据/实现缺口，不伪造素材凑数。此标识是待办提示，不会自动无限调用模型补图。

## 独立目录与恢复

output_root/exploration/units/unit_id 保存第一层代码、图片、清单、模型检查点。
output_root/refinement/units/unit_id 保存第二层结果。每层 stage_report.json 由 visual_stage_report 汇总。

每次只运行一个单元，避免大工具调用长时间等待。成功模型响应已有检查点可复用；同层同unit_id绑定输入变化会拒绝覆盖，改用新unit_id。若实验数据改变，重建证据快照并用新单元。不要并发执行同一unit_id。故障后先查单元清单与检查点，再重跑失败单元；不要盲目重跑整层。

模型每次实际请求上限60秒，每个小批次最多10次尝试；多个批次总时间不等于60秒。超时停止本地请求不保证服务商不计费。绘图子进程另有180秒上限。小标签/图例问题交人工调整，不触发AI返修循环。

## 使用前检查

重新连接/重启本地可视化MCP，health_check应显示1.7.1，工具列表应有run_visual_stage_unit和visual_stage_report。核验配置模型与配色平台可用，不修改密钥或模型分组。旧进程不会自动热更新。

先以一个小研究单元核验真实模型路由，再逐单元扩大。测试通过不代表正式题目全流程已运行，更不代表所有参考样式已有模板。原图和新图都须按正式版面人工查看；正文结论必须经证据核验。

## 本轮验证记录

2026-09-09：89项回归测试通过，4条Seaborn底层接口弃用预警。新增两层隔离、输入变化拒绝覆盖、成功响应缓存、31候选不截断和未完成单元检查。新增入口另行通过模拟模型JSON→真实PNG/PDF/SVG导出→第二层数量不足报告的集成测试；未使用真实中转站推理，不发生本轮模型请求费用。

按正式启动脚本相同的src、PaperSpec和Studio路径核验：health_check version=1.7.1、status=ok、model_configured=true、studio_available=true；配置模型gpt-6-astra；两个新工具已注册。只用src直接导入会缺少Studio路径，应使用run_mcp_server.cmd，不另建简化启动命令。

本轮没有对真实竞赛题运行20—30张候选图生成，也没有承诺一键自动完成所有研究单元。分单元调用是降低长请求风险的设计，整层报告供调度者查漏与遴选。到此冻结本次升级，不再调整图型库或后端。
