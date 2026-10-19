// Page storage: one JSON file per page under the bot folder, which sits
// outside the bot-writable workspace so a bot can only change a page through
// its page tools (and so attribution cannot be forged by editing the file).
// Deleting the bot deletes its folder and with it every page.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { botFolder } from "./bot-folder.ts";
import {
  ASSET_NAME_RE, PAGE_ID_RE, PAGE_LIMITS, applyPageEdits, attributeBlocks, blockPlainText, blocksToMarkdown, markdownToBlocks,
  newCommentId, newPageId, pageSummary, reconcileBlockIds, splitMarkdownTitle, validateBlocks, validateIcon, validateTitle,
  type PageActivityAction, type PageAuthor, type PageBlock, type PageEditOp, type PageRecord, type PageSummary, type PageVersion,
} from "../shared/page.ts";

const fail = (status: number, message: string, extra: Record<string, unknown> = {}): never => {
  throw Object.assign(new Error(message), { status, ...extra });
};
const CHECKPOINT_GAP_MS = 10 * 60_000;
const VIEW_GAP_MS = 10 * 60_000;
const IMAGE_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const ASSET_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export interface PageChange { botId: string; pageId: string; revision: number; by: PageAuthor; deleted?: boolean }

export class PageStore {
  private cache = new Map<string, Map<string, PageRecord>>();
  private readonly root: (botId: string) => string;
  private readonly now: () => number;
  private readonly onChange: (change: PageChange) => void;

  constructor(options: { root?: (botId: string) => string; now?: () => number; onChange?: (change: PageChange) => void } = {}) {
    this.root = options.root ?? (botId => join(botFolder(botId), "pages"));
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  private dir(botId: string) {
    if (!/^[\w-]+$/.test(botId)) fail(400, "bad bot id");
    return this.root(botId);
  }

  private pages(botId: string): Map<string, PageRecord> {
    let pages = this.cache.get(botId);
    if (pages) return pages;
    pages = new Map();
    const dir = this.dir(botId);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json") || !PAGE_ID_RE.test(name.slice(0, -5))) continue;
        try {
          const page = JSON.parse(readFileSync(join(dir, name), "utf8")) as PageRecord;
          if (page?.id === name.slice(0, -5) && Array.isArray(page.blocks)) pages.set(page.id, page);
        } catch { /* a damaged page file stays on disk for recovery and is skipped */ }
      }
    }
    this.cache.set(botId, pages);
    return pages;
  }

  /** Drop the cached copy after the bot (and its folder) is deleted. */
  forget(botId: string) { this.cache.delete(botId); }

  private persist(page: PageRecord) {
    // Current content and history have separate budgets: keeping a snapshot
    // must never prevent an otherwise valid document from being edited.
    if (Buffer.byteLength(JSON.stringify({ ...page, versions: [] })) > PAGE_LIMITS.pageJsonBytes) fail(413, "this page is too large to save; split it into smaller pages");
    while (page.versions.length && Buffer.byteLength(JSON.stringify(page.versions)) > 8_000_000) page.versions.shift();
    const encoded = JSON.stringify(page);
    const dir = this.dir(page.botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, `${page.id}.json`), encoded, { mode: 0o600 });
    this.pages(page.botId).set(page.id, page);
  }

  private log(page: PageRecord, author: PageAuthor, action: PageActivityAction, detail?: string) {
    const at = this.now();
    const last = page.activity[page.activity.length - 1];
    if (action === "edited" && last?.action === "edited" && last.author.id === author.id && at - last.at < CHECKPOINT_GAP_MS) {
      last.at = at;
      return;
    }
    page.activity.push({ at, author, action, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    if (page.activity.length > PAGE_LIMITS.activity) page.activity.splice(0, page.activity.length - PAGE_LIMITS.activity);
  }

  private checkpoint(page: PageRecord, reason: PageVersion["reason"]) {
    const last = page.versions[page.versions.length - 1];
    const same = last && last.title === page.title && last.icon === page.icon
      && JSON.stringify(last.blocks) === JSON.stringify(page.blocks);
    if (same) return;
    page.versions.push({
      id: `v${page.revision}-${(last?.n ?? 0) + 1}`, n: (last?.n ?? 0) + 1, at: page.updatedAt, author: page.lastEditedBy,
      title: page.title, ...(page.icon ? { icon: page.icon } : {}), blocks: page.blocks, reason,
    });
    if (page.versions.length > PAGE_LIMITS.versions) page.versions.splice(0, page.versions.length - PAGE_LIMITS.versions);
  }

  /** Before a content change: keep the old state when another author takes
   * over (so a bot's edit can be undone) or when the last checkpoint is old. */
  private beforeContentChange(page: PageRecord, author: PageAuthor) {
    const last = page.versions[page.versions.length - 1];
    const handover = page.lastEditedBy.id !== author.id || page.lastEditedBy.kind !== author.kind;
    if (handover) this.checkpoint(page, author.kind === "bot" ? "before-bot-edit" : "checkpoint");
    else if (!last || this.now() - last.at > CHECKPOINT_GAP_MS) this.checkpoint(page, "checkpoint");
  }

  private commit(page: PageRecord, author: PageAuthor) {
    page.revision += 1;
    page.updatedAt = this.now();
    page.lastEditedBy = author;
    this.persist(page);
    this.onChange({ botId: page.botId, pageId: page.id, revision: page.revision, by: author });
    return page;
  }

  list(botId: string, options: { trash?: boolean; query?: string } = {}): PageSummary[] {
    const pages = this.pages(botId);
    const cutoff = this.now() - PAGE_LIMITS.trashDays * 86_400_000;
    for (const page of pages.values()) if (page.trashedAt && page.trashedAt < cutoff) this.destroy(botId, page.id, page.lastEditedBy);
    const query = options.query?.trim().toLowerCase();
    return [...pages.values()]
      .filter(page => Boolean(page.trashedAt) === Boolean(options.trash))
      .filter(page => !query || page.title.toLowerCase().includes(query) || page.blocks.some(b => blockPlainText(b).toLowerCase().includes(query)))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .map(pageSummary);
  }

  get(botId: string, pageId: string): PageRecord {
    if (!PAGE_ID_RE.test(pageId)) fail(404, "no such page");
    return structuredClone(this.pages(botId).get(pageId) ?? fail(404, "no such page"));
  }

  create(botId: string, input: { title?: unknown; icon?: unknown; blocks?: unknown; markdown?: unknown; threadId?: string }, author: PageAuthor): PageRecord {
    if (this.pages(botId).size >= PAGE_LIMITS.pagesPerBot) fail(409, `a bot holds at most ${PAGE_LIMITS.pagesPerBot} pages; delete some first`);
    let title = validateTitle(input.title);
    let blocks: PageBlock[];
    if (typeof input.markdown === "string") {
      const split = splitMarkdownTitle(input.markdown);
      if (!title && split.title) title = validateTitle(split.title);
      blocks = markdownToBlocks(split.title && title === validateTitle(split.title) ? split.body : input.markdown);
    } else blocks = input.blocks === undefined ? [] : validateBlocks(input.blocks);
    const at = this.now();
    const page: PageRecord = {
      id: newPageId(), botId, ...(input.threadId ? { threadId: input.threadId } : {}), title,
      ...(validateIcon(input.icon) ? { icon: validateIcon(input.icon) } : {}),
      createdAt: at, updatedAt: at, revision: 0, createdBy: author, lastEditedBy: author, blocks,
      attribution: attributeBlocks({}, blocks, author, at), comments: [], versions: [], activity: [],
    };
    this.log(page, author, typeof input.markdown === "string" ? "imported" : "created");
    return this.commit(page, author);
  }

  /** An editor save. Stale revisions are refused with the current page so the
   * client can merge and retry. */
  save(botId: string, pageId: string, input: { baseRevision?: unknown; blocks?: unknown; title?: unknown; icon?: unknown; fullWidth?: unknown }, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    if (page.trashedAt) fail(409, "this page is in the trash; restore it first");
    if (input.baseRevision !== page.revision) fail(409, "the page changed since you opened it", { page });
    const blocks = input.blocks === undefined ? undefined : validateBlocks(input.blocks);
    const title = input.title === undefined ? undefined : validateTitle(input.title);
    const icon = input.icon === undefined ? undefined : validateIcon(input.icon) ?? "";
    const contentChanged = blocks !== undefined && JSON.stringify(blocks) !== JSON.stringify(page.blocks);
    const titleChanged = title !== undefined && title !== page.title;
    const iconChanged = icon !== undefined && icon !== (page.icon ?? "");
    const widthChanged = typeof input.fullWidth === "boolean" && input.fullWidth !== Boolean(page.fullWidth);
    if (!contentChanged && !titleChanged && !iconChanged && !widthChanged) return page;
    if (contentChanged || titleChanged) this.beforeContentChange(page, author);
    if (contentChanged) {
      page.attribution = attributeBlocks(page.attribution, blocks!, author, this.now());
      page.blocks = blocks!;
      this.log(page, author, "edited");
    }
    if (titleChanged) { this.log(page, author, "renamed", title || "Untitled page"); page.title = title!; }
    if (iconChanged) { this.log(page, author, "icon", icon || "removed"); if (icon) page.icon = icon; else delete page.icon; }
    if (widthChanged) { if (input.fullWidth) page.fullWidth = true; else delete page.fullWidth; }
    return this.commit(page, author);
  }

  /** A bot replacing the whole page from markdown. Unchanged blocks keep
   * their ids, comments and authors. */
  write(botId: string, pageId: string, input: { markdown: string; title?: unknown; icon?: unknown }, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    if (page.trashedAt) fail(409, "this page is in the trash");
    const split = splitMarkdownTitle(input.markdown);
    const usesTitle = split.title !== undefined && (input.title === undefined || validateTitle(input.title) === validateTitle(split.title));
    const blocks = reconcileBlockIds(page.blocks, markdownToBlocks(usesTitle ? split.body : input.markdown));
    return this.save(botId, pageId, {
      baseRevision: page.revision, blocks,
      title: input.title ?? (usesTitle ? split.title : undefined), icon: input.icon,
    }, author);
  }

  edit(botId: string, pageId: string, ops: PageEditOp[], author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    if (page.trashedAt) fail(409, "this page is in the trash");
    return this.save(botId, pageId, { baseRevision: page.revision, blocks: applyPageEdits(page.blocks, ops) }, author);
  }

  setPinned(botId: string, pageId: string, pinned: boolean, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    if (Boolean(page.pinned) === pinned) return page;
    if (pinned) page.pinned = true; else delete page.pinned;
    this.log(page, author, pinned ? "pinned" : "unpinned");
    this.persist(page);
    this.onChange({ botId, pageId, revision: page.revision, by: author });
    return page;
  }

  setTrashed(botId: string, pageId: string, trashed: boolean, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    if (Boolean(page.trashedAt) === trashed) return page;
    if (trashed) page.trashedAt = this.now(); else delete page.trashedAt;
    this.log(page, author, trashed ? "trashed" : "untrashed");
    this.persist(page);
    this.onChange({ botId, pageId, revision: page.revision, by: author });
    return page;
  }

  destroy(botId: string, pageId: string, author: PageAuthor) {
    const page = this.get(botId, pageId);
    rmSync(join(this.dir(botId), `${page.id}.json`), { force: true });
    rmSync(join(this.dir(botId), `${page.id}.assets`), { recursive: true, force: true });
    this.pages(botId).delete(page.id);
    this.onChange({ botId, pageId, revision: page.revision, by: author, deleted: true });
  }

  viewed(botId: string, pageId: string, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    const last = [...page.activity].reverse().find(a => a.action === "viewed" && a.author.id === author.id);
    if (!last || this.now() - last.at > VIEW_GAP_MS) {
      this.log(page, author, "viewed");
      this.persist(page);
    }
    return page;
  }

  restoreVersion(botId: string, pageId: string, versionId: string, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    const version = page.versions.find(v => v.id === versionId) ?? fail(404, "no such version");
    this.checkpoint(page, "before-restore");
    page.attribution = attributeBlocks(page.attribution, version.blocks, author, this.now());
    page.blocks = version.blocks;
    page.title = version.title;
    if (version.icon) page.icon = version.icon; else delete page.icon;
    this.log(page, author, "restored", `checkpoint #${version.n}`);
    return this.commit(page, author);
  }

  comment(botId: string, pageId: string, input: { blockId?: unknown; quote?: unknown; text?: unknown }, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > PAGE_LIMITS.commentChars) fail(400, "a comment needs 1–4000 characters of text");
    if (page.comments.length >= PAGE_LIMITS.comments) fail(409, "this page has too many comments; resolve and delete some first");
    const blockId = typeof input.blockId === "string" && page.blocks.some(b => b.id === input.blockId) ? input.blockId : page.blocks[0]?.id ?? "";
    const quote = typeof input.quote === "string" ? input.quote.slice(0, 500) : "";
    page.comments.push({ id: newCommentId(), blockId, quote, text, author, at: this.now(), replies: [] });
    this.log(page, author, "commented", text.slice(0, 80));
    return this.commit(page, author);
  }

  updateComment(botId: string, pageId: string, commentId: string, input: { reply?: unknown; resolved?: unknown; delete?: unknown }, author: PageAuthor): PageRecord {
    const page = this.get(botId, pageId);
    const comment = page.comments.find(c => c.id === commentId) ?? fail(404, "no such comment");
    if (input.delete === true) {
      if (comment.author.id !== author.id && author.kind === "bot") fail(403, "only the person can delete someone else's comment");
      page.comments = page.comments.filter(c => c.id !== commentId);
      return this.commit(page, author);
    }
    if (typeof input.reply === "string") {
      const text = input.reply.trim();
      if (!text || text.length > PAGE_LIMITS.commentChars) fail(400, "a reply needs 1–4000 characters of text");
      if (comment.replies.length >= PAGE_LIMITS.replies) fail(409, "this thread has too many replies");
      comment.replies.push({ id: newCommentId(), text, author, at: this.now() });
      this.log(page, author, "replied", text.slice(0, 80));
    }
    if (typeof input.resolved === "boolean" && input.resolved !== Boolean(comment.resolved)) {
      if (input.resolved) comment.resolved = { by: author, at: this.now() }; else delete comment.resolved;
      this.log(page, author, input.resolved ? "resolved" : "reopened", comment.text.slice(0, 80));
    }
    return this.commit(page, author);
  }

  saveAsset(botId: string, pageId: string, mime: string, data: Buffer): string {
    const page = this.get(botId, pageId);
    const ext = IMAGE_MIME[mime] ?? fail(415, "only png, jpeg, gif and webp images can be added to a page");
    if (!data.length || data.length > PAGE_LIMITS.assetBytes) fail(413, "images must be under 6 MB");
    const sniff = data.subarray(0, 12);
    const isPng = sniff[0] === 0x89 && sniff[1] === 0x50, isJpg = sniff[0] === 0xff && sniff[1] === 0xd8;
    const isGif = sniff.subarray(0, 3).toString("latin1") === "GIF", isWebp = sniff.subarray(8, 12).toString("latin1") === "WEBP";
    if (!({ png: isPng, jpg: isJpg, gif: isGif, webp: isWebp } as Record<string, boolean>)[ext]) fail(415, "the image does not match its type");
    const name = `${newPageId().slice(2)}.${ext}`;
    const dir = join(this.dir(botId), `${page.id}.assets`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, name), data, { mode: 0o600 });
    return `asset:${name}`;
  }

  readAsset(botId: string, pageId: string, name: string): { mime: string; data: Buffer } {
    const page = this.get(botId, pageId);
    if (!ASSET_NAME_RE.test(name)) fail(404, "no such image");
    const file = join(this.dir(botId), `${page.id}.assets`, name);
    if (!existsSync(file)) fail(404, "no such image");
    return { mime: ASSET_MIME[name.split(".").pop()!]!, data: readFileSync(file) };
  }

  markdown(botId: string, pageId: string): string {
    const page = this.get(botId, pageId);
    return `# ${page.icon ? `${page.icon} ` : ""}${page.title || "Untitled page"}\n\n${blocksToMarkdown(page.blocks)}`;
  }
}
