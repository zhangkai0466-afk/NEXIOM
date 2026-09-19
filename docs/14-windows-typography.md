# 0.3.5 Windows 字体与导航色彩

日期：2026-09-18。

## 诊断

0.3.4 与用户提供的 Codex 并排截图中，NEXIOM 中文有明显的红蓝边缘。实际字体由 Chromium CDP `CSS.getPlatformFontsForNode` 核实，为 Microsoft YaHei UI；未退回宋体。微软雅黑字体文件没有嵌入点阵表。Windows 显示缩放为 125%，页面 devicePixelRatio 为 1.25，页面 zoom 与 visualViewport.scale 均为 1，未发现页面低分辨率缩放。

同一 EXE、同一字体和缩放的 A/B 截图显示，关闭 LCD 子像素文字渲染后彩色边缘消失，转为灰度抗锯齿。另查到微软雅黑常用字重为 400/700，设置导航原来的 CSS 550 匹配了 Bold，造成小字偏重。

## 修正

- Windows 桌面宿主在 Chromium 初始化前设置 `disable-lcd-text`，使用灰度文字抗锯齿；不更改系统 ClearType、系统字体或应用 DPI，不调用关闭硬件加速的方法。
- 设置和会话导航统一为 14px / 20px；选中项使用 400，分类标题为 13px / 18px / 400。状态仍通过背景、图标和文字颜色区分。
- 浅色侧栏使用很轻的蓝灰渐变，普通文字为 `#343a3d`、次要文字 `#768084`、分类/占位文字 `#939c9f`。选中背景与 1px 分隔保留，标题栏同步顶部底色。
- 正文、代码与公式仍使用各自的字体系统，无字体图像化或预先放大再缩小处理。

Chromium 桌面的文字渲染开关不会自动影响普通浏览器开发预览；Windows 自己绘制的原生界面也有自己的文字渲染方式。灰度抗锯齿会改变小字的感知粗细，不能据此声称与 Codex 的私有字体及所有显示器完全一致。

## 验收证据

原始 A/B：`output/playwright/font-baseline.png` 与 `font-baseline-gray.png`。字体记录：`font-probe.json`。

0.3.5 发布 EXE 已完成 100%、125%、150% 三档应用设备缩放检查；每档覆盖浅色/暗色设置、正文、代码、公式与输入框，共 12 张截图。导航实际字体均为 MicrosoftYaHeiUI 常规体，字号 14px、行高 20px、字重 400；页面 zoom 为 1，无页面或导航横向溢出、无页面异常。检查记录为 `output/playwright/v035-typography-review.json`，截图为 `v035-*-settings.png` / `v035-*-content.png`。样例会话仅用于排版验收，不表示运行了真实模型实验。

三档检查的 GPU 合成都为 enabled。Electron 首窗创建后、GPU 信息初始化前会短暂报告 disabled_software，因此验收先等待 `getGPUInfo('complete')`；新旧版本对照记录在 `gpu-init-review.json`。产品未添加关闭 GPU 的设置。

另以全新隔离配置直接启动发布 EXE，无额外 Chromium/调试参数，完成原生窗口截图 `occlusion-035-foreground-print.png`。该检查确认窗口确实在前台、未被系统隐藏，启动日志包含 visible 与 ready-to-show；0.3.4 对照同样正常，记录见 `native-occlusion-review.json`。保留 Windows 原生缩放，未修改真实用户资料。`v035-typography-comparison.png` 为 125% 下旧版/新版导航的原始像素裁切对照，无插值放大。

原生截图的边界：另几次后台启动因 Windows 拒绝前台激活（`SetForegroundWindow=false`），PrintWindow 只得到背景，React 已挂载但文档处于 hidden；旧测试目录和全新目录都能出现。不能把此类截图当作正常前台显示结果，也不能将其归因于字体。本版未为此关闭窗口遮挡优化或 GPU。后续验收需同时记录实际前台窗口与页面可见性。
