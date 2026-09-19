# NEXIOM 目录清理清单

> 生成时间：2026-09-19。本清单由分析得出，尚未删除任何文件。全部清理约可回收 **33.5 GB**。
> 所有路径均相对 `D:\NEXIOM`。完整的目录名列表在文末附录。

## 总览

| 目标 | 数量 | 大小 | 说明 |
|---|---:|---:|---|
| release/ 旧构建 | 41 个目录 | ~32.4 GB | Electron 打包产物，每次打包一份，旧的从不清理 |
| .local/ 测试残留 | 174 个目录 | ~770 MB | Playwright 测试证据（截图、录屏、trace、应用副本） |
| output/ 测试残留（可选） | 6 个目录 | ~307 MB | 资源检查 / 动画 / Playwright 的产物 |
| 垃圾文件夹 | 3 个 | ~1 MB | 路径 bug：环境变量未展开、`null` 拼接进路径 |

## 1. release/ —— 旧构建（保留最新 v0.6.13）

42 个完整 Electron 打包产物，每个约 0.75~0.90 GB。保留 `NEXIOM-0.6.13-win-x64`，删除其余 41 个，约回收 **32.4 GB**。完整名单见附录 A。

## 2. .local/ —— 测试残留（保留 3 个工具目录）

177 个子目录里绝大多数是 Playwright 测试证据。保留 `browser`、`font-tools`、`font-assets`，删除其余 174 个，约回收 **770 MB**。完整名单见附录 B。

## 3. output/ —— 测试残留（可选，建议先抽查再删）

- `desktop-resource-check` —— 235 MB（占大头，像是桌面资源检查的截图产物）
- `playwright` —— 59 MB
- `startup-animation` —— 12 MB
- `independence-qa`、`startup-theme-tray`、`visualization-native-check` —— 共 <1 MB

## 4. 垃圾文件夹 —— 路径 bug 产物（可直接删）

- `%SystemDrive%\` —— 环境变量没展开，某程序把 `%SystemDrive%\ProgramData\...` 字面量写进了项目目录
- `null\` —— JS 路径拼接 bug，写出了 `null\AppData\...`
- `NVIDIA Corporation\` —— NVIDIA 驱动日志（umdlogs）被写到了错误的工作目录；删除无害，驱动会在正确位置重建

## 一键清理脚本

在 `D:\NEXIOM` 下打开 PowerShell。先跑演练模式（只打印不删除）：

```powershell
$keep = @('NEXIOM-0.6.13-win-x64')
Get-ChildItem release -Directory | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force -WhatIf
Get-ChildItem .local -Directory | Where-Object { @('browser','font-tools','font-assets') -notcontains $_.Name } | Remove-Item -Recurse -Force -WhatIf
Remove-Item '%SystemDrive%','null','NVIDIA Corporation' -Recurse -Force -WhatIf
```

确认清单无误后，把每行的 `-WhatIf` 去掉再跑一遍，即完成清理（`output/` 默认不在脚本内，抽查后再决定）。个别想保留的目录，往保留名单数组里加名字即可。

## 预防建议

1. 打包脚本每次构建前清掉 `release/` 里的旧目录（或只保留最近 N 个版本）
2. Playwright 固定 `outputDir` 并在测试启动前清空；trace 用 `retain-on-failure` 只留失败用例
3. 排查写路径的代码：`%SystemDrive%` 说明有地方把环境变量当字面量用；`null` 说明有 `path.join(..., undefined/null)` 的调用


---

## 附录 A：release/ 待删目录（保留 v0.6.13）

- `NEXIOM-0.2.0-win-x64`
- `NEXIOM-0.3.0-win-x64`
- `NEXIOM-0.3.1-win-x64`
- `NEXIOM-0.3.10-win-x64`
- `NEXIOM-0.3.11-win-x64`
- `NEXIOM-0.3.12-win-x64`
- `NEXIOM-0.3.13-win-x64`
- `NEXIOM-0.3.14-win-x64`
- `NEXIOM-0.3.15-win-x64`
- `NEXIOM-0.3.16-win-x64`
- `NEXIOM-0.3.17-win-x64`
- `NEXIOM-0.3.18-win-x64`
- `NEXIOM-0.3.19-win-x64`
- `NEXIOM-0.3.2-win-x64`
- `NEXIOM-0.3.20-win-x64`
- `NEXIOM-0.3.3-win-x64`
- `NEXIOM-0.3.4-win-x64`
- `NEXIOM-0.3.5-win-x64`
- `NEXIOM-0.3.6-win-x64`
- `NEXIOM-0.3.7-win-x64`
- `NEXIOM-0.3.8-win-x64`
- `NEXIOM-0.3.9-win-x64`
- `NEXIOM-0.4.0-win-x64`
- `NEXIOM-0.4.1-win-x64`
- `NEXIOM-0.4.2-win-x64`
- `NEXIOM-0.5.0-win-x64`
- `NEXIOM-0.5.2-win-x64`
- `NEXIOM-0.6.0-win-x64`
- `NEXIOM-0.6.1-win-x64`
- `NEXIOM-0.6.10-win-x64`
- `NEXIOM-0.6.11-win-x64`
- `NEXIOM-0.6.12-win-x64`
- `NEXIOM-0.6.2-win-x64`
- `NEXIOM-0.6.3-win-x64`
- `NEXIOM-0.6.4-win-x64`
- `NEXIOM-0.6.5-win-x64`
- `NEXIOM-0.6.6-win-x64`
- `NEXIOM-0.6.7-win-x64`
- `NEXIOM-0.6.8-win-x64`
- `NEXIOM-0.6.9-sidebar-color-win-x64`
- `NEXIOM-0.6.9-win-x64`

## 附录 B：.local/ 待删目录（保留 browser、font-tools、font-assets）

- `app-server-cancel-1789669153425`
- `app-server-smoke-1789668903662`
- `app-server-smoke-1789670125961`
- `blank-project-ui-0400`
- `browser-067`
- `corner-1789735057814`
- `corner-1789735135998`
- `desktop-v03-verification-1789670265396`
- `desktop-v03-verification-1789670343565`
- `desktop-v031-check-1789703727450`
- `desktop-v031-check-1789703754885`
- `desktop-v031-check-1789703785105`
- `desktop-v031-check-1789705587672`
- `dimension-chat-ui`
- `dimension-desktop-e46TzJ`
- `dimension-desktop-yEI3WK`
- `electron-verification`
- `electron-verification-1789664969930`
- `font-probe-1789732803617`
- `font-probe-1789732889187`
- `heading-font-1789736266508`
- `heading-font-1789736295304`
- `independence-browser-qa`
- `independence-final-f9MegV`
- `independence-qa-QH6v4v`
- `independent-release-8xJU9r`
- `live-agent-1789666447155`
- `live-cancel-1789667425109`
- `menu-review-1789734615115`
- `menu-review-1789734674736`
- `menu-review-1789734690677`
- `menu-review-1789734765199`
- `menu-review-1789734861754`
- `navigation-acceptance-0319`
- `navigation-desktop-nevrev`
- `packaged-isolation-Zzmp2s`
- `packaged-verification-1789667263538`
- `project-collapse-1789799395302`
- `project-collapse-release-1789799488919`
- `project-folder-flow-1CVwRh`
- `project-folder-flow-5AqgHw`
- `project-folder-flow-EfcaQf`
- `project-folder-flow-J9H7wi`
- `project-folder-flow-JLw52F`
- `project-folder-flow-Kp30UO`
- `project-folder-flow-UAUXSV`
- `project-folder-flow-ZvbC94`
- `project-folder-flow-lZ9dO8`
- `project-remove-067-llDqsQ`
- `provider-ui-20260919-1400`
- `root-provider-qa`
- `sdk-migration-1789670107060`
- `semantic-workspace-qa`
- `settings-heading-1-1789736743747`
- `settings-heading-1-1789736782509`
- `settings-heading-1.25-1789736787787`
- `settings-heading-1.5-1789736793306`
- `settings-page-check`
- `sidebar-resize-1789797903741`
- `sidebar-resize-1789798081452`
- `sidebar-resize-1789798241852`
- `sidebar-resize-1789798269161`
- `sidebar-resize-1789798361812`
- `sidebar-resize-1789798436972`
- `sidebar-resize-1789798493733`
- `sidebar-resize-1789798850080`
- `sidebar-resize-1789798891146`
- `sidebar-resize-1789799072049`
- `sidebar-resize-1789799098311`
- `sidebar-resize-1789799127494`
- `sidebar-resize-1789799191686`
- `sidebar-resize-1789799221121`
- `sidebar-resize-1789799249509`
- `sidebar-resize-1789799337907`
- `sidebar-resize-1789799414399`
- `sidebar-resize-1789799484812`
- `sidebar-v033-1789722151933`
- `sidebar-v034-1789732527988`
- `startup-animation-qa`
- `startup-flash-after-commit`
- `startup-flash-after-compositor`
- `startup-flash-after-source`
- `startup-flash-before`
- `startup-flash-no-paint`
- `startup-flash-no-signals`
- `startup-flash-packaged-dark-0310`
- `startup-flash-packaged-dark-printwindow-0312`
- `startup-flash-packaged-dark-sequential-0310`
- `startup-flash-packaged-dark-sequential-0311`
- `startup-flash-packaged-dark-sequential-0312`
- `startup-flash-packaged-final`
- `startup-flash-packaged-light-0310`
- `startup-flash-packaged-light-printwindow-0312`
- `startup-flash-packaged-light-sequential-0310`
- `startup-flash-packaged-light-sequential-0311`
- `startup-flash-packaged-light-sequential-0312`
- `startup-flash-packaged-repeat`
- `startup-flash-playwright`
- `startup-flash-theme-dark-fixed`
- `startup-flash-theme-dark-source`
- `startup-flash-theme-light-fixed`
- `startup-flash-theme-light-source`
- `startup-flash-theme-system-fixed`
- `startup-flash-wordmark-400-dark-0314`
- `startup-flash-wordmark-400-light-0314`
- `startup-tip-after-1789795139062`
- `startup-tip-aligned-dark-100-1789796161345`
- `startup-tip-aligned-dark-125-1789796164889`
- `startup-tip-aligned-dark-150-1789796057007`
- `startup-tip-aligned-light-100-1789796154760`
- `startup-tip-aligned-light-125-1789796158112`
- `startup-tip-aligned-light-150-1789796053830`
- `startup-tip-before-1789794981222`
- `startup-tip-dark-100-1789795337041`
- `startup-tip-dark-125-1789795340088`
- `startup-tip-dark-150-1789795342996`
- `startup-tip-light-100-1789795304977`
- `startup-tip-light-100-1789795327899`
- `startup-tip-light-125-1789795330938`
- `startup-tip-light-150-1789795333942`
- `startup-tip-release-0313-dark-100-1789796688959`
- `startup-tip-release-0313-light-150-1789796685371`
- `startup-tip-release-dark-100-1789795453949`
- `startup-tip-release-light-150-1789795450350`
- `theme-tray-dark`
- `theme-tray-dead-core`
- `theme-tray-functional`
- `theme-tray-light`
- `theme-tray-mismatch`
- `theme-tray-switch`
- `thread-menu-desktop-0EDCNh`
- `thread-menu-desktop-1pTK8D`
- `thread-menu-desktop-1uFRvq`
- `thread-menu-desktop-BZm4Wz`
- `thread-menu-desktop-E1r6Pt`
- `thread-menu-desktop-KWou53`
- `thread-menu-desktop-LUFUCh`
- `thread-menu-desktop-U3jFzX`
- `thread-menu-desktop-aO921K`
- `thread-menu-desktop-kLFtlV`
- `thread-menu-desktop-ugJ2tl`
- `thread-menu-desktop-ukzC1F`
- `tray-final-0311`
- `tray-final-visible-0311`
- `tray-final-visible-0312`
- `typography-1-1789733180672`
- `typography-1-1789733276392`
- `typography-1-1789733472259`
- `typography-1-1789733568181`
- `typography-1-1789733581936`
- `typography-1.25-1789733292316`
- `typography-1.25-1789733584196`
- `typography-1.5-1789733586710`
- `typography-qa`
- `ui-remove-brain-check`
- `v0610-font-package-1789817169114`
- `v0610-font-package-1789817224389`
- `v0611-workspace-1789817720431`
- `v0611-workspace-1789817743447`
- `v0611-workspace-1789817806945`
- `v0613-frame-1789819840507`
- `verification`
- `visual-design-qa`
- `visual-native-packaged-qa`
- `welcome-page-1789803988636`
- `welcome-page-1789804184781`
- `welcome-page-1789804312069`
- `welcome-page-1789804389193`
- `welcome-page-1789804635715`
- `welcome-page-1789804804097`
- `welcome-page-1789805035250`
- `welcome-page-1789805323753`
- `welcome-page-1789806122122`
- `welcome-page-1789806228781`
