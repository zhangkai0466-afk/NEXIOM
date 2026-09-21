interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  children?: MarkdownNode[];
}

function plainText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(plainText).join("") ?? "";
}

// Keep compact comparison tables. Existing reports with paragraph-sized cells
// read as labelled prose, retaining their original links, math and wording.
export function readingProseTables() {
  return (tree: MarkdownNode) => {
    function visit(parent: MarkdownNode) {
      parent.children = parent.children?.flatMap(node => {
        if (node.type !== "table") { if (node.children) visit(node); return [node]; }
        const [head, ...rows] = node.children ?? [];
        const headers = head?.children ?? [];
        const cells = rows.flatMap(row => row.children ?? []);
        const total = cells.reduce((sum, cell) => sum + plainText(cell).length, 0);
        if (headers.length < 5 || !cells.length ||
          (total / cells.length < 45 && !cells.some(cell => plainText(cell).length > 120))) return [node];
        return rows.flatMap(row => (row.children ?? []).map((cell, index): MarkdownNode => index === 0
          ? { type: "heading", depth: 4, children: cell.children }
          : { type: "paragraph", children: [
              { type: "strong", children: headers[index]?.children ?? [{ type: "text", value: `补充 ${index}` }] },
              { type: "text", value: "：" }, ...(cell.children ?? []),
            ] }));
      });
    }
    visit(tree);
  };
}
