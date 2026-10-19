// HTTP for pages. Owner routes serve the editor and refuse peers and revoked
// sessions the same way output drafts do; internal routes are the bot's page
// tools and only ever reach the calling bot's own pages, from direct
// conversations (a room can hold clients, so pages never surface there).
import { messageFileDisposition } from "./message-file.ts";
import { pageDocx, pageFileName, pageHtml, pageMarkdownFile } from "./page-export.ts";
import type { PageStore } from "./pages.ts";
import { PAGE_LIMITS, pageForBot, pageSummary, type PageAuthor, type PageEditOp, type PageRecord } from "../shared/page.ts";

export interface PageHttp {
  readBody: (limit: number) => Promise<any>;
  json: (status: number, body: unknown) => void;
  send: (status: number, headers: Record<string, string>, body: Buffer | string) => void;
}

export interface OwnerPageDeps extends PageHttp {
  pages: PageStore;
  /** Throws unless the request is the owner on a live, non-peer session. */
  assertOwner: () => void;
  owner: () => PageAuthor;
  botExists: (botId: string) => boolean;
  /** The bot owning a direct (non-room) conversation, or null. */
  directBotOf: (threadId: string) => string | null;
}

const MAX_SAVE_BYTES = PAGE_LIMITS.pageJsonBytes + 100_000;

async function guarded(http: PageHttp, run: () => Promise<void> | void): Promise<true> {
  try { await run(); }
  catch (error) {
    const e = error as Error & { status?: number; page?: PageRecord };
    http.json(e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message, ...(e.page ? { page: e.page } : {}) });
  }
  return true;
}

export async function handleOwnerPageRoute(method: string, path: string, query: URLSearchParams, deps: OwnerPageDeps): Promise<boolean> {
  const m = path.match(/^\/api\/pages\/([\w-]+)(?:\/(p-[a-z0-9]+)(?:\/(export|versions|comments|assets)(?:\/([\w.-]+))?(?:\/(restore))?)?)?$/);
  if (!m) return false;
  const [, botId, pageId, sub, subId, action] = m;
  return guarded(deps, async () => {
    deps.assertOwner();
    if (!deps.botExists(botId!)) return deps.json(404, { error: "no such bot" });
    const owner = deps.owner();
    const body = async (limit = 64_000) => {
      const value = method === "GET" || method === "DELETE" ? {} : await deps.readBody(limit);
      deps.assertOwner();
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    };
    if (!pageId) {
      if (method === "GET") return deps.json(200, { pages: deps.pages.list(botId!, { trash: query.get("trash") === "1", query: query.get("q") ?? undefined }) });
      if (method === "POST") {
        const input = await body(MAX_SAVE_BYTES);
        const threadId = typeof input.threadId === "string" && deps.directBotOf(input.threadId) === botId ? input.threadId : undefined;
        const page = deps.pages.create(botId!, { title: input.title, icon: input.icon, blocks: input.blocks, markdown: input.markdown, threadId }, owner);
        return deps.json(200, { page });
      }
      return deps.json(405, { error: "method not allowed" });
    }
    if (!sub) {
      if (method === "GET") {
        const page = query.get("view") === "1" ? deps.pages.viewed(botId!, pageId, owner) : deps.pages.get(botId!, pageId);
        return deps.json(200, { page });
      }
      if (method === "PUT") {
        const input = await body(MAX_SAVE_BYTES);
        return deps.json(200, { page: deps.pages.save(botId!, pageId, input, owner) });
      }
      if (method === "PATCH") {
        const input = await body();
        let page = deps.pages.get(botId!, pageId);
        if (typeof input.pinned === "boolean") page = deps.pages.setPinned(botId!, pageId, input.pinned, owner);
        if (typeof input.trashed === "boolean") page = deps.pages.setTrashed(botId!, pageId, input.trashed, owner);
        return deps.json(200, { page });
      }
      if (method === "DELETE") {
        const page = deps.pages.get(botId!, pageId);
        if (!page.trashedAt) return deps.json(409, { error: "move the page to the trash first" });
        deps.pages.destroy(botId!, pageId, owner);
        return deps.json(200, { ok: true });
      }
      return deps.json(405, { error: "method not allowed" });
    }
    if (sub === "export" && method === "GET") {
      const page = deps.pages.get(botId!, pageId);
      const assets = (name: string) => { try { return deps.pages.readAsset(botId!, pageId, name); } catch { return null; } };
      const format = query.get("format") ?? "md";
      const disposition = (ext: string) => query.get("inline") === "1" ? "inline" : messageFileDisposition(pageFileName(page, ext));
      const common = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
      if (format === "md") return deps.send(200, { ...common, "content-type": "text/markdown; charset=utf-8", "content-disposition": disposition("md") }, pageMarkdownFile(page));
      if (format === "html") return deps.send(200, { ...common, "content-type": "text/html; charset=utf-8", "content-disposition": disposition("html"), "content-security-policy": "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'" }, pageHtml(page, assets));
      if (format === "docx") return deps.send(200, { ...common, "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-disposition": disposition("docx") }, await pageDocx(page, assets));
      return deps.json(400, { error: "format must be md, html or docx" });
    }
    if (sub === "versions" && subId && action === "restore" && method === "POST") {
      await body(1024);
      return deps.json(200, { page: deps.pages.restoreVersion(botId!, pageId, subId, owner) });
    }
    if (sub === "comments" && method === "POST") {
      const input = await body(16_000);
      const page = subId
        ? deps.pages.updateComment(botId!, pageId, subId, input, owner)
        : deps.pages.comment(botId!, pageId, input, owner);
      return deps.json(200, { page });
    }
    if (sub === "assets" && !subId && method === "POST") {
      const input = await body(Math.ceil(PAGE_LIMITS.assetBytes * 1.4) + 4096);
      if (typeof input.data !== "string" || typeof input.mime !== "string") return deps.json(400, { error: "mime and base64 data required" });
      const src = deps.pages.saveAsset(botId!, pageId, input.mime, Buffer.from(input.data, "base64"));
      return deps.json(200, { src });
    }
    if (sub === "assets" && subId && method === "GET") {
      const asset = deps.pages.readAsset(botId!, pageId, subId);
      return deps.send(200, { "content-type": asset.mime, "content-disposition": "inline", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" }, asset.data);
    }
    return deps.json(405, { error: "method not allowed" });
  });
}

export interface InternalPageDeps extends PageHttp {
  pages: PageStore;
  botId: string;
  threadId: string;
  bot: PageAuthor;
  inRoom: boolean;
  requireActive: () => void;
}

const editOps = new Set(["replace", "insert_after", "insert_before", "append", "prepend", "delete", "check"]);

function parseOps(input: unknown): PageEditOp[] {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw Object.assign(new Error("edits must list 1–100 operations"), { status: 400 });
  return input.map((raw, index) => {
    const op = raw as Record<string, unknown>;
    if (!op || typeof op !== "object" || !editOps.has(String(op.op))) throw Object.assign(new Error(`edit ${index + 1}: op must be one of ${[...editOps].join(", ")}`), { status: 400 });
    const needsBlock = !["append", "prepend"].includes(String(op.op));
    if (needsBlock && typeof op.block_id !== "string") throw Object.assign(new Error(`edit ${index + 1}: block_id is required`), { status: 400 });
    const needsMarkdown = !["delete", "check"].includes(String(op.op));
    if (needsMarkdown && typeof op.markdown !== "string") throw Object.assign(new Error(`edit ${index + 1}: markdown is required`), { status: 400 });
    return { op: op.op, blockId: op.block_id, markdown: op.markdown, checked: op.checked === true } as PageEditOp;
  });
}

export async function handleInternalPageRoute(method: string, path: string, query: URLSearchParams, deps: InternalPageDeps): Promise<boolean> {
  const m = path.match(/^\/api\/internal\/pages(?:\/(p-[a-z0-9]+)(?:\/(write|edit|comment))?)?$/);
  if (!m) return false;
  const [, pageId, action] = m;
  return guarded(deps, async () => {
    if (deps.inRoom) return deps.json(403, { error: "pages are private to the owner and are not available in rooms" });
    const { pages, botId, bot } = deps;
    if (pageId && pages.get(botId, pageId).threadId !== deps.threadId) return deps.json(404, { error: "no such page in this conversation" });
    const body = async () => {
      const value = await deps.readBody(MAX_SAVE_BYTES);
      deps.requireActive();
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    };
    const brief = (page: PageRecord) => ({ ...pageSummary(page), text: pageForBot(page, botId) });
    if (!pageId && method === "GET") {
      return deps.json(200, { pages: pages.list(botId, { query: query.get("q") ?? undefined }).filter(p => p.threadId === deps.threadId).slice(0, 100) });
    }
    if (!pageId && method === "POST") {
      const input = await body();
      if (typeof input.markdown !== "string" && input.markdown !== undefined) return deps.json(400, { error: "markdown must be text" });
      const page = pages.create(botId, { title: input.title, icon: input.icon, markdown: input.markdown ?? "", threadId: deps.threadId }, bot);
      return deps.json(200, { page: brief(page) });
    }
    if (pageId && !action && method === "GET") return deps.json(200, { page: brief(pages.get(botId, pageId)) });
    if (pageId && action === "write" && method === "POST") {
      const input = await body();
      if (typeof input.markdown !== "string") return deps.json(400, { error: "markdown is required" });
      if (input.base_revision !== pages.get(botId, pageId).revision) return deps.json(409, { error: "page changed; read it again and use its revision as base_revision" });
      return deps.json(200, { page: brief(pages.write(botId, pageId, { markdown: input.markdown, title: input.title, icon: input.icon }, bot)) });
    }
    if (pageId && action === "edit" && method === "POST") {
      const input = await body();
      if (input.base_revision !== pages.get(botId, pageId).revision) return deps.json(409, { error: "page changed; read it again and use its revision as base_revision" });
      let page = pages.edit(botId, pageId, parseOps(input.edits), bot);
      if (input.title !== undefined || input.icon !== undefined) page = pages.save(botId, pageId, { baseRevision: page.revision, title: input.title, icon: input.icon }, bot);
      return deps.json(200, { page: brief(page) });
    }
    if (pageId && action === "comment" && method === "POST") {
      const input = await body();
      const page = typeof input.comment_id === "string"
        ? pages.updateComment(botId, pageId, input.comment_id, { reply: input.text, resolved: input.resolve === true ? true : undefined }, bot)
        : pages.comment(botId, pageId, { blockId: input.block_id, quote: input.quote, text: input.text }, bot);
      return deps.json(200, { page: brief(page) });
    }
    return deps.json(405, { error: "method not allowed" });
  });
}
