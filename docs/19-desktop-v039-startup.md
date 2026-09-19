# NEXIOM 0.3.9：启动白屏修复

日期：2026-09-19。

## 问题与修复

0.3.8 的原生窗口在 Chromium 完成第一帧前立即显示。即使 BrowserWindow、
HTML 和动画都配置黑色背景，Windows 仍可能先显示浅色原生空窗。

窗口改为透明预热：首次绘制通知到达后，先激活窗口，等待 120 ms 让 Windows
合成画面，再恢复不透明。保留 React 挂载后的 600 ms 兜底和创建窗口后的
1500 ms 显示期限，任一通道触发都进入同一个幂等显现流程，避免旧版仅等待
ready-to-show 时永久隐藏的问题。关闭窗口会清除计时器。

动画通过受信任的 IPC 等待原生窗口显现，随后才开始绘制和退出计时。HTML
从 head 阶段固定启动背景为黑色；结束后移除启动标记并恢复用户主题。
错误恢复路径也能显示窗口。

## 验证

- TypeScript、Electron host 和生产前端构建通过。
- Win32 屏幕采样复现了旧版白色空窗；0.3.9 普通 EXE 启动未使用调试端口，
  首张可见窗口截图为黑色，直到动画淡出前的采样中未出现白色空窗。
- Electron 实测动画结束后恢复浅色主题，设置按钮可用；刷新和减少动态效果正常。
- QA 专用入口屏蔽 ready-to-show 后，renderer-ready-fallback 仍能显现窗口；
  同时屏蔽 renderer-ready 后，show-timeout 仍能显现并完成动画。
- 普通启动证据保存在 output/startup-animation/packaged-final，故障模拟只存在于
  output/startup-animation/no-first-paint.cjs，不包含在发行包中。

## 使用

桌面快捷方式已更新至 release/NEXIOM-0.3.9-win-x64/NEXIOM.exe，旧发行目录保留。
