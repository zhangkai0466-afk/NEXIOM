type Node = { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
// CommonMark does not recognize some emphasis adjacent to CJK punctuation.
// Repair text nodes only: never code, math, links, or explicitly escaped stars.
export function repairCjkStrong() {
  return (tree: Node, file: { value: unknown }) => {
    const source = String(file.value ?? "");
    function visit(parent: Node) {
      if (["code", "inlineCode", "math", "inlineMath", "strong"].includes(parent.type)) return;
      parent.children = parent.children?.flatMap(node => {
        if (node.type !== "text" || !node.value?.includes("**")) { visit(node); return [node]; }
        const original = source.slice(node.position?.start.offset, node.position?.end.offset);
        if (original.includes("\\*")) return [node];
        const pieces: Node[] = []; let offset = 0;
        for (const match of node.value.matchAll(/\*\*([^*\n]+)\*\*/g)) {
          if (match.index > offset) pieces.push({ type: "text", value: node.value.slice(offset, match.index) });
          pieces.push({ type: "strong", children: [{ type: "text", value: match[1] }] }); offset = match.index + match[0].length;
        }
        if (!offset) return [node];
        if (offset < node.value.length) pieces.push({ type: "text", value: node.value.slice(offset) });
        return pieces;
      });
    }
    visit(tree);
  };
}
