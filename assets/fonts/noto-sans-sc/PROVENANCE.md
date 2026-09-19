# Noto Sans SC variable font

- Upstream: https://github.com/google/fonts/tree/main/ofl/notosanssc
- Original file: `NotoSansSC[wght].ttf`, 17,772,300 bytes.
- Exact source Git blob: `fb0637bafbcd804fe32152370a1225990745b4bc`.
- Source SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`.
- License Git blob: `1c9f43281b8f216c5461fe9ac729afbade7724e4`; full OFL 1.1 text is included in OFL.txt.
- Downloaded 2026-09-18 from the official repository through the GitHub Git Blobs API; the source blob hash was verified.
- `NotoSansSC-VF.woff2` is a full-font format conversion using fontTools 4.62.1 and Brotli 1.2.0, without subsetting, outline edits, renaming, or weight instancing. The variable `wght` axis remains 100–900.
- Conversion: load the original with `TTFont(source, recalcTimestamp=False)`, set `font.flavor = "woff2"`, and save to `NotoSansSC-VF.woff2`.
- CSS uses the family alias `NEXIOM UI` and the bundled URL, with no system-local or network font lookup. Vite includes the WOFF2 file under `dist/assets` in the portable app.
