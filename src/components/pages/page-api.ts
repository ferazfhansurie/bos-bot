// The editor's side of /api/pages. Cookies carry the owner session, so image
// tags and download links can point straight at these routes.
import type { PageBlock, PageRecord, PageSummary } from "../../../shared/page";

export class PageApiError extends Error {
  constructor(message: string, readonly status: number, readonly page?: PageRecord) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PageApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body.page);
  return body as T;
}

const base = (botId: string) => `/api/pages/${encodeURIComponent(botId)}`;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const pageApi = {
  list: (botId: string, options: { trash?: boolean; query?: string } = {}) => {
    const q = new URLSearchParams();
    if (options.trash) q.set("trash", "1");
    if (options.query?.trim()) q.set("q", options.query.trim());
    return call<{ pages: PageSummary[] }>(`${base(botId)}${q.size ? `?${q}` : ""}`).then(r => r.pages);
  },
  create: (botId: string, input: { title?: string; icon?: string; markdown?: string; blocks?: PageBlock[]; threadId?: string }) =>
    call<{ page: PageRecord }>(base(botId), json("POST", input)).then(r => r.page),
  get: (botId: string, pageId: string, view = false) =>
    call<{ page: PageRecord }>(`${base(botId)}/${pageId}${view ? "?view=1" : ""}`).then(r => r.page),
  save: (botId: string, pageId: string, input: { baseRevision: number; blocks?: PageBlock[]; title?: string; icon?: string | null; fullWidth?: boolean }) =>
    call<{ page: PageRecord }>(`${base(botId)}/${pageId}`, json("PUT", input)).then(r => r.page),
  patch: (botId: string, pageId: string, input: { pinned?: boolean; trashed?: boolean }) =>
    call<{ page: PageRecord }>(`${base(botId)}/${pageId}`, json("PATCH", input)).then(r => r.page),
  destroy: (botId: string, pageId: string) => call<{ ok: true }>(`${base(botId)}/${pageId}`, { method: "DELETE" }),
  restore: (botId: string, pageId: string, versionId: string) =>
    call<{ page: PageRecord }>(`${base(botId)}/${pageId}/versions/${versionId}/restore`, json("POST", {})).then(r => r.page),
  comment: (botId: string, pageId: string, input: { blockId: string; quote: string; text: string }) =>
    call<{ page: PageRecord }>(`${base(botId)}/${pageId}/comments`, json("POST", input)).then(r => r.page),
  updateComment: (botId: string, pageId: string, commentId: string, input: { reply?: string; resolved?: boolean; delete?: boolean }) =>
    call<{ page: PageRecord }>(`${base(botId)}/${pageId}/comments/${commentId}`, json("POST", input)).then(r => r.page),
  uploadAsset: async (botId: string, pageId: string, file: Blob) => {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
      reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
      reader.readAsDataURL(file);
    });
    return call<{ src: string }>(`${base(botId)}/${pageId}/assets`, json("POST", { mime: file.type, data })).then(r => r.src);
  },
  assetUrl: (botId: string, pageId: string, src: string) =>
    src.startsWith("asset:") ? `${base(botId)}/${pageId}/assets/${encodeURIComponent(src.slice(6))}` : src,
  exportUrl: (botId: string, pageId: string, format: "md" | "html" | "docx", inline = false) =>
    `${base(botId)}/${pageId}/export?format=${format}${inline ? "&inline=1" : ""}`,
};

/** Fired by the store when the server says a page changed. */
export interface PageChangedDetail { botId: string; pageId: string; revision: number; byKind: "human" | "bot"; deleted?: boolean }
export const PAGE_CHANGED_EVENT = "bos-page-changed";
