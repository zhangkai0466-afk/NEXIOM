# Token 活动保存与恢复

个人资料中的 Token 活动独立于项目内容。清缓存、删除对话、移除和重置项目均保留用量；更新应用沿用相同用户数据目录时也会保留。累计 Token 数覆盖所有已保存日期，热力图及缓存概览展示最近一年。

账户页提供三个操作：

- **导出活动备份**：下载 JSON，用于换机或留存到另一个磁盘。
- **导入备份**：按活动身份合并，不覆盖已有的更完整计数，重复导入不累加。
- **恢复本地历史**：核对 NEXIOM 私有引擎日志，补齐仍可追溯的旧用量；启动时也会自动执行。

备份包含日期、用量、缓存状态和用于去重的活动标识，不含消息正文、项目文件内容、API Key 或完整模型配置。日志及备份均已丢失的历史无法推算恢复。

## 持久化与计数

工作空间 schema 10 新增无项目外键的 `token_activity` 表。`agent_runs.activityId` 保存原始活动身份；分叉对话及便携项目迁移沿用该身份，不将复制的运行记录算作新消耗。

App Server 的 `thread/tokenUsage/updated` 上报累计计数，适配器减去恢复线程时的历史基线，得到本轮用量。每次更新即写入账本，任务取消或失败也保留此前已报告的消耗；未知基线或无报告仍记为未知，不记为零。

原生身份采用 `thread_id + turn_id`。恢复日志时优先读取 `token_usage_record.turn_token_usage` 的累计快照，旧格式使用 `token_count` 的线程累计差值；两种格式不相加，继承的分叉历史也不重复统计。一个附件批次可能包含多轮原生任务，账本按轮记录；旧运行摘要仅在原生日志不完整时用于统计，避免重复或减少已有用量。缓存输入已包含在输入中，总数为输入加输出。

恢复只读取当前 NEXIOM 数据目录中 `runtime/sessions`、`runtime/archived_sessions` 的普通日志，要求来源为 `nexiom`，跳过链接、过大或无法读取的文件。不会读取个人 Codex 目录。旧运行与原生轮次只有在工作目录、时间及可用线程绑定唯一匹配时才关联。

账本变更后自动原子写入 `workspace/usage/token-activity.json`，并保留上一份有效版本 `token-activity.previous.json`；启动时合并这两份与可选的 `token-activity.recovered.json`。这些文件不在缓存清理范围内。默认桌面目录为 `%APPDATA%/NEXIOM/workspace/usage`。同一磁盘上的自动备份不能替代异地备份；换机、切换数据目录或删除应用数据前，可使用导出功能留存。

## 验证

`tests/token-activity.test.mjs` 覆盖原生与旧格式恢复、分叉去重、备份损坏与事务回滚、未知与部分用量、链接边界；Agent 集成测试覆盖重置、删除、清缓存、便携项目迁移和重启后的持久化。`tests/token-usage.test.mjs` 验证累计数与年度窗口、缓存计数不重复。

官方 [Codex App Server 文档](https://developers.openai.com/codex/app-server/) 说明线程的持久化、读取、恢复与分叉能力。这里的日志格式和保存策略根据 NEXIOM 所用引擎的实际记录实现，不代表 Codex 桌面个人资料页内部统计系统的设计。
