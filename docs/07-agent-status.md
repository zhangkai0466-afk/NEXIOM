# 0.2 Agent 实现状态

日期：2026-09-18。

## 本次交付

NEXIOM 现为 Electron + React 桌面 Agent。桌面主进程管理窗口、系统文件选择与密钥加密；独立 Core 进程管理 SQLite、项目、会话、任务与运行时；Codex SDK 驱动官方原生引擎执行工具循环。

实际调用链：Renderer → 限定 preload IPC → Desktop Host → Core / AgentCoordinator → vendored Codex SDK → Codex 原生进程 → 项目中的命令与文件。模型推理、工具循环和引擎会话恢复直接使用上游实现。

开源来源：`openai/codex`，Apache-2.0，tag `rust-v0.154.0`，commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`。SDK 从源码编译；Rust 引擎使用同版本官方 Windows x64 二进制，未自行编译 Rust。公开仓库未提供完整 Codex Desktop 前端，当前界面是 NEXIOM 自己的实现。

## 模块与数据

- `packages/contracts`：跨进程命令、快照、模型设置与 Agent 工具项。
- `packages/core/agent.ts`：确认校验、去重、任务状态、超时和取消、引擎会话绑定、工具事件持久化。
- `packages/runtime`：运行时接口和 Codex 适配，集中处理凭证、模式、模型及网络配置。
- `vendor/codex-sdk`：固定版本上游源码、来源与许可证；本地修改仅涉及 Windows 隐藏窗口与进程树终止。
- `apps/desktop`：系统密钥保存、进程管理、窗口及 React 交互。
- `scripts/package-windows.mjs`：包含引擎、依赖许可的 Windows 便携目录。

SQLite schema v2 保留原有数据，增加 `settings`、`agent_runs`、`agent_requests`、`agent_threads`、`agent_items`。API Key 不进入数据库、快照或模型设置；桌面使用 Electron safeStorage，开发浏览器仅内存保存。引擎使用本机 Codex 的认证与会话存储，不把认证文件复制进发行目录。

## 执行边界

规划使用 `read-only`，执行使用 `workspace-write`。每次执行任务发送前确认项目内文件修改和程序运行。上游运行时禁用交互式权限升级，任务需要额外权限时应失败并说明。网络默认关闭，设置可开启执行命令网络；模型服务本身仍需要联网。此版本没有单独的容器计算环境，也没有自动安装 Python 或科学计算依赖。

运行状态为 running → succeeded / failed / cancelled；只有收到引擎完成事件才成功。停止会终止所拥有的引擎进程树，已发生的文件修改保留。重启将未完成任务标记中断，不擅自重跑。更换模型或供应商会建立新的引擎会话；原可见历史保留。

## 验证与限制

真实验收：从 Core 发起执行，Agent 创建标准库 Python 最小二乘程序，运行并写出 JSON；外部检查确认斜率 2、截距 1、RMSE 0。自动测试覆盖原有核心行为以及确认、去重、续接、错误、取消和密钥不入库。

本次验证结果：12 项自动测试、类型检查和生产构建通过。Playwright 检查了真实结果文件预览、只读后续任务，以及 1440px 桌面和 390px 窄屏；窄屏无横向溢出。打包 EXE 验证了内置引擎版本、项目重启恢复、执行确认取消不产生运行、系统密钥加密保存与重启加载，无页面异常。停止实测使用便携版内核启动真实 Python 等待任务，取消后确认所拥有的 8 个进程全部退出。

本地连接检测只验证引擎和凭证；它不保证远程服务可用。已实测本机 Codex 配置，未实测所有自定义 Responses API 服务。Agent 可用用户环境中的 Python 计算，但还没有独立 Experiment、Artifact、Evidence 的完整版本与血缘管理。

后续优先顺序：稳定实际竞赛附件处理 → 可复现实验与产物登记 → 证据关联和论文导出 → 打包更新、签名及更多运行时。原设计中的全部 P0/P1 门槛仍需逐项验收，不能用一个可运行演示代替。
