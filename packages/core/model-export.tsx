import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableCell, TableRow, WidthType, HeadingLevel, type ParagraphChild } from "docx";
import { imageSize } from "image-size";
import { checkedFile } from "../filesystem/safe-files";
import { repairCjkStrong } from "../../apps/desktop/renderer/markdown-repair";
import { wordEquation } from "./docx-math";

type MdNode = { type: string; value?: string; children?: MdNode[]; depth?: number; url?: string };
type ExportImage = { data: Buffer; type: "png" | "jpg" | "gif" | "bmp"; width: number; height: number; uri: string };
function documentBlocks(nodes: MdNode[], images: Map<string, ExportImage>) {
function inline(nodes: MdNode[], style: { bold?: boolean; italics?: boolean } = {}): ParagraphChild[] {
  return nodes.flatMap((node): ParagraphChild[] => {
    if (node.type === "image") { const img = images.get(node.url ?? "")!; return [new ImageRun({ data: img.data, type: img.type, transformation: { width: img.width, height: img.height } })]; }
    if (node.type === "inlineMath") return [wordEquation(node.value ?? "")];
    if (node.type === "strong") return inline(node.children ?? [], { ...style, bold: true });
    if (node.type === "emphasis") return inline(node.children ?? [], { ...style, italics: true });
    if (node.type === "break") return [new TextRun({ break: 1 })];
    if (node.type === "link") return [...inline(node.children ?? [], style), new TextRun({ text: ` (${node.url ?? ""})`, ...style })];
    if (node.children) return inline(node.children, style);
    return [new TextRun({ text: node.value ?? "", ...style, ...(node.type === "inlineCode" || node.type === "inlineMath" ? { font: "Consolas" } : {}) })];
  });
}
function blocks(nodes: MdNode[]): (Paragraph | Table)[] {
  return nodes.flatMap((node): (Paragraph | Table)[] => {
    if (node.type === "heading") return [new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][Math.min(3, (node.depth ?? 1) - 1)], children: inline(node.children ?? []), keepNext: true })];
    if (node.type === "table") return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: (node.children ?? []).map((row, index) => new TableRow({ tableHeader: index === 0, children: (row.children ?? []).map(cell => new TableCell({ children: [new Paragraph({ children: inline(cell.children ?? [], { bold: index === 0 }) })], margins: { top: 120, bottom: 120, left: 120, right: 120 } })) })) })];
    if (node.type === "list") return (node.children ?? []).flatMap(item => (item.children ?? []).flatMap(child => child.type === "paragraph" ? [new Paragraph({ bullet: { level: 0 }, children: inline(child.children ?? []) })] : blocks([child])));
    if (node.type === "blockquote") return blocks(node.children ?? []);
    if (node.type === "math") return [new Paragraph({ children: [wordEquation(node.value ?? "")], alignment: "center" })];
    if (node.type === "code") return [new Paragraph({ keepLines: true, keepNext: true, spacing: { line: 260 }, children: (node.value ?? "").split("\n").flatMap((line, index) => [...(index ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line || " ", font: "Consolas", size: 20 })]) })];
    if (node.type === "paragraph") return [new Paragraph({ children: inline(node.children ?? []) })];
    if (node.children) return blocks(node.children);
    return [];
  });
}
return blocks(nodes);
}
export async function exportModelDocuments(root: string, relative: string) {
  const source = checkedFile(root, relative);
  const text = readFileSync(source, "utf8");
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("方案过大，无法导出。");
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(repairCjkStrong);
  const ast = processor.runSync(processor.parse(text), { value: text }) as MdNode;
  const images = new Map<string, ExportImage>();
  function collectImages(node: MdNode) {
    if (node.type === "image") {
      const url = node.url ?? "";
      if (/^(?:[a-z]+:|[\\/])/i.test(url)) throw new Error(`导出图片必须保存在项目中：${url}`);
      const target = checkedFile(root, path.join(path.dirname(relative), decodeURIComponent(url)));
      const data = readFileSync(target);
      if (data.length > 10 * 1024 * 1024) throw new Error("导出图片不能超过 10 MB。");
      const dimensions = imageSize(data);
      if (!["png", "jpg", "gif", "bmp"].includes(dimensions.type ?? "")) throw new Error(`请先将图片转成 PNG 或 JPEG 再导出：${url}`);
      const scale = Math.min(1, 620 / dimensions.width, 800 / dimensions.height);
      images.set(url, { data, type: dimensions.type as ExportImage["type"], width: dimensions.width * scale, height: dimensions.height * scale, uri: `data:image/${dimensions.type === "jpg" ? "jpeg" : dimensions.type};base64,${data.toString("base64")}` });
    }
    node.children?.forEach(collectImages);
  }
  collectImages(ast);
  const doc = new Document({
    creator: "NEXIOM", title: "建模方案",
    styles: {
      default: {
        document: { run: { font: "Microsoft YaHei", size: 22, color: "20252B" }, paragraph: { spacing: { after: 140, line: 320 } } },
        heading1: { run: { size: 34, bold: true, color: "111111" }, paragraph: { spacing: { before: 280, after: 180 } } },
        heading2: { run: { size: 28, bold: true, color: "111111" } },
        heading3: { run: { size: 24, bold: true, color: "111111" } },
      },
    },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1200, bottom: 1200, left: 1250, right: 1250 } } }, children: documentBlocks(ast.children ?? [], images) }],
  });

  const base = relative.replace(/\.md$/i, "");
  writeFileSync(checkedFile(root, `${base}.docx`), await Packer.toBuffer(doc));
  const htmlBody = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm, remarkMath, repairCjkStrong]} rehypePlugins={[rehypeKatex]} components={{ img: ({ src, alt }) => <img src={images.get(String(src))?.uri} alt={alt} style={{ maxWidth: "100%", maxHeight: "200mm", objectFit: "contain" }} /> }}>{text}</Markdown>);
  let mathCss = "";
  try {
    const require = createRequire(path.join(root, "nexiom-export.cjs"));
    const katexRoot = path.dirname(require.resolve("katex/package.json", { paths: [path.resolve(__dirname, "../node_modules"), path.resolve(__dirname, "../../node_modules")] }));
    const cssRoot = path.join(katexRoot, "dist");
    mathCss = readFileSync(path.join(cssRoot, "katex.min.css"), "utf8").replace(/url\(([^)]+)\)/g, (_all, asset: string) => { const name = asset.replace(/["']/g, ""); if (!/^fonts\/[\w.-]+$/.test(name)) return "none"; const bytes = readFileSync(path.join(cssRoot, name)); return `url(data:font/woff2;base64,${bytes.toString("base64")})`; });
  } catch { /* Math still has the accessible MathML representation. */ }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:"><title>建模方案</title><style>${mathCss}\n@page{size:A4;margin:20mm}body{font:11pt/1.75 'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#20252b}h1{font-size:23pt}h2{font-size:17pt}h3{font-size:13pt}h1,h2,h3{color:#111;break-after:avoid}p,li{orphans:3;widows:3}table{border-collapse:collapse;width:100%;font-size:10pt}td,th{border:1px solid #d9d9d9;padding:8px;vertical-align:top}th{background:#eef0f2}pre{break-inside:avoid;font-family:Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f6;padding:12px;font-size:9pt}blockquote{border-left:2px solid #aaa;padding-left:15px}a{color:#24588a;overflow-wrap:anywhere}.katex-display{overflow-wrap:anywhere}</style></head><body>${htmlBody}</body></html>`;
  writeFileSync(checkedFile(root, `${base}.html`), html);
  return { source: relative, docx: `${base}.docx`, html: `${base}.html`, pdf: `${base}.pdf`, digest: createHash("sha256").update(text).digest("hex") };
}
