// RM 1,234.50 · -12% · (3,400) · +15.5% · 1.2K
const NUMERIC = /^[(+\-−]?\s*(RM\s?)?[+\-−]?\d[\d,]*(\.\d+)?\s*(%|[KkMm]|x)?\)?$/;

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function rows(node: HastNode, out: HastNode[] = []): HastNode[] {
  for (const child of node.children ?? []) {
    if (child.tagName === "tr") out.push(child);
    else rows(child, out);
  }
  return out;
}

function addClass(node: HastNode, name: string) {
  const props = (node.properties ??= {});
  const current = props.className;
  props.className = Array.isArray(current) ? [...current, name] : current ? [String(current), name] : [name];
}

/** rehype plugin: mark a column `num` when every non-empty body cell is a
 * number, so it right-aligns with tabular figures (header included). */
export function rehypeNumericColumns() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (node.tagName === "table") {
        const all = rows(node);
        const body = all.slice(1);
        const cells = (tr: HastNode) => (tr.children ?? []).filter((c) => c.tagName === "td" || c.tagName === "th");
        const width = Math.max(0, ...all.map((tr) => cells(tr).length));
        for (let col = 0; col < width; col++) {
          const values = body.map((tr) => textOf(cells(tr)[col] ?? { type: "root" }).trim()).filter(Boolean);
          if (values.length && values.every((v) => NUMERIC.test(v.replace(/\*/g, "")))) {
            for (const tr of all) {
              const cell = cells(tr)[col];
              if (cell) addClass(cell, "num");
            }
          }
        }
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

