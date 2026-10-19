// Downloads for a page: markdown, a standalone HTML file (also what the app
// prints to PDF) and a Word document. Images uploaded to the page are
// embedded so the file stands on its own; remote images stay links.
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType, type ParagraphChild,
} from "docx";

import { blocksToMarkdown, type PageBlock, type PageRecord, type PageRun } from "../shared/page.ts";

export type AssetReader = (name: string) => { mime: string; data: Buffer } | null;

const esc = (text: string) => text.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const titleOf = (page: Pick<PageRecord, "title">) => page.title || "Untitled page";

export function pageFileName(page: Pick<PageRecord, "title">, ext: string): string {
  const base = titleOf(page).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "page";
  return `${base}.${ext}`;
}

export function pageMarkdownFile(page: PageRecord): string {
  return `# ${page.icon ? `${page.icon} ` : ""}${titleOf(page)}\n\n${blocksToMarkdown(page.blocks)}`;
}

function runsHtml(runs: readonly PageRun[] | undefined): string {
  return (runs ?? []).map(run => {
    let html = esc(run.text).replace(/\n/g, "<br>");
    if (run.code) html = `<code>${html}</code>`;
    if (run.i) html = `<em>${html}</em>`;
    if (run.b) html = `<strong>${html}</strong>`;
    if (run.s) html = `<s>${html}</s>`;
    if (run.u) html = `<u>${html}</u>`;
    if (run.hl) html = `<mark>${html}</mark>`;
    if (run.href && /^(https?:|mailto:)/.test(run.href)) html = `<a href="${esc(run.href)}">${html}</a>`;
    return html;
  }).join("");
}

function imageSrc(src: string | undefined, assets: AssetReader): string | null {
  if (!src) return null;
  if (src.startsWith("asset:")) {
    const asset = assets(src.slice(6));
    return asset ? `data:${asset.mime};base64,${asset.data.toString("base64")}` : null;
  }
  return src;
}

export function pageHtml(page: PageRecord, assets: AssetReader): string {
  const body: string[] = [];
  let list: { tag: "ul" | "ol"; indent: number; todo: boolean }[] = [];
  const closeLists = (depth: number) => { while (list.length > depth) body.push(`</${list.pop()!.tag}>`); };
  for (const block of page.blocks) {
    const isList = block.type === "bullet" || block.type === "numbered" || block.type === "todo";
    if (!isList) closeLists(0);
    else {
      const indent = block.indent ?? 0;
      const tag = block.type === "numbered" ? "ol" : "ul";
      closeLists(indent + 1);
      if (list.length === indent + 1 && list[indent]!.tag !== tag) closeLists(indent);
      while (list.length <= indent) {
        list.push({ tag, indent: list.length, todo: block.type === "todo" });
        body.push(`<${tag}${block.type === "todo" ? ' class="todo"' : ""}>`);
      }
      const box = block.type === "todo" ? `<input type="checkbox" disabled${block.checked ? " checked" : ""}> ` : "";
      body.push(`<li>${box}${runsHtml(block.content)}</li>`);
      continue;
    }
    switch (block.type) {
      case "paragraph": body.push(`<p>${runsHtml(block.content) || "<br>"}</p>`); break;
      case "heading": body.push(`<h${(block.level ?? 1) + 1}>${runsHtml(block.content)}</h${(block.level ?? 1) + 1}>`); break;
      case "quote": body.push(`<blockquote>${runsHtml(block.content)}</blockquote>`); break;
      case "callout": body.push(`<div class="callout"><span>${esc(block.emoji ?? "💡")}</span><div>${runsHtml(block.content)}</div></div>`); break;
      case "code": body.push(`<pre><code>${esc(block.code ?? "")}</code></pre>`); break;
      case "math": body.push(`<pre class="math">${esc(block.code ?? "")}</pre>`); break;
      case "divider": body.push("<hr>"); break;
      case "image": {
        const src = imageSrc(block.src, assets);
        if (src) body.push(`<figure><img src="${esc(src)}" alt="${esc(block.alt ?? "")}"></figure>`);
        break;
      }
      case "table": {
        const [head, ...rest] = block.rows ?? [];
        body.push(`<table><thead><tr>${(head ?? []).map(c => `<th>${runsHtml(c)}</th>`).join("")}</tr></thead><tbody>${rest.map(row => `<tr>${row.map(c => `<td>${runsHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        break;
      }
    }
  }
  closeLists(0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(titleOf(page))}</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#0d0d0d;max-width:720px;margin:48px auto;padding:0 24px;line-height:1.6;font-size:16px}
h1{font-size:2em;margin:0 0 .6em}h2{font-size:1.5em;margin:1.4em 0 .4em}h3{font-size:1.25em;margin:1.2em 0 .3em}h4{font-size:1.1em}
blockquote{border-left:3px solid #d0d0d0;margin:1em 0;padding:0 0 0 1em;color:#444}
pre{background:#f4f4f4;border-radius:8px;padding:12px 14px;overflow:auto;font-size:14px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
p code,li code{background:#f0f0f0;border-radius:4px;padding:1px 4px}mark{background:#fff3a3}
.callout{display:flex;gap:10px;background:#f6f6f6;border-radius:10px;padding:12px 14px;margin:1em 0}
ul.todo{list-style:none;padding-left:1.2em}table{border-collapse:collapse;margin:1em 0;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f7f7f7}
img{max-width:100%;border-radius:8px}hr{border:0;border-top:1px solid #e3e3e3;margin:2em 0}
@media print{body{margin:0 auto}}
</style></head><body><h1>${page.icon ? `${esc(page.icon)} ` : ""}${esc(titleOf(page))}</h1>
${body.join("\n")}
</body></html>`;
}

function docxRuns(runs: readonly PageRun[] | undefined, base: { font?: string } = {}): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const run of runs ?? []) {
    const parts = run.text.split("\n");
    const make = (text: string, breakBefore: boolean) => new TextRun({
      text, break: breakBefore ? 1 : undefined, bold: run.b, italics: run.i, strike: run.s,
      underline: run.u || run.href ? {} : undefined, highlight: run.hl ? "yellow" : undefined,
      font: run.code ? "Menlo" : base.font, color: run.href ? "1155CC" : undefined,
    });
    const pieces = parts.map((text, index) => make(text, index > 0));
    if (run.href && /^(https?:|mailto:)/.test(run.href)) children.push(new ExternalHyperlink({ link: run.href, children: pieces }));
    else children.push(...pieces);
  }
  return children;
}

function docxImage(block: PageBlock, assets: AssetReader): Paragraph | null {
  if (!block.src?.startsWith("asset:")) {
    return block.src ? new Paragraph({ children: [new ExternalHyperlink({ link: block.src, children: [new TextRun({ text: block.alt || block.src, color: "1155CC", underline: {} })] })] }) : null;
  }
  const asset = assets(block.src.slice(6));
  if (!asset) return null;
  const type = asset.mime === "image/png" ? "png" : asset.mime === "image/gif" ? "gif" : asset.mime === "image/jpeg" ? "jpg" : null;
  if (!type) return new Paragraph({ children: [new TextRun({ text: block.alt || "image", italics: true })] });
  const size = imageSize(asset.data, type);
  const scale = Math.min(1, 600 / Math.max(1, size.width));
  return new Paragraph({ children: [new ImageRun({ type, data: asset.data, transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) } })] });
}

function imageSize(data: Buffer, type: "png" | "gif" | "jpg"): { width: number; height: number } {
  try {
    if (type === "png") return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    if (type === "gif") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    for (let i = 2; i + 9 < data.length;) {
      if (data[i] !== 0xff) break;
      const marker = data[i + 1]!, length = data.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  } catch { /* fall through to a default size */ }
  return { width: 480, height: 320 };
}

export async function pageDocx(page: PageRecord, assets: AssetReader): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(`${page.icon ? `${page.icon} ` : ""}${titleOf(page)}`)] })];
  const headings = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
  const numbering: string[] = [];
  let previousNumbered = false;
  for (const block of page.blocks) {
    const level = Math.min(block.indent ?? 0, 6);
    if (block.type === "numbered" && !previousNumbered) numbering.push(`list-${numbering.length}`);
    previousNumbered = block.type === "numbered" || (previousNumbered && (block.type === "bullet" || block.type === "todo") && level > 0);
    switch (block.type) {
      case "paragraph": children.push(new Paragraph({ children: docxRuns(block.content) })); break;
      case "heading": children.push(new Paragraph({ heading: headings[(block.level ?? 1) - 1], children: docxRuns(block.content) })); break;
      case "bullet": children.push(new Paragraph({ bullet: { level }, children: docxRuns(block.content) })); break;
      case "numbered": children.push(new Paragraph({ numbering: { reference: "page-numbers", level, instance: numbering.length }, children: docxRuns(block.content) })); break;
      case "todo": children.push(new Paragraph({ indent: { left: 360 * (level + 1) }, children: [new TextRun(block.checked ? "☑ " : "☐ "), ...docxRuns(block.content)] })); break;
      case "quote": children.push(new Paragraph({ indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CCCCCC", space: 12 } }, children: docxRuns(block.content) })); break;
      case "callout": children.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: "F3F3F3", color: "auto" }, children: [new TextRun(`${block.emoji ?? "💡"} `), ...docxRuns(block.content)] })); break;
      case "code":
      case "math":
        for (const [index, line] of (block.code ?? "").split("\n").entries()) {
          children.push(new Paragraph({ shading: { type: ShadingType.CLEAR, fill: "F4F4F4", color: "auto" }, spacing: { before: index ? 0 : 120, after: 0 }, alignment: block.type === "math" ? AlignmentType.CENTER : undefined, children: [new TextRun({ text: line || " ", font: "Menlo", size: 20 })] }));
        }
        break;
      case "divider": children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "DDDDDD", space: 1 } }, children: [] })); break;
      case "image": { const p = docxImage(block, assets); if (p) children.push(p); break; }
      case "table": {
        const rows = block.rows ?? [];
        const width = rows[0]?.length ?? 1;
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map((row, r) => new TableRow({ tableHeader: r === 0, children: row.map(cell => new TableCell({
            width: { size: Math.floor(100 / width), type: WidthType.PERCENTAGE },
            shading: r === 0 ? { type: ShadingType.CLEAR, fill: "F7F7F7", color: "auto" } : undefined,
            children: [new Paragraph({ children: r === 0 ? docxRuns(cell.map(c => ({ ...c, b: true as const }))) : docxRuns(cell) })],
          })) })),
        }));
        break;
      }
    }
  }
  const doc = new Document({
    creator: "BOS Bot", title: titleOf(page),
    styles: { default: { document: { run: { font: "Helvetica", size: 22 } } } },
    numbering: { config: [{ reference: "page-numbers", levels: Array.from({ length: 7 }, (_, level) => ({
      level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3]!, text: `%${level + 1}.`, alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
    })) }] },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
