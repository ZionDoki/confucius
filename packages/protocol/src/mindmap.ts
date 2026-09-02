export interface MindMapNode {
  id: string;
  label: string;
  level: number;
  children: MindMapNode[];
}

/**
 * Parse the shared mind-map source format: Markdown headings establish major
 * branches and indented bullets/numbers establish descendants. Plain lines
 * become leaves, so pasted article outlines still have a useful preview.
 */
export function parseMindMapOutline(markdown: string): MindMapNode[] {
  const roots: MindMapNode[] = [];
  const stack: Array<{ depth: number; node: MindMapNode }> = [];
  let headingDepth = -1;
  let sequence = 0;

  for (const raw of String(markdown ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    if (!raw.trim() || /^\s*```/.test(raw)) continue;
    const heading = raw.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    const bullet = raw.match(/^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/);
    let depth: number;
    let label: string;
    if (heading) {
      depth = heading[1].length - 1;
      headingDepth = depth;
      label = cleanLabel(heading[2]);
    } else if (bullet) {
      const indent = bullet[1].replace(/\t/g, "  ").length;
      depth = Math.max(0, headingDepth + 1 + Math.floor(indent / 2));
      label = cleanLabel(bullet[2]);
    } else {
      depth = Math.max(0, headingDepth + 1);
      label = cleanLabel(raw.trim());
    }
    if (!label) continue;
    const node: MindMapNode = {
      id: `mind-node-${++sequence}`,
      label,
      level: depth,
      children: [],
    };
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
  }
  return roots;
}

export function countMindMapNodes(nodes: MindMapNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countMindMapNodes(node.children);
  }
  return total;
}

function cleanLabel(value: string): string {
  return value
    .replace(/^\s*\[[ xX]\]\s*/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}
