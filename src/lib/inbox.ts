// Needs-me inbox and daily digest: the pure half of the view. Fetches
// tolerate a server without the endpoints (404, or the SPA fallback page)
// and read as "nothing needs you" rather than an error.
import type {
  DigestChange,
  DigestMove,
  DigestResponse,
  InboxItem,
  InboxKind,
  InboxResponse,
} from "../../shared/wire";
import type { LocaleKey } from "@/locales";
import { api, ApiError } from "@/state/store";
import { t } from "./i18n";

export type { DigestChange, DigestMove, DigestResponse, InboxItem, InboxKind, InboxResponse };

export const DIGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

const INBOX_KINDS: readonly InboxKind[] = ["waiting-on-you", "question", "failed", "unread"];
const DIGEST_CHANGES: readonly DigestChange[] = ["done", "started", "closed", "failed"];

export const EMPTY_INBOX: InboxResponse = { items: [], count: 0 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const time = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A count the badge can show: whole, never negative. */
export function inboxCountOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** "" hides the badge. */
export function inboxBadge(count: number): string {
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

function inboxItemOf(raw: unknown): InboxItem | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind as InboxKind;
  if (!INBOX_KINDS.includes(kind) || !text(raw.id) || !text(raw.threadId)) return null;
  const item: InboxItem = {
    id: text(raw.id),
    kind,
    botId: text(raw.botId),
    threadId: text(raw.threadId),
    title: text(raw.title),
    preview: text(raw.preview),
    at: time(raw.at),
  };
  if (text(raw.groupId)) item.groupId = text(raw.groupId);
  return item;
}

/** Keep only well-formed rows, newest first. */
export function normalizeInbox(raw: unknown): InboxResponse {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return EMPTY_INBOX;
  const items = raw.items.flatMap((entry) => inboxItemOf(entry) ?? []).sort((a, b) => b.at - a.at);
  return { items, count: raw.count === undefined ? items.length : inboxCountOf(raw.count) };
}

function digestMoveOf(raw: unknown): DigestMove | null {
  if (!isRecord(raw)) return null;
  const change = raw.change as DigestChange;
  if (!DIGEST_CHANGES.includes(change) || !text(raw.threadId)) return null;
  const move: DigestMove = {
    botId: text(raw.botId),
    threadId: text(raw.threadId),
    title: text(raw.title),
    change,
    summary: text(raw.summary),
    at: time(raw.at),
  };
  if (text(raw.groupId)) move.groupId = text(raw.groupId);
  return move;
}

/** null when the body is not a digest at all. */
export function normalizeDigest(raw: unknown): DigestResponse | null {
  if (!isRecord(raw) || !isRecord(raw.counts)) return null;
  const counts = raw.counts;
  return {
    since: time(raw.since),
    until: time(raw.until),
    counts: {
      done: inboxCountOf(counts.done),
      started: inboxCountOf(counts.started),
      closed: inboxCountOf(counts.closed),
      failed: inboxCountOf(counts.failed),
      waiting: inboxCountOf(counts.waiting),
    },
    moved: (Array.isArray(raw.moved) ? raw.moved : [])
      .flatMap((entry) => digestMoveOf(entry) ?? [])
      .sort((a, b) => b.at - a.at),
  };
}

/** The server predates the endpoint. */
const missing = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405);

type Request = (path: string) => Promise<unknown>;

export async function fetchInbox(request: Request = api): Promise<InboxResponse> {
  try {
    return normalizeInbox(await request("/api/inbox"));
  } catch (error) {
    if (missing(error)) return EMPTY_INBOX;
    throw error;
  }
}

export async function fetchDigest(since?: number, request: Request = api): Promise<DigestResponse | null> {
  const query = since === undefined ? "" : `?since=${Math.floor(since)}`;
  try {
    return normalizeDigest(await request(`/api/digest${query}`));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Most urgent first; within a kind the server's newest-first order holds. */
export function groupInboxItems(items: readonly InboxItem[]): Array<{ kind: InboxKind; items: InboxItem[] }> {
  return INBOX_KINDS.flatMap((kind) => {
    const rows = items.filter((item) => item.kind === kind);
    return rows.length ? [{ kind, items: rows }] : [];
  });
}

const KIND_LABEL: Record<InboxKind, LocaleKey> = {
  "waiting-on-you": "needsMe.kind.waiting",
  question: "needsMe.kind.question",
  failed: "needsMe.kind.failed",
  unread: "needsMe.kind.unread",
};

export const inboxKindLabel = (kind: InboxKind): string => t(KIND_LABEL[kind]);

const CHANGE_LABEL: Record<DigestChange, LocaleKey> = {
  done: "needsMe.digest.done",
  started: "needsMe.digest.started",
  closed: "needsMe.digest.closed",
  failed: "needsMe.digest.failed",
};

export const digestChangeLabel = (change: DigestChange): string => t(CHANGE_LABEL[change]);

/** The counts row, in reading order; `waiting` is what is still open. */
export function digestCountEntries(counts: DigestResponse["counts"]): Array<{ key: keyof DigestResponse["counts"]; label: string; value: number }> {
  return (["done", "started", "closed", "failed", "waiting"] as const).map((key) => ({
    key,
    label: t(key === "waiting" ? "needsMe.digest.waiting" : CHANGE_LABEL[key]),
    value: counts[key],
  }));
}

export function inboxRelativeTime(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 90) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("remote.time.hours", { count: hours });
  return t("remote.time.days", { count: Math.round(hours / 24) });
}
