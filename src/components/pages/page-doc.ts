// Converts between the stored flat block list and the editor's document.
// Lists are flat with an indent in storage and nested in the editor; quotes
// are one block per paragraph in storage and grouped in the editor. Every
// stored block keeps its id on the node that carries it (the list item, the
// quote's paragraph), which is what attribution and comments hang on.
import type { JSONContent } from "@tiptap/core";

import { newBlockId, type PageBlock, type PageRun } from "../../../shared/page";

type Mark = { type: string; attrs?: Record<string, unknown> };

export function runsToInline(runs: readonly PageRun[] | undefined): JSONContent[] {
  const out: JSONContent[] = [];
  for (const run of runs ?? []) {
    const marks: Mark[] = [];
    if (run.b) marks.push({ type: "bold" });
    if (run.i) marks.push({ type: "italic" });
    if (run.u) marks.push({ type: "underline" });
    if (run.s) marks.push({ type: "strike" });
    if (run.code) marks.push({ type: "code" });
    if (run.hl) marks.push({ type: "highlight" });
    if (run.href) marks.push({ type: "link", attrs: { href: run.href } });
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) out.push({ type: "hardBreak" });
      if (part) out.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
    });
  }
  return out;
}

export function inlineToRuns(content: readonly JSONContent[] | undefined): PageRun[] {
  const runs: PageRun[] = [];
  for (const node of content ?? []) {
    if (node.type === "hardBreak") { runs.push({ text: "\n" }); continue; }
    if (node.type === "inlineMath") { runs.push({ text: `$${String(node.attrs?.latex ?? "")}$` }); continue; }
    if (node.type !== "text" || !node.text) continue;
    const run: PageRun = { text: node.text };
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") run.b = true;
      else if (mark.type === "italic") run.i = true;
      else if (mark.type === "underline") run.u = true;
      else if (mark.type === "strike") run.s = true;
      else if (mark.type === "code") run.code = true;
      else if (mark.type === "highlight") run.hl = true;
      else if (mark.type === "link" && typeof mark.attrs?.href === "string") run.href = mark.attrs.href;
    }
    const last = runs.at(-1);
    if (last && sameMarks(last, run)) last.text += run.text;
    else runs.push(run);
  }
  return runs;
}

function sameMarks(a: PageRun, b: PageRun) {
  return a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.code === b.code && a.hl === b.hl && a.href === b.href;
}

const para = (runs: readonly PageRun[] | undefined, id?: string): JSONContent => {
  const content = runsToInline(runs);
  return { type: "paragraph", ...(id ? { attrs: { blockId: id } } : {}), ...(content.length ? { content } : {}) };
};

const LIST = { bullet: "bulletList", numbered: "orderedList", todo: "taskList" } as const;
type ListType = keyof typeof LIST;
const isList = (block: PageBlock | undefined): block is PageBlock & { type: ListType } =>
  Boolean(block && block.type in LIST);

/** Lists starting at blocks[start], at indent `depth`. Returns nodes and next index. */
function buildLists(blocks: readonly PageBlock[], start: number, depth: number): [JSONContent[], number] {
  const lists: JSONContent[] = [];
  let i = start;
  while (i < blocks.length) {
    const first = blocks[i]!;
    if (!isList(first) || (first.indent ?? 0) < depth) break;
    const type = first.type;
    const items: JSONContent[] = [];
    while (i < blocks.length) {
      const block = blocks[i]!;
      if (!isList(block) || (block.indent ?? 0) < depth) break;
      if ((block.indent ?? 0) > depth) {
        // deeper than anything open: hang it off the last item, or open an item for it
        const [nested, next] = buildLists(blocks, i, depth + 1);
        if (items.length) items.at(-1)!.content!.push(...nested);
        else items.push({ type: type === "todo" ? "taskItem" : "listItem", attrs: { blockId: newBlockId(), ...(type === "todo" ? { checked: false } : {}) }, content: [para([]), ...nested] });
        i = next;
        continue;
      }
      if (block.type !== type) break;
      items.push({
        type: type === "todo" ? "taskItem" : "listItem",
        attrs: { blockId: block.id, ...(type === "todo" ? { checked: Boolean(block.checked) } : {}) },
        content: [para(block.content)],
      });
      i += 1;
    }
    lists.push({ type: LIST[type], content: items });
  }
  return [lists, i];
}

export function blocksToDoc(blocks: readonly PageBlock[]): JSONContent {
  const content: JSONContent[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (isList(block)) {
      const [lists, next] = buildLists(blocks, i, Math.min(block.indent ?? 0, 0));
      content.push(...lists);
      i = next;
      continue;
    }
    if (block.type === "quote") {
      const paragraphs: JSONContent[] = [];
      while (blocks[i]?.type === "quote") { paragraphs.push(para(blocks[i]!.content, blocks[i]!.id)); i += 1; }
      content.push({ type: "blockquote", content: paragraphs });
      continue;
    }
    content.push(blockNode(block));
    i += 1;
  }
  if (!content.length) content.push(para([], newBlockId()));
  return { type: "doc", content };
}

function blockNode(block: PageBlock): JSONContent {
  const attrs = { blockId: block.id };
  switch (block.type) {
    case "heading": {
      const inline = runsToInline(block.content);
      return { type: "heading", attrs: { ...attrs, level: block.level ?? 1 }, ...(inline.length ? { content: inline } : {}) };
    }
    case "callout": {
      const inline = runsToInline(block.content);
      return { type: "callout", attrs: { ...attrs, emoji: block.emoji ?? "💡" }, ...(inline.length ? { content: inline } : {}) };
    }
    case "code":
      return { type: "codeBlock", attrs: { ...attrs, language: block.language ?? null }, ...(block.code ? { content: [{ type: "text", text: block.code }] } : {}) };
    case "math": return { type: "blockMath", attrs: { ...attrs, latex: block.code ?? "" } };
    case "divider": return { type: "horizontalRule", attrs };
    case "image": return { type: "image", attrs: { ...attrs, src: block.src ?? "", alt: block.alt ?? null } };
    case "table":
      return {
        type: "table", attrs,
        content: (block.rows ?? [[[]]]).map((row, r) => ({
          type: "tableRow",
          content: row.map(cell => ({ type: r === 0 ? "tableHeader" : "tableCell", content: [para(cell)] })),
        })),
      };
    default: return para(block.content, block.id);
  }
}

const idOf = (node: JSONContent) => {
  const id = node.attrs?.blockId;
  return typeof id === "string" && id ? id : newBlockId();
};

function cellRuns(cell: JSONContent): PageRun[] {
  const parts = (cell.content ?? []).map(child => inlineToRuns(child.content));
  return parts.flatMap((runs, index) => index ? [{ text: "\n" }, ...runs] : runs);
}

function flattenList(list: JSONContent, depth: number, out: PageBlock[]) {
  const type: ListType = list.type === "orderedList" ? "numbered" : list.type === "taskList" ? "todo" : "bullet";
  for (const item of list.content ?? []) {
    const [first, ...rest] = item.content ?? [];
    const block: PageBlock = { id: idOf(item), type, content: first?.type === "paragraph" || first?.type === "heading" ? inlineToRuns(first.content) : [] };
    if (depth) block.indent = depth;
    if (type === "todo") block.checked = Boolean(item.attrs?.checked);
    out.push(block);
    if (first && first.type !== "paragraph" && first.type !== "heading") nodeToBlocks(first, out);
    for (const child of rest) {
      if (child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList") flattenList(child, depth + 1, out);
      else nodeToBlocks(child, out);
    }
  }
}

function nodeToBlocks(node: JSONContent, out: PageBlock[]) {
  const id = idOf(node);
  switch (node.type) {
    case "paragraph": out.push({ id, type: "paragraph", content: inlineToRuns(node.content) }); return;
    case "heading": out.push({ id, type: "heading", level: Math.min(3, Math.max(1, Number(node.attrs?.level) || 1)) as 1 | 2 | 3, content: inlineToRuns(node.content) }); return;
    case "callout": out.push({ id, type: "callout", emoji: typeof node.attrs?.emoji === "string" ? node.attrs.emoji : "💡", content: inlineToRuns(node.content) }); return;
    case "codeBlock": {
      const code = (node.content ?? []).map(child => child.text ?? "").join("");
      out.push({ id, type: "code", code, ...(typeof node.attrs?.language === "string" && node.attrs.language ? { language: node.attrs.language } : {}) });
      return;
    }
    case "blockMath": out.push({ id, type: "math", code: String(node.attrs?.latex ?? "") }); return;
    case "horizontalRule": out.push({ id, type: "divider" }); return;
    case "image":
      if (typeof node.attrs?.src === "string" && node.attrs.src) out.push({ id, type: "image", src: node.attrs.src, ...(node.attrs.alt ? { alt: String(node.attrs.alt) } : {}) });
      return;
    case "table":
      out.push({ id, type: "table", rows: (node.content ?? []).map(row => (row.content ?? []).map(cellRuns)) });
      return;
    case "blockquote":
      for (const child of node.content ?? []) {
        if (child.type === "paragraph") out.push({ id: idOf(child), type: "quote", content: inlineToRuns(child.content) });
        else nodeToBlocks(child, out);
      }
      return;
    case "bulletList": case "orderedList": case "taskList": flattenList(node, 0, out); return;
    default:
      if (node.content) for (const child of node.content) nodeToBlocks(child, out);
  }
}

export function docToBlocks(doc: JSONContent): PageBlock[] {
  const out: PageBlock[] = [];
  for (const node of doc.content ?? []) nodeToBlocks(node, out);
  // a lone empty paragraph is an empty page
  if (out.length === 1 && out[0]!.type === "paragraph" && !out[0]!.content?.length) return [];
  const seen = new Set<string>();
  for (const block of out) {
    if (seen.has(block.id)) block.id = newBlockId();
    seen.add(block.id);
  }
  return out;
}

/** Node types that carry a stored block id. */
export const BLOCK_NODE_TYPES = ["paragraph", "heading", "listItem", "taskItem", "callout", "codeBlock", "blockMath", "horizontalRule", "image", "table"];
