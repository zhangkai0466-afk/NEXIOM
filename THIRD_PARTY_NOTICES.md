# Third-party notices

Version 0.7.0 uses docx (MIT) for Word export, @xmldom/xmldom (MIT) for MathML parsing, image-size (MIT) for image dimensions, and unified / remark-parse (MIT) for Markdown document structure. KaTeX assets are included for offline PDF formulas. Installed production dependency notices and licenses are included in the portable release under licenses/npm/.

The native visualization module imports the owner's local AI 可视化设计 MCP 1.7.1 and the required Scientific Palette Studio rendering code, palettes and gallery into `packages/visualization-engine/`. Source attribution and file hashes are retained in that directory's manifest. NEXIOM removes the MCP protocol layer and replaces the old model-configuration and PaperSpec transport dependency with its own native computation interface and Responses adapter. The original local projects did not contain a LICENSE file; this local import does not assert an open-source license for them or ownership of reference images. Existing reference-source metadata is retained. Python plotting libraries are independently installed and are not copied from a personal Codex runtime.

NEXIOM includes OpenAI Codex open-source components from https://github.com/openai/codex under the Apache License 2.0.

- TypeScript SDK source: `rust-v0.154.0`, commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`, compiled from `vendor/codex-sdk/src`.
- Native Agent engine: official `@openai/codex` Windows x64 distribution, version `0.154.0`.
- LICENSE, NOTICE, provenance and local modifications: `vendor/codex-sdk/` in source; `licenses/codex-sdk/` in the portable distribution.
- NEXIOM's interface is its own implementation. No proprietary Codex Desktop frontend source or OpenAI branding is included.
- Version 0.3 uses the official native Codex app-server protocol for inference, tools, streaming, sessions and compaction. The retained TypeScript SDK supplies shared event types; SDK exec is no longer the runtime entry point.

The desktop runtime is Electron (MIT), with Chromium and third-party notices distributed in Electron's `LICENSE` and `LICENSES.chromium.html` files.

Settings headings include Noto Sans SC, Copyright 2014-2021 Adobe, under the SIL Open Font License 1.1 (Reserved Font Name: Source). The complete variable font is bundled locally as WOFF2, converted from the official Google Fonts distribution without subsetting or changes to outlines or weight axes. Source/license information is in `assets/fonts/noto-sans-sc/`; the portable distribution includes it under `licenses/fonts/noto-sans-sc/`.

Frontend libraries include React (MIT), Lucide (ISC), react-markdown and unified/remark/rehype (MIT), KaTeX (MIT), and Zod (MIT). The portable release retains installed production dependency license texts and package notices in `licenses/npm/` alongside the Codex and Electron notices.

Version 0.3 includes Thinking Orbs (MIT, https://github.com/Jakubantalik/thinking-orbs) for task-state canvas animation and Motion (MIT, https://github.com/motiondivision/motion) for disclosure transitions. Claude Code, Cursor, other design registries, and mathematical modeling research repositories were examined as references; their proprietary or restricted implementation code has not been copied into this application.
