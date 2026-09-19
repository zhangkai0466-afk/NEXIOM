# Project navigation and casual chat design QA

- Source visual truth (add entry): `C:\Users\zhuka\Pictures\Screenshots\屏幕截图 2026-09-19 210300.png` — 404 × 56 px
- Source visual truth (create project): `C:\Users\zhuka\Pictures\Screenshots\屏幕截图 2026-09-19 210315.png` — 934 × 532 px
- Source visual truth (project section): `C:\Users\zhuka\Pictures\Screenshots\屏幕截图 2026-09-19 210345.png` — 380 × 230 px
- Source visual truth (heading rendering): `C:\Users\zhuka\Pictures\Screenshots\屏幕截图 2026-09-19 231758.png` — 152 × 43 px
- Source visual truth (recent project card): `C:\Users\zhuka\AppData\Local\Temp\codex-clipboard-39080bed-456b-4146-b452-362a0a969966.png` — 451 × 177 px
- Implementation screenshot (welcome/navigation): `D:\NEXIOM\.local\navigation-welcome-qa.png`
- Implementation screenshot (create project): `D:\NEXIOM\.local\navigation-create-project-qa.png`
- Implementation screenshot (casual chat): `D:\NEXIOM\.local\navigation-casual-chat-qa.png`
- Focused side-by-side comparison: `D:\NEXIOM\.local\navigation-comparison-qa.png`
- Full-view comparison: `D:\NEXIOM\.local\navigation-full-comparison-qa.png`
- Implementation viewport: 1440 × 900 CSS px, device scale factor 1, light theme
- Implementation screenshot pixels: 1440 × 900 for each captured state
- Density normalization: source snippets and implementation crops were proportionally fitted into common comparison rows. No non-proportional scaling was applied.

## States compared

1. Welcome page with the library navigation visible and one recent project.
2. Create-project dialog before a source folder is chosen.
3. Project section expanded with project actions visible.
4. Casual chat selected with the standard conversation composer visible.

## Full-view comparison evidence

The full-view comparison verifies the revised information architecture: “添加” and “随便聊聊” appear above the project section; the project section remains visible while casual chat is active; the welcome page contains a compact recent-project card without a filesystem path; and casual chat replaces the welcome content with a real conversation surface.

## Focused region comparison evidence

The focused board compares all five supplied references against current implementation crops. The add entry uses the requested short label. The project dialog matches the reference hierarchy of title, name field, source-folder panel, and footer actions. The project section includes the disclosure, overflow action, add action, and folder rows. The recent heading and project name use the embedded variable Chinese UI font, while the path line and workspace count are absent.

## Required fidelity surfaces

- Fonts and typography: UI remains 14 px. The small recent-project heading and project names use the embedded NEXIOM UI variable font at real intermediate weights. Chromium `text-rendering` is `auto`, and the packaged Windows host no longer disables native LCD/ClearType text rendering.
- Spacing and layout rhythm: the sidebar follows the source ordering and compact vertical rhythm. The project dialog uses a wide rounded shell, 58 px name field, centered source selector, and separated footer.
- Colors and visual tokens: light-theme sidebar, white content surface, blue focus border, neutral modal backdrop, and existing NEXIOM theme tokens are preserved.
- Image quality and asset fidelity: existing NEXIOM logo assets remain native-resolution images. Interface icons use the product's established Lucide icon system; no screenshot or placeholder replaces interactive UI.
- Copy and content: “选择赛题工作文件夹” is replaced by “添加”. “随便聊聊” is a first-class navigation entry. The recent card displays only the project name, and no new explanatory microcopy was added.

## Findings

No actionable P0, P1, or P2 difference remains. Project names differ from the references because the capture uses the local QA workspace; this is state data, not design drift. The development capture reports only Electron's expected development-mode CSP warning, which is absent from the packaged build; no application console error was observed.

## Primary interactions tested

- Opened the create-project dialog from “添加”.
- Verified the dialog title, project-name field, source-folder state, and disabled create state.
- Selected the source-folder control and confirmed its visible state updates.
- Collapsed and re-expanded the project section.
- Opened the project overflow menu.
- Entered “随便聊聊” and confirmed its active navigation state, title, composer, and persistent conversation thread.
- Confirmed zero visible recent-project path elements and no page-level horizontal overflow.

## Comparison history

- Pass 1: the previous implementation used a long folder-selection label, opened the native picker immediately, showed a flat project list, displayed the full disk path on recent cards, and forced grayscale Windows text rendering.
- Pass 2: added the create-project dialog and two-step folder flow, rebuilt the project section controls, introduced casual chat, removed visible paths and counts, changed the small heading to the embedded variable font, and restored native Windows LCD text rendering.
- Pass 3: refined the modal source-folder disclosure and cancel action, then recaptured the welcome, dialog, and casual-chat states. The final side-by-side comparison found no remaining P0/P1/P2 issue.

## Verification

- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: 130 tests, 129 passed, 0 failed, 1 skipped because the current Windows environment does not permit creating a file symlink.
- Windows package: `NEXIOM 0.6.16`, with packaged navigation strings, dialog styles, and native text-rendering configuration verified.

## Follow-up polish

No P3 polish item is required for handoff.

final result: passed

---

# One-click update button design QA

- Source visual truth (NEXIOM account area): `C:\Users\zhuka\AppData\Local\Temp\codex-clipboard-4b1fa6a6-a59d-4bbe-95f7-922db470f847.png` — 310 × 103 px.
- Source visual truth (Codex update control): `C:\Users\zhuka\AppData\Local\Temp\codex-clipboard-a9a2e736-c8ed-4e29-bf3e-681944c3d7b1.png` — 408 × 66 px.
- Implementation screenshot: `D:\NEXIOM\.local\update-button-qa-final.png` — 1360 × 900 px.
- Full-view evidence: `D:\NEXIOM\.local\update-button-qa-final.png`.
- Focused side-by-side comparison: `D:\NEXIOM\.local\update-button-comparison-qa.png` — 900 × 310 px.
- Implementation viewport: 1360 × 900 physical px at Windows 125% display scale; Electron CSS control sizes were independently checked through UI Automation.
- Implementation control sizes: account avatar 30 × 30 CSS px and update button 34 × 34 CSS px; UI Automation reports 43 × 43 physical px for the update button at 125% scale.
- Density normalization: the focused comparison uses the supplied references at native pixels and an unscaled 312 × 91 physical-pixel crop from the implementation. Relative control proportions, rather than absolute cross-application pixels, are the fidelity target because the Codex and NEXIOM captures use different host scale and container sizes.
- State: dark theme, empty local QA workspace, update available control idle. A second pass invoked the control while the desktop shortcut already targeted 0.6.18 to verify the safe error state.

## Full-view comparison evidence

The packaged 0.6.18 Electron window preserves the existing NEXIOM layout and places the update control only in the account footer. It does not change the project navigation, welcome composition, content panel, or title bar. The control remains visible at the bottom of both sidebar layers because it is outside the sliding navigation layer.

## Focused region comparison evidence

The focused comparison combines both supplied references and the packaged implementation in one image. The account avatar, nickname and disclosure preserve the original NEXIOM treatment. The new control follows the Codex reference's separate circular blue button, white download glyph, compact gap, and vertical centering. The implementation uses the project's existing Lucide icon library rather than a screenshot, custom SVG or CSS drawing.

## Required fidelity surfaces

- Fonts and typography: the existing NEXIOM account label keeps its Segoe UI / Microsoft YaHei UI stack, size, weight and single-line truncation. The icon-only update control adds no competing label; its accessible name is “更新并重启 NEXIOM”.
- Spacing and layout rhythm: the update button is 34 px, the avatar is 30 px, the gap is 8 px, and both are centered in the existing 48 px account row. The source relationship of a slightly larger update circle beside the profile control is preserved.
- Colors and visual tokens: the sidebar and account styling are unchanged. The control uses a clear Codex-like blue (`#0879d1`), white glyph, brighter hover, darker pressed state and muted disabled state.
- Image quality and asset fidelity: no raster placeholder or generated asset is needed. The supplied NEXIOM avatar/logo assets remain unchanged, and the update glyph comes from the established interface icon library.
- Copy and content: normal state contains no new visible copy. Failure text is concise and specific; the verified same-version state reads “当前已经是桌面快捷方式指向的最新版本。”.

## Findings

No actionable P0, P1 or P2 mismatch remains. The source applications use different container widths and display scales, so exact absolute button pixels are intentionally not copied; the relative avatar-to-update-button ratio and control hierarchy match.

## Primary interactions tested

- Located the packaged control through Windows UI Automation by its accessible name and confirmed it is enabled when no task is running.
- Invoked the real packaged 0.6.18 control while the desktop shortcut also targeted 0.6.18.
- Confirmed the process stayed alive and the renderer exposed the expected inline “already latest” error instead of closing or relaunching.
- Verified the loading icon has a reduced-motion override and running tasks disable the control in renderer state.
- Verified shortcut target parsing, newer-version acceptance, same-version rejection, older-version rejection, malformed target rejection and unrelated release-root rejection in automated tests.

## Comparison history

- Pass 1: the packaged app was captured while minimized, producing unusable visual evidence; this was rejected rather than treated as a pass.
- Pass 2: the native window was restored and captured. The focused region showed the correct component but included the intentionally triggered same-version error.
- Pass 3: a fresh isolated profile was captured in idle state at the same 1360 × 900 window size. The combined focused comparison found no remaining P0/P1/P2 issue. The error-state interaction was then invoked separately and verified through accessibility output.

## Verification

- `npm run check`: passed.
- `npm test`: 133 tests, 132 passed, 0 failed, 1 skipped because the current Windows environment does not permit creating a file symlink.
- `npm run package:win`: passed and produced `D:\NEXIOM\release\NEXIOM-0.6.18-win-x64\NEXIOM.exe`.
- Desktop shortcut: updated to the 0.6.18 executable.
- Native packaged UI: captured and inspected; account/update controls were measured and exercised through Windows UI Automation.

## Follow-up polish

No P3 polish item is required for handoff.

final result: passed
