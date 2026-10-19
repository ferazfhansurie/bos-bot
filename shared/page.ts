// Pages: owner documents a bot and its person write together. The stored
// model is a flat list of blocks with stable ids so attribution, comments
// and concurrent edits can be tracked per block, and so a bot can read and
// write a page as plain markdown without knowing the editor's schema.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export const PAGE_LIMITS = {
  pagesPerBot: 500,
  blocks: 2000,
  textPerBlock: 20_000,
  titleChars: 200,
  tableCells: 2000,
  pageJsonBytes: 2_000_000,
  versions: 50,
  activity: 300,
  comments: 300,
  commentChars: 4000,
  replies: 50,
  assetBytes: 6_000_000,
  trashDays: 30,
} as const;

export type PageMark = "b" | "i" | "u" | "s" | "code" | "hl";
export interface PageRun {
  text: string;
  b?: true; i?: true; u?: true; s?: true; code?: true; hl?: true;
  href?: string;
}

export type PageBlockType =
  | "paragraph" | "heading" | "bullet" | "numbered" | "todo" | "quote"
  | "callout" | "code" | "math" | "divider" | "image" | "table";

export interface PageBlock {
  id: string;
  type: PageBlockType;
  /** Inline content for paragraph, heading, list items, quote and callout. */
  content?: PageRun[];
  /** Raw source for code and math. */
  code?: string;
  language?: string;
  level?: 1 | 2 | 3;
  indent?: number;
  checked?: boolean;
  emoji?: string;
  src?: string;
  alt?: string;
  /** Table cells; the first row is the header. */
  rows?: PageRun[][][];
}

export interface PageAuthor { kind: "human" | "bot"; id: string; name: string }
export interface PageAttribution { author: PageAuthor; at: number; hash: string }
export interface PageCommentReply { id: string; text: string; author: PageAuthor; at: number }
export interface PageComment {
  id: string;
  blockId: string;
  quote: string;
  text: string;
  author: PageAuthor;
  at: number;
  resolved?: { by: PageAuthor; at: number };
  replies: PageCommentReply[];
}
export interface PageVersion {
  id: string;
  n: number;
  at: number;
  author: PageAuthor;
  title: string;
  icon?: string;
  blocks: PageBlock[];
  reason: "checkpoint" | "before-restore" | "before-bot-edit";
}
export type PageActivityAction =
  | "created" | "edited" | "renamed" | "icon" | "commented" | "replied" | "resolved" | "reopened"
  | "restored" | "viewed" | "pinned" | "unpinned" | "trashed" | "untrashed" | "imported";
export interface PageActivity { at: number; author: PageAuthor; action: PageActivityAction; detail?: string }

export interface PageRecord {
  id: string;
  botId: string;
  /** The conversation the page was started from, when there was one. */
  threadId?: string;
  title: string;
  icon?: string;
  pinned?: boolean;
  fullWidth?: boolean;
  createdAt: number;
  updatedAt: number;
  revision: number;
  createdBy: PageAuthor;
  lastEditedBy: PageAuthor;
  blocks: PageBlock[];
  attribution: Record<string, PageAttribution>;
  comments: PageComment[];
  versions: PageVersion[];
  activity: PageActivity[];
  trashedAt?: number;
}

export interface PageSummary {
  id: string; botId: string; threadId?: string; title: string; icon?: string; pinned?: boolean;
  createdAt: number; updatedAt: number; revision: number; lastEditedBy: PageAuthor; trashedAt?: number;
  snippet: string; openComments: number;
}

export const PAGE_ID_RE = /^p-[a-z0-9]{8,24}$/;
export const BLOCK_ID_RE = /^[a-zA-Z0-9_-]{4,40}$/;
export const ASSET_NAME_RE = /^[a-z0-9]{8,32}\.(png|jpe?g|gif|webp)$/;

function randomToken(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
}
export const newPageId = () => `p-${randomToken(12)}`;
export const newBlockId = () => `b${randomToken(9)}`;
export const newCommentId = () => `c${randomToken(10)}`;

export function pageSummary(page: PageRecord): PageSummary {
  const snippet = page.blocks.map(blockPlainText).filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    id: page.id, botId: page.botId, threadId: page.threadId, title: page.title, icon: page.icon, pinned: page.pinned,
    createdAt: page.createdAt, updatedAt: page.updatedAt, revision: page.revision, lastEditedBy: page.lastEditedBy,
    trashedAt: page.trashedAt, snippet, openComments: page.comments.filter(c => !c.resolved).length,
  };
}

export const runsText = (runs: readonly PageRun[] | undefined) => (runs ?? []).map(r => r.text).join("");

export function blockPlainText(block: PageBlock): string {
  if (block.type === "code" || block.type === "math") return block.code ?? "";
  if (block.type === "image") return block.alt ?? "";
  if (block.type === "table") return (block.rows ?? []).map(row => row.map(runsText).join(" ")).join(" ");
  if (block.type === "divider") return "";
  return runsText(block.content);
}

// ── hashing ────────────────────────────────────────────────────────────────

/** Content identity without the id. FNV-1a is enough: this detects change,
 * it is never a security boundary. */
export function blockHash(block: PageBlock): string {
  const { id: _id, ...rest } = block;
  const text = stableJson(rest);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── validation ─────────────────────────────────────────────────────────────

const refuse = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
const TEXT_TYPES = new Set<PageBlockType>(["paragraph", "heading", "bullet", "numbered", "todo", "quote", "callout"]);
const ALL_TYPES = new Set<PageBlockType>([...TEXT_TYPES, "code", "math", "divider", "image", "table"]);

export function safeHref(href: unknown): string | undefined {
  if (typeof href !== "string") return undefined;
  const value = href.trim();
  if (!value || value.length > 2000) return undefined;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (/^page:p-[a-z0-9]{8,24}$/.test(value)) return value;
  if (value.startsWith("#")) return value;
  return undefined;
}

export function safeImageSrc(src: unknown): string | undefined {
  if (typeof src !== "string") return undefined;
  const value = src.trim();
  if (value.startsWith("asset:") && ASSET_NAME_RE.test(value.slice(6))) return value;
  if (/^https:\/\/[^\s"'<>]+$/i.test(value) && value.length <= 2000) return value;
  return undefined;
}

function cleanRuns(input: unknown, where: string): PageRun[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) refuse(`${where}: content must be a list`);
  const runs: PageRun[] = [];
  let total = 0;
  for (const raw of input as unknown[]) {
    if (!raw || typeof raw !== "object") refuse(`${where}: bad text run`);
    const r = raw as Record<string, unknown>;
    if (typeof r.text !== "string") refuse(`${where}: text run needs text`);
    const text = (r.text as string).replace(/\r\n?/g, "\n");
    if (!text) continue;
    total += text.length;
    const run: PageRun = { text };
    for (const mark of ["b", "i", "u", "s", "code", "hl"] as const) if (r[mark] === true) run[mark] = true;
    const href = safeHref(r.href);
    if (href) run.href = href;
    runs.push(run);
  }
  if (total > PAGE_LIMITS.textPerBlock) refuse(`${where}: text is too long`);
  return mergeRuns(runs);
}

const sameMarks = (a: PageRun, b: PageRun) =>
  a.b === b.b && a.i === b.i && a.u === b.u && a.s === b.s && a.code === b.code && a.hl === b.hl && a.href === b.href;

export function mergeRuns(runs: PageRun[]): PageRun[] {
  const out: PageRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

/** Validate untrusted blocks from an editor save or a bot. Unknown fields are
 * dropped, ids are kept when well formed and unique, otherwise replaced. */
export function validateBlocks(input: unknown): PageBlock[] {
  if (!Array.isArray(input)) refuse("blocks must be a list");
  const list = input as unknown[];
  if (list.length > PAGE_LIMITS.blocks) refuse(`a page holds at most ${PAGE_LIMITS.blocks} blocks`);
  const seen = new Set<string>();
  let cells = 0;
  return list.map((raw, index) => {
    if (!raw || typeof raw !== "object") refuse(`block ${index + 1} is not an object`);
    const b = raw as Record<string, unknown>;
    const type = b.type as PageBlockType;
    if (!ALL_TYPES.has(type)) refuse(`block ${index + 1} has an unknown type`);
    let id = typeof b.id === "string" && BLOCK_ID_RE.test(b.id) && !seen.has(b.id) ? b.id : newBlockId();
    while (seen.has(id)) id = newBlockId();
    seen.add(id);
    const block: PageBlock = { id, type };
    const where = `block ${index + 1}`;
    if (TEXT_TYPES.has(type)) block.content = cleanRuns(b.content, where);
    if (type === "heading") block.level = b.level === 1 || b.level === 2 || b.level === 3 ? b.level : 1;
    if (type === "bullet" || type === "numbered" || type === "todo") {
      const indent = Number(b.indent ?? 0);
      if (Number.isInteger(indent) && indent > 0) block.indent = Math.min(indent, 6);
    }
    if (type === "todo" && b.checked === true) block.checked = true;
    if (type === "callout") block.emoji = typeof b.emoji === "string" && b.emoji.trim() ? [...b.emoji.trim()].slice(0, 4).join("") : "💡";
    if (type === "code" || type === "math") {
      const code = typeof b.code === "string" ? b.code.replace(/\r\n?/g, "\n") : "";
      if (code.length > PAGE_LIMITS.textPerBlock) refuse(`${where}: code is too long`);
      block.code = code;
      if (type === "code" && typeof b.language === "string" && /^[\w+#.-]{1,30}$/.test(b.language)) block.language = b.language;
    }
    if (type === "image") {
      const src = safeImageSrc(b.src);
      if (!src) refuse(`${where}: images need an https address or an uploaded image`);
      block.src = src;
      if (typeof b.alt === "string" && b.alt) block.alt = b.alt.slice(0, 500);
    }
    if (type === "table") {
      if (!Array.isArray(b.rows) || !b.rows.length) refuse(`${where}: a table needs rows`);
      const rows = (b.rows as unknown[]).map(row => {
        if (!Array.isArray(row) || !row.length) refuse(`${where}: every table row needs cells`);
        return (row as unknown[]).map(cell => cleanRuns(cell, where));
      });
      const width = Math.max(...rows.map(r => r.length));
      for (const row of rows) while (row.length < width) row.push([]);
      cells += width * rows.length;
      if (cells > PAGE_LIMITS.tableCells) refuse(`tables on a page hold at most ${PAGE_LIMITS.tableCells} cells`);
      block.rows = rows;
    }
    return block;
  });
}

export function validateTitle(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") refuse("title must be text");
  return (input as string).replace(/\s+/g, " ").trim().slice(0, PAGE_LIMITS.titleChars);
}

export function validateIcon(input: unknown): string | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input !== "string") refuse("icon must be an emoji");
  const icon = [...(input as string).trim()].slice(0, 4).join("");
  if (!icon || /[\s<>]/.test(icon)) refuse("icon must be an emoji");
  return icon;
}

// ── markdown out ──────────────────────────────────────────────────────────

function escapeText(text: string): string {
  return text.replace(/[\\*_`[\]~<]/g, ch => `\\${ch}`);
}

/** Inline runs to markdown. Marks nest as a stack so a bold run that changes
 * italics midway stays one bold span; whitespace is kept outside delimiters
 * because CommonMark will not close `**foo **`. */
export function runsToMarkdown(runs: readonly PageRun[]): string {
  type Key = string;
  const open = (k: Key) => k === "b" ? "**" : k === "i" ? "*" : k === "s" ? "~~" : k === "u" ? "<u>" : k === "hl" ? "<mark>" : "[";
  const close = (k: Key) => k === "b" ? "**" : k === "i" ? "*" : k === "s" ? "~~" : k === "u" ? "</u>" : k === "hl" ? "</mark>" : `](${k.slice(2)})`;
  const keysOf = (r: PageRun): Key[] => [
    ...(r.href ? [`a:${r.href}`] : []), ...(r.u ? ["u"] : []), ...(r.hl ? ["hl"] : []), ...(r.s ? ["s"] : []), ...(r.b ? ["b"] : []), ...(r.i ? ["i"] : []),
  ];
  let out = "";
  const stack: Key[] = [];
  const closeTo = (depth: number) => {
    if (stack.length <= depth) return;
    const trailing = out.match(/[ \t]+$/)?.[0] ?? "";
    out = out.slice(0, out.length - trailing.length);
    while (stack.length > depth) out += close(stack.pop()!);
    out += trailing;
  };
  for (const run of mergeRuns([...runs])) {
    const keys = keysOf(run);
    let keep = 0;
    while (keep < stack.length && keys.includes(stack[keep]!)) keep++;
    closeTo(keep);
    const pending = keys.filter(k => !stack.includes(k));
    let body: string;
    if (run.code) {
      const longest = Math.max(0, ...(run.text.match(/`+/g) ?? []).map(m => m.length));
      const fence = "`".repeat(longest + 1);
      const pad = run.text.startsWith("`") || run.text.endsWith("`") ? " " : "";
      body = `${fence}${pad}${run.text}${pad}${fence}`;
    } else {
      body = escapeText(run.text).replace(/\n/g, "\\\n");
    }
    const lead = pending.length ? body.match(/^[ \t]+/)?.[0] ?? "" : "";
    out += lead;
    for (const k of pending) { out += open(k); stack.push(k); }
    out += body.slice(lead.length);
  }
  closeTo(0);
  return out;
}

function blockLineStart(text: string): string {
  return text.replace(/^(#{1,6}\s|>|[-+]\s|\d+[.)]\s|={3,}|-{3,})/, m => `\\${m}`);
}

function tableCell(runs: PageRun[]): string {
  return runsToMarkdown(runs).replace(/\\\n/g, "<br>").replace(/\|/g, "\\|") || " ";
}

export function blockToMarkdown(block: PageBlock, listIndex = 1): string {
  const inline = () => runsToMarkdown(block.content ?? []);
  const pad = "    ".repeat(block.indent ?? 0);
  switch (block.type) {
    case "paragraph": return blockLineStart(inline());
    case "heading": return `${"#".repeat(block.level ?? 1)} ${inline()}`;
    case "bullet": return `${pad}- ${inline()}`;
    case "numbered": return `${pad}${listIndex}. ${inline()}`;
    case "todo": return `${pad}- [${block.checked ? "x" : " "}] ${inline()}`;
    case "quote": return inline().split("\n").map(line => `> ${line}`).join("\n");
    case "callout": return `> [!${block.emoji ?? "💡"}] ${inline()}`.split("\n").join("\n> ");
    case "code": {
      const code = block.code ?? "";
      const longest = Math.max(2, ...(code.match(/`{3,}/g) ?? []).map(m => m.length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${block.language ?? ""}\n${code}\n${fence}`;
    }
    case "math": return `$$\n${block.code ?? ""}\n$$`;
    case "divider": return "---";
    case "image": return `![${escapeText(block.alt ?? "")}](${block.src ?? ""})`;
    case "table": {
      const rows = block.rows ?? [[[]]];
      const width = rows[0]!.length;
      const line = (row: PageRun[][]) => `| ${row.map(tableCell).join(" | ")} |`;
      return [line(rows[0]!), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
    }
  }
}

const LIST_TYPES = new Set<PageBlockType>(["bullet", "numbered", "todo"]);

export function blocksToMarkdown(blocks: readonly PageBlock[], options: { ids?: boolean } = {}): string {
  const parts: string[] = [];
  const counters: number[] = [];
  let previous: PageBlock | undefined;
  for (const block of blocks) {
    const indent = block.indent ?? 0;
    if (block.type === "numbered") {
      counters.length = indent + 1;
      counters[indent] = previous && LIST_TYPES.has(previous.type) && (previous.indent ?? 0) >= indent && counters[indent] ? counters[indent]! + 1 : 1;
    } else if (!LIST_TYPES.has(block.type)) counters.length = 0;
    else counters.length = indent;
    const text = blockToMarkdown(block, counters[indent] ?? 1);
    const tagged = options.ids ? `<!-- ${block.id} -->\n${text}` : text;
    const tight = !options.ids && previous && LIST_TYPES.has(previous.type) && LIST_TYPES.has(block.type);
    parts.push(parts.length ? (tight ? "\n" : "\n\n") + tagged : tagged);
    previous = block;
  }
  return parts.join("") + (parts.length ? "\n" : "");
}

export function pageToMarkdown(page: Pick<PageRecord, "title" | "icon" | "blocks">): string {
  const title = `${page.icon ? `${page.icon} ` : ""}${page.title || "Untitled page"}`;
  return `# ${title}\n\n${blocksToMarkdown(page.blocks)}`;
}

// ── markdown in ───────────────────────────────────────────────────────────

type MdNode = {
  type: string; value?: string; url?: string; alt?: string | null; lang?: string | null; depth?: number;
  ordered?: boolean | null; checked?: boolean | null; children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const ALERT_EMOJI: Record<string, string> = { NOTE: "ℹ️", TIP: "💡", IMPORTANT: "❗", WARNING: "⚠️", CAUTION: "🛑" };

function inlineRuns(nodes: MdNode[] | undefined, marks: Omit<PageRun, "text"> = {}, images?: PageBlock[]): PageRun[] {
  const runs: PageRun[] = [];
  let html: Omit<PageRun, "text"> = {};
  for (const node of nodes ?? []) {
    const active = { ...marks, ...html };
    switch (node.type) {
      case "text": runs.push({ ...active, text: node.value ?? "" }); break;
      case "strong": runs.push(...inlineRuns(node.children, { ...active, b: true }, images)); break;
      case "emphasis": runs.push(...inlineRuns(node.children, { ...active, i: true }, images)); break;
      case "delete": runs.push(...inlineRuns(node.children, { ...active, s: true }, images)); break;
      case "inlineCode": runs.push({ ...active, code: true, text: node.value ?? "" }); break;
      case "break": runs.push({ ...active, text: "\n" }); break;
      case "link": {
        const href = safeHref(node.url);
        runs.push(...inlineRuns(node.children, href ? { ...active, href } : active, images));
        break;
      }
      case "image": {
        const src = safeImageSrc(node.url);
        if (src && images) images.push({ id: newBlockId(), type: "image", src, ...(node.alt ? { alt: node.alt } : {}) });
        else if (node.alt) runs.push({ ...active, text: node.alt });
        break;
      }
      case "html": {
        const tag = (node.value ?? "").trim().toLowerCase();
        if (tag === "<u>") html = { ...html, u: true };
        else if (tag === "</u>") { const { u: _u, ...rest } = html; html = rest; }
        else if (tag === "<mark>") html = { ...html, hl: true };
        else if (tag === "</mark>") { const { hl: _hl, ...rest } = html; html = rest; }
        else if (/^<br\s*\/?>$/.test(tag)) runs.push({ ...active, text: "\n" });
        else runs.push({ ...active, text: node.value ?? "" });
        break;
      }
      default:
        if (node.children) runs.push(...inlineRuns(node.children, active, images));
        else if (node.value) runs.push({ ...active, text: node.value });
    }
  }
  return mergeRuns(runs.map(r => {
    const clean: PageRun = { text: r.text };
    for (const k of ["b", "i", "u", "s", "code", "hl"] as const) if (r[k]) clean[k] = true;
    if (r.href) clean.href = r.href;
    return clean;
  }));
}

function trimRuns(runs: PageRun[]): PageRun[] {
  const out = runs.map(r => ({ ...r }));
  while (out.length && !out[0]!.code && !(out[0]!.text = out[0]!.text.replace(/^\s+/, ""))) out.shift();
  while (out.length && !out[out.length - 1]!.code && !(out[out.length - 1]!.text = out[out.length - 1]!.text.replace(/\s+$/, ""))) out.pop();
  return out;
}

/** Parse markdown (from a bot, a paste or an import) into blocks. GFM tables,
 * task lists and strikethrough are understood; `$$` fences become math and
 * `> [!💡]` quotes become callouts. Anything unknown degrades to text. */
export function markdownToBlocks(markdown: string): PageBlock[] {
  const source = markdown.replace(/\r\n?/g, "\n");
  const root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as MdNode;
  const blocks: PageBlock[] = [];
  const slice = (node: MdNode) => node.position?.start.offset !== undefined && node.position.end.offset !== undefined
    ? source.slice(node.position.start.offset, node.position.end.offset) : "";
  const paragraph = (node: MdNode, type: "paragraph" | "quote" = "paragraph") => {
    const raw = slice(node).trim();
    if (raw.startsWith("$$") && raw.endsWith("$$") && raw.length >= 4) {
      blocks.push({ id: newBlockId(), type: "math", code: raw.slice(2, -2).trim() });
      return;
    }
    const images: PageBlock[] = [];
    const content = trimRuns(inlineRuns(node.children, {}, images));
    if (content.length || !images.length) blocks.push({ id: newBlockId(), type, content });
    blocks.push(...images);
  };
  const list = (node: MdNode, indent: number) => {
    for (const item of node.children ?? []) {
      const [first, ...rest] = item.children ?? [];
      const type: PageBlockType = typeof item.checked === "boolean" ? "todo" : node.ordered ? "numbered" : "bullet";
      const images: PageBlock[] = [];
      const content = first?.type === "paragraph" ? trimRuns(inlineRuns(first.children, {}, images)) : [];
      blocks.push({ id: newBlockId(), type, content, ...(indent ? { indent: Math.min(indent, 6) } : {}), ...(item.checked ? { checked: true } : {}) });
      blocks.push(...images);
      for (const child of first && first.type !== "paragraph" ? [first, ...rest] : rest) {
        if (child.type === "list") list(child, indent + 1);
        else block(child);
      }
    }
  };
  const block = (node: MdNode) => {
    switch (node.type) {
      case "heading": {
        const depth = node.depth ?? 1;
        blocks.push({ id: newBlockId(), type: "heading", level: (depth > 3 ? 3 : depth) as 1 | 2 | 3, content: trimRuns(inlineRuns(node.children)) });
        return;
      }
      case "paragraph": paragraph(node); return;
      case "list": list(node, 0); return;
      case "code":
        blocks.push(node.lang === "math" || node.lang === "latex"
          ? { id: newBlockId(), type: "math", code: node.value ?? "" }
          : { id: newBlockId(), type: "code", code: node.value ?? "", ...(node.lang && /^[\w+#.-]{1,30}$/.test(node.lang) ? { language: node.lang } : {}) });
        return;
      case "thematicBreak": blocks.push({ id: newBlockId(), type: "divider" }); return;
      case "blockquote": {
        const children = node.children ?? [];
        const firstText = children[0]?.type === "paragraph" ? runsText(inlineRuns(children[0].children)) : "";
        const alert = firstText.match(/^\[!([^\]\s]{1,12})\]\s*/);
        const runs: PageRun[] = [];
        for (const child of children) {
          const piece = child.type === "paragraph" ? inlineRuns(child.children) : [{ text: slice(child) }];
          if (runs.length) runs.push({ text: "\n" });
          runs.push(...piece);
        }
        if (alert) {
          let skip = alert[0].length;
          while (skip > 0 && runs.length) {
            const head = runs[0]!;
            if (head.text.length <= skip) { skip -= head.text.length; runs.shift(); }
            else { runs[0] = { ...head, text: head.text.slice(skip) }; skip = 0; }
          }
          const key = alert[1]!.toUpperCase();
          blocks.push({ id: newBlockId(), type: "callout", emoji: ALERT_EMOJI[key] ?? alert[1], content: trimRuns(mergeRuns(runs)) });
        } else blocks.push({ id: newBlockId(), type: "quote", content: trimRuns(mergeRuns(runs)) });
        return;
      }
      case "table": {
        const rows = (node.children ?? []).map(row => (row.children ?? []).map(cell => trimRuns(inlineRuns(cell.children))));
        if (rows.length) {
          const width = Math.max(...rows.map(r => r.length));
          for (const row of rows) while (row.length < width) row.push([]);
          blocks.push({ id: newBlockId(), type: "table", rows });
        }
        return;
      }
      case "html": {
        const text = (node.value ?? "").trim();
        if (text && !/^<!--[\s\S]*-->$/.test(text)) blocks.push({ id: newBlockId(), type: "paragraph", content: [{ text }] });
        return;
      }
      case "definition": case "footnoteDefinition": return;
      default: {
        const text = slice(node).trim();
        if (text) blocks.push({ id: newBlockId(), type: "paragraph", content: [{ text }] });
      }
    }
  };
  for (const child of root.children ?? []) block(child);
  return validateBlocks(blocks);
}

/** A markdown document whose first line is `# Title` gives its title. */
export function splitMarkdownTitle(markdown: string): { title?: string; body: string } {
  const match = markdown.replace(/^﻿/, "").match(/^\s*#\s+([^\n]+)\n?/);
  if (!match) return { body: markdown };
  return { title: match[1]!.trim(), body: markdown.slice(match[0].length) };
}

// ── ids, attribution, merging ─────────────────────────────────────────────

/** Give a freshly parsed block list the ids of the blocks it still matches, so
 * rewriting a whole page keeps comments and attribution on untouched blocks.
 * Equal content anchors first (longest common subsequence), then blocks of
 * the same type in the same gap are treated as edits of each other. */
export function reconcileBlockIds(previous: readonly PageBlock[], next: readonly PageBlock[]): PageBlock[] {
  const a = previous.map(blockHash), b = next.map(blockHash);
  const pairs: Array<[number, number]> = [];
  if (a.length * b.length <= 4_000_000) {
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
      else j++;
    }
  } else {
    const used = new Set<number>();
    let from = 0;
    b.forEach((hash, j) => {
      const i = a.indexOf(hash, from);
      if (i >= 0 && !used.has(i)) { used.add(i); pairs.push([i, j]); from = i + 1; }
    });
  }
  const ids: Array<string | undefined> = next.map(() => undefined);
  for (const [i, j] of pairs) ids[j] = previous[i]!.id;
  const bounds: Array<[number, number]> = [[-1, -1], ...pairs, [previous.length, next.length]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [ai, bj] = bounds[k]!, [ae, be] = bounds[k + 1]!;
    for (let i = ai + 1, j = bj + 1; i < ae && j < be; i++, j++) {
      if (previous[i]!.type === next[j]!.type) ids[j] = previous[i]!.id;
    }
  }
  const seen = new Set<string>();
  return next.map((block, j) => {
    let id = ids[j] ?? block.id;
    if (seen.has(id)) id = newBlockId();
    seen.add(id);
    return { ...block, id };
  });
}

/** Changed or new blocks belong to whoever saved them; untouched blocks keep
 * their author. Attribution for removed blocks is dropped. */
export function attributeBlocks(
  previous: Record<string, PageAttribution>, blocks: readonly PageBlock[], author: PageAuthor, at: number,
): Record<string, PageAttribution> {
  const next: Record<string, PageAttribution> = {};
  for (const block of blocks) {
    const hash = blockHash(block);
    const before = previous[block.id];
    next[block.id] = before && before.hash === hash ? before : { author, at, hash };
  }
  return next;
}

/** Three-way merge by block id for an editor save that raced another edit.
 * Each side's change to a block wins over the unchanged side; when both
 * changed the same block the local (person's) copy wins. Deletions win over
 * no-ops. New blocks keep their place after their nearest surviving
 * predecessor. */
export function mergeBlocks(base: readonly PageBlock[], mine: readonly PageBlock[], theirs: readonly PageBlock[]): PageBlock[] {
  const baseById = new Map(base.map(b => [b.id, blockHash(b)]));
  const mineById = new Map(mine.map(b => [b.id, b]));
  const theirsById = new Map(theirs.map(b => [b.id, b]));
  const pick = (id: string): PageBlock | null => {
    const m = mineById.get(id), t = theirsById.get(id), baseHash = baseById.get(id);
    if (baseHash === undefined) return m ?? t ?? null;
    if (!m) return t && blockHash(t) !== baseHash ? t : null;
    if (!t) return blockHash(m) !== baseHash ? m : null;
    return blockHash(m) !== baseHash ? m : t;
  };
  const result: PageBlock[] = [];
  const placed = new Set<string>();
  for (const t of theirs) {
    const chosen = pick(t.id);
    if (chosen) { result.push(chosen); placed.add(t.id); }
  }
  let anchor: string | null = null;
  for (const m of mine) {
    if (!placed.has(m.id) && pick(m.id) === m) {
      const at = anchor === null ? 0 : result.findIndex(b => b.id === anchor) + 1;
      result.splice(at, 0, m);
      placed.add(m.id);
    }
    if (placed.has(m.id)) anchor = m.id;
  }
  return result;
}

// ── bot edit operations ───────────────────────────────────────────────────

export type PageEditOp =
  | { op: "replace"; blockId: string; markdown: string }
  | { op: "insert_after"; blockId: string; markdown: string }
  | { op: "insert_before"; blockId: string; markdown: string }
  | { op: "append"; markdown: string }
  | { op: "prepend"; markdown: string }
  | { op: "delete"; blockId: string }
  | { op: "check"; blockId: string; checked: boolean };

export function applyPageEdits(blocks: readonly PageBlock[], ops: readonly PageEditOp[]): PageBlock[] {
  let next = [...blocks];
  const at = (id: string) => {
    const index = next.findIndex(b => b.id === id);
    if (index < 0) refuse(`no block ${id} on this page; read the page again for current ids`);
    return index;
  };
  for (const op of ops) {
    if (op.op === "append") next = [...next, ...markdownToBlocks(op.markdown)];
    else if (op.op === "prepend") next = [...markdownToBlocks(op.markdown), ...next];
    else if (op.op === "delete") next.splice(at(op.blockId), 1);
    else if (op.op === "check") {
      const index = at(op.blockId);
      if (next[index]!.type !== "todo") refuse(`block ${op.blockId} is not a to-do`);
      next[index] = { ...next[index]!, checked: op.checked || undefined };
      if (!op.checked) delete next[index]!.checked;
    } else {
      const index = at(op.blockId);
      const parsed = markdownToBlocks(op.markdown);
      if (op.op === "replace") {
        if (parsed[0] && parsed[0].type === next[index]!.type) parsed[0] = { ...parsed[0], id: op.blockId };
        next.splice(index, 1, ...parsed);
      } else next.splice(op.op === "insert_after" ? index + 1 : index, 0, ...parsed);
    }
  }
  return validateBlocks(next);
}

/** Markdown for a bot: each block prefixed by its id comment so page_edit can
 * target it. */
export function pageForBot(page: PageRecord, botId: string): string {
  const lines = [
    `page ${page.id} · "${page.title || "Untitled page"}"${page.icon ? ` ${page.icon}` : ""} · revision ${page.revision}`,
    `last edited by ${page.lastEditedBy.name} · ${new Date(page.updatedAt).toISOString()}`,
  ];
  const open = page.comments.filter(c => !c.resolved);
  const body = blocksToMarkdown(page.blocks, { ids: true });
  lines.push("", body.trim() ? body : "(empty page)");
  if (open.length) {
    lines.push("", "open comments:");
    for (const c of open) {
      lines.push(`- ${c.id} on ${c.blockId}${c.quote ? ` "${c.quote.slice(0, 120)}"` : ""}: ${c.author.name}: ${c.text}`);
      for (const r of c.replies) lines.push(`  - ${r.author.kind === "bot" && r.author.id === botId ? "you" : r.author.name}: ${r.text}`);
    }
  }
  return lines.join("\n");
}

// ── AI requests from the editor ───────────────────────────────────────────

export function pageAskRequest(input: {
  pageId: string; title: string; instruction: string; blockIds?: string[]; quote?: string; kind?: "change" | "generate" | "comment";
}): string {
  const where = input.blockIds?.length ? ` blocks ${input.blockIds.join(", ")}` : "";
  const quote = input.quote ? `\nselected text:\n"""\n${input.quote.slice(0, 4000)}\n"""` : "";
  const how = input.kind === "generate"
    ? `write it into the page with page_edit (insert_after the block named above, or append).`
    : input.kind === "comment"
      ? `reply on the page with page_comment.`
      : `apply it with page_edit on${where || " the page"}, keeping everything else as it is.`;
  return `[page request] page ${input.pageId} "${input.title || "Untitled page"}"${where}${quote}\nrequest: ${input.instruction.trim().slice(0, 4000)}\nread it with page_read first, then ${how} pass the revision you read as base_revision. reply in one short line when done.`;
}
