/**
 * Remote bot bridge: a linked Mac's bots shown here as ordinary bots.
 *
 * Home A (this server) holds a client-scoped session on home B. The bridge
 * gives every bot B shares a virtual id on A (`rb-<homeKey>-<remoteBotId>`),
 * relays B's event stream for the threads the bridge itself created there
 * (`rt-<homeKey>-<remoteThreadId>`), and proxies the chat routes so the
 * desktop and iOS clients render these bots with no special path.
 *
 * PRIVACY (hard rule): only threads this bridge created on B are exposed.
 * The owner of B keeps private threads with the same bots; B's stream and
 * snapshots carry them, so every inbound frame, page and response body is
 * filtered here by the persisted set of bridge-created thread ids. Nothing
 * that is not on that list is relayed, cached, persisted or fetched.
 *
 * Threads are opened on B lazily, by the first real send (or an explicit
 * new-task request), never on connect; each one is reset to Ask with no
 * standing grants before use, and standing grants never cross the bridge.
 *
 * The link token never leaves this module except as B's Authorization header.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import type { Notification } from "../shared/notification.ts";
import {
  REMOTE_BOT_UNAVAILABLE,
  type BotQueuedMessages,
  type RemoteBotOrigin,
  type WireBot,
  type WireMessage,
  type WireTask,
} from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";
import { messageImageTargetAt } from "./message-file.ts";

export interface BridgeLink {
  homeId: string;
  /** https://<host>.ts.net — validated by MultiplayerLinks. */
  origin: string;
  /** Client-scoped session on the other home. Server-side only. */
  token: string;
  name: string;
  ownerName: string | null;
}

export interface RemoteBotBridgeOptions {
  file: string;
  links: () => BridgeLink[];
  replaceLinkToken?: (homeId: string, token: string) => void;
  broadcast: (frame: Record<string, unknown>) => void;
  notify?: (notification: Notification) => void;
  /** The merged bot.queued snapshot changed. */
  queuesChanged?: () => void;
  /** This home's owner, used to title the threads the bridge opens on B. */
  localOwnerName: () => string;
  /** This home's attachment directory: the only files a send may re-upload. */
  attachmentsDir: string;
  /** Canonical mime for a shared-file extension, or null when unsupported. */
  fileMime: (extension: string) => string | null;
  fetcher?: typeof fetch;
  reconnectDelaysMs?: number[];
  /** Reconnect when the stream is silent this long (B pings every 15s). */
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Bound on a GET /api/bots path that has to ask B before answering. */
  listTimeoutMs?: number;
  log?: (message: string) => void;
}

export type BridgeResponse =
  | { status: number; json: unknown }
  | { status: number; headers: Record<string, string>; bytes: Buffer };

/** A bot's display fields. Everything else B knows (soul, cwd, peers, ...) stays there. */
interface SafeBot {
  name: string;
  title: string;
  description: string;
  color: string;
  mascotExpression?: string | null;
  mascotBody?: string | null;
  avatarUrl: string | null;
  avatarCrop?: string;
  modelSelection: WireBot["modelSelection"];
  approvalMode?: WireBot["approvalMode"];
  autoApprove?: boolean;
  notifications: boolean;
  createdAt: number;
}

interface ThreadEntry {
  botId: string;
  createdAt: number;
  /** Internal shared-room turn; never exposed as this bot's private chat. */
  room?: true;
  /** Last display snapshot, keyed by B's thread id. */
  task?: WireTask;
}

interface HomeState {
  threads: Record<string, ThreadEntry>;
  selected: Record<string, string>;
  pinned: Record<string, true>;
  bots: Record<string, SafeBot>;
  attachments: string[];
}

interface Snapshot {
  version: 1;
  homes: Record<string, HomeState>;
}

interface ThreadCache {
  messages: WireMessage[];
  hasMore: boolean;
  activeLeafId: string | null;
  hydrated: boolean;
}

interface Home {
  link: BridgeLink;
  key: string;
  state: HomeState;
  cursor: string | null;
  running: boolean;
  connected: boolean;
  peerMigrated?: boolean;
  abort: AbortController | null;
  wake: (() => void) | null;
  snapshotAt: number;
  /** B's own selection per bot, memory only: used to restore it after a create. */
  remoteSelected: Map<string, string>;
  cache: Map<string, ThreadCache>;
  queues: BotQueuedMessages;
  creating: Map<string, Promise<string>>;
  hydrating: Map<string, Promise<void>>;
}

const ID = /^[\w-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHMENT_NAME = /^[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/;
const IMAGE_MIMES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const TAG = /^<(attached-image|attached-file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/gm;
/** Session labels the linking flows give the bridge's session on B. */
const BRIDGE_SENDER = /^BOS (?:multiplayer bridge|team link|team bridge)$/;
const PAGE_MAX = 200;
const CACHE_MAX = 200;
const MAX_ATTACHMENT_NAMES = 2000;
const UPLOAD_MAX_BYTES = 26 * 1024 * 1024;
/** A bot frame emitted before a create can arrive after it; do not unmap on it. */
const FRESH_THREAD_MS = 60_000;

export const homeKey = (homeId: string): string => createHash("sha256").update(homeId).digest("hex").slice(0, 12);
export const isRemoteBotPath = (path: string): boolean => /^\/api\/(?:bots\/rb-|threads\/rt-)[\w-]+(?:\/|$)/.test(path);

const isObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** A one-off answer to an approval or question: never a standing grant. */
const oneOffAnswer = (input: Record<string, any>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of ["requestId", "behavior", "message", "reviewedSha256"]) if (input[key] !== undefined) out[key] = input[key];
  return out;
};

/** A bot the other Mac itself relays from a third home (or from this one):
 * bridging it again would loop threads through two bridges. */
const relayed = (raw: Record<string, any>): boolean => raw.remote !== undefined || /^rb-[0-9a-f]{12}-/.test(String(raw.id));
const refused = (): BridgeResponse => ({ status: 403, json: { error: REMOTE_BOT_UNAVAILABLE } });
const failure = (status: number, error: string): BridgeResponse => ({ status, json: { error } });

class BridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}
function decodeAttribute(value: string): string {
  return value.replace(/&(quot|lt|gt|amp);|&#(9|10|13);/g, (entity, named?: string, numeric?: string) =>
    numeric === "9" ? "\t" : numeric === "10" ? "\n" : numeric === "13" ? "\r"
      : named === "quot" ? '"' : named === "lt" ? "<" : named === "gt" ? ">" : named === "amp" ? "&" : entity);
}

function safeBot(raw: Record<string, any>, previous?: SafeBot): SafeBot {
  const avatar = typeof raw.avatarUrl === "string" && ATTACHMENT_NAME.test(raw.avatarUrl.replace(/^\/api\/attachments\//, "")) &&
    raw.avatarUrl.startsWith("/api/attachments/") ? raw.avatarUrl : null;
  const model = isObject(raw.modelSelection) && typeof raw.modelSelection.instanceId === "string" && typeof raw.modelSelection.model === "string"
    ? { instanceId: raw.modelSelection.instanceId, model: raw.modelSelection.model,
        ...(typeof raw.modelSelection.effort === "string" ? { effort: raw.modelSelection.effort } : {}),
        ...(typeof raw.modelSelection.variant === "string" ? { variant: raw.modelSelection.variant } : {}) }
    : previous?.modelSelection ?? { instanceId: "remote", model: "remote" };
  return {
    name: typeof raw.name === "string" ? raw.name.slice(0, 100) : previous?.name ?? "Bot",
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : previous?.title ?? "",
    description: typeof raw.description === "string" ? raw.description.slice(0, 4000) : previous?.description ?? "",
    color: typeof raw.color === "string" ? raw.color : previous?.color ?? "blue",
    ...(raw.mascotExpression === null || typeof raw.mascotExpression === "string" ? { mascotExpression: raw.mascotExpression } : {}),
    ...(raw.mascotBody === null || typeof raw.mascotBody === "string" ? { mascotBody: raw.mascotBody } : {}),
    avatarUrl: avatar,
    ...(typeof raw.avatarCrop === "string" ? { avatarCrop: raw.avatarCrop } : {}),
    modelSelection: model as SafeBot["modelSelection"],
    ...(typeof raw.approvalMode === "string" ? { approvalMode: raw.approvalMode as SafeBot["approvalMode"] } : {}),
    ...(typeof raw.autoApprove === "boolean" ? { autoApprove: raw.autoApprove } : {}),
    notifications: typeof raw.notifications === "boolean" ? raw.notifications : previous?.notifications ?? true,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : previous?.createdAt ?? Date.now(),
  };
}

const TASK_FIELDS = ["title", "createdAt", "titleFromFirstMessage", "archivedAt", "modelSelection", "approvalMode", "autoApprove",
  "unread", "rewound", "pinnedMessageId", "activity", "busy", "turnStartedAt", "usage"] as const;
function safeTask(raw: Record<string, any>): WireTask {
  const task: Record<string, unknown> = { threadId: String(raw.threadId) };
  for (const field of TASK_FIELDS) if (raw[field] !== undefined) task[field] = raw[field];
  if (typeof task.title !== "string") task.title = "Linked chat";
  if (typeof task.createdAt !== "number") task.createdAt = Date.now();
  return task as unknown as WireTask;
}

function emptyState(): HomeState {
  return { threads: {}, selected: {}, pinned: {}, bots: {}, attachments: [] };
}

function cleanState(value: unknown): HomeState {
  const state = emptyState();
  if (!isObject(value)) return state;
  if (isObject(value.threads)) {
    for (const [threadId, entry] of Object.entries(value.threads)) {
      if (!ID.test(threadId) || !isObject(entry) || typeof entry.botId !== "string" || !ID.test(entry.botId)) continue;
      state.threads[threadId] = {
        botId: entry.botId,
        createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
        ...(isObject(entry.task) ? { task: safeTask({ ...entry.task, threadId }) } : {}),
      };
    }
  }
  if (isObject(value.selected)) {
    for (const [botId, threadId] of Object.entries(value.selected)) {
      if (typeof threadId === "string" && state.threads[threadId]?.botId === botId) state.selected[botId] = threadId;
    }
  }
  if (isObject(value.pinned)) for (const botId of Object.keys(value.pinned)) if (ID.test(botId)) state.pinned[botId] = true;
  if (isObject(value.bots)) {
    for (const [botId, bot] of Object.entries(value.bots)) if (ID.test(botId) && isObject(bot)) state.bots[botId] = safeBot(bot);
  }
  if (Array.isArray(value.attachments)) {
    state.attachments = value.attachments.filter((name): name is string => typeof name === "string" && ATTACHMENT_NAME.test(name)).slice(-MAX_ATTACHMENT_NAMES);
  }
  return state;
}

export class RemoteBotBridge {
  private readonly options: RemoteBotBridgeOptions;
  private readonly fetcher: typeof fetch;
  private readonly homes = new Map<string, Home>();
  private readonly saved = new Map<string, HomeState>();
  private readonly sends = new Map<string, Promise<BridgeResponse>>();
  private stopped = true;

  constructor(options: RemoteBotBridgeOptions) {
    this.options = options;
    this.fetcher = options.fetcher ?? fetch;
    if (!existsSync(options.file)) return;
    try {
      const snapshot = JSON.parse(readFileSync(options.file, "utf8")) as Snapshot;
      if (snapshot?.version === 1 && isObject(snapshot.homes)) {
        for (const [homeId, state] of Object.entries(snapshot.homes)) this.saved.set(homeId, cleanState(state));
      }
    } catch {
      this.log("remote bot map is unreadable; starting with no remote threads");
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    this.stopped = false;
    this.sync();
  }

  stop(): void {
    this.stopped = true;
    for (const home of this.homes.values()) {
      home.running = false;
      home.abort?.abort();
      home.wake?.();
    }
  }

  /** Match runtimes to the current links; starts a stream for a new link. */
  sync(): void {
    const links = this.options.links();
    const wanted = new Set(links.map((link) => link.homeId));
    for (const [homeId, home] of this.homes) {
      if (wanted.has(homeId)) continue;
      home.running = false;
      home.abort?.abort();
      home.wake?.();
      this.homes.delete(homeId);
      for (const botId of Object.keys(home.state.bots)) this.options.broadcast({ kind: "bot.deleted", botId: this.botId(home, botId) });
    }
    for (const link of links) {
      let home = this.homes.get(link.homeId);
      if (home) {
        home.link = link;
      } else {
        home = {
          link, key: homeKey(link.homeId), state: this.saved.get(link.homeId) ?? emptyState(),
          cursor: null, running: false, connected: false, abort: null, wake: null, snapshotAt: 0,
          remoteSelected: new Map(), cache: new Map(), queues: {}, creating: new Map(), hydrating: new Map(),
        };
        this.saved.set(link.homeId, home.state);
        this.homes.set(link.homeId, home);
      }
      if (!this.stopped && !home.running) {
        home.running = true;
        void this.streamLoop(home);
      }
    }
  }

  // ── ids ───────────────────────────────────────────────────────────────

  private botId(home: Home, remoteBotId: string): string { return `rb-${home.key}-${remoteBotId}`; }
  private threadId(home: Home, remoteThreadId: string): string { return `rt-${home.key}-${remoteThreadId}`; }
  private placeholder(home: Home, remoteBotId: string): string { return `rt-${home.key}-pending-${remoteBotId}`; }

  private parse(id: string, prefix: "rb" | "rt"): { home: Home; remoteId: string } | null {
    const match = new RegExp(`^${prefix}-([0-9a-f]{12})-([\\w-]{1,128})$`).exec(id);
    if (!match) return null;
    for (const home of this.homes.values()) if (home.key === match[1]) return { home, remoteId: match[2]! };
    return null;
  }

  /** Virtual thread id for a B thread, only when the bridge created it. */
  private mapped(home: Home, remoteThreadId: unknown): string | null {
    return typeof remoteThreadId === "string" && home.state.threads[remoteThreadId] && !this.isRoomThread(home.state.threads[remoteThreadId]!)
      ? this.threadId(home, remoteThreadId) : null;
  }

  private sharedBot(home: Home, remoteBotId: unknown): string | null {
    return typeof remoteBotId === "string" && home.state.bots[remoteBotId] ? this.botId(home, remoteBotId) : null;
  }

  private threadsOf(home: Home, remoteBotId: string): string[] {
    return Object.entries(home.state.threads)
      .filter(([, entry]) => entry.botId === remoteBotId && !this.isRoomThread(entry))
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .map(([threadId]) => threadId);
  }

  private isRoomThread(entry: ThreadEntry): boolean {
    return entry.room === true || entry.task?.title?.startsWith("room · ") === true;
  }

  private selectedThread(home: Home, remoteBotId: string): string | null {
    const selected = home.state.selected[remoteBotId];
    if (selected && home.state.threads[selected]?.botId === remoteBotId && !this.isRoomThread(home.state.threads[selected]!)) return selected;
    const threads = this.threadsOf(home, remoteBotId);
    return threads.at(-1) ?? null;
  }

  // ── public reads ──────────────────────────────────────────────────────

  /** Virtual bots for GET /api/bots, shaped like wireBot + tasks + messagePage. */
  async listBots(limit: number | undefined): Promise<Array<WireBot & { tasks: WireTask[]; messages: WireMessage[]; hasMore: boolean; activeLeafId: string | null }>> {
    this.sync();
    const bound = this.options.listTimeoutMs ?? 4000;
    await Promise.all([...this.homes.values()].map((home) => withTimeout((async () => {
      if (!home.snapshotAt) await this.refreshSnapshot(home);
    })(), bound).catch(() => {})));
    const bots: Awaited<ReturnType<RemoteBotBridge["listBots"]>> = [];
    for (const home of this.homes.values()) {
      for (const remoteBotId of Object.keys(home.state.bots)) {
        const selected = this.selectedThread(home, remoteBotId);
        const page = selected
          ? await withTimeout(this.page(home, selected, limit ?? PAGE_MAX), bound).catch(() => this.cachedPage(home, selected, limit ?? PAGE_MAX))
          : { messages: [], hasMore: false, activeLeafId: null };
        bots.push({ ...this.virtualBot(home, remoteBotId), ...page });
      }
    }
    return bots;
  }

  /** Pending chips for bridge threads, in virtual ids. */
  queues(): BotQueuedMessages {
    const merged: BotQueuedMessages = {};
    for (const home of this.homes.values()) Object.assign(merged, home.queues);
    return merged;
  }

  /** Serve an attachment this home does not have but a relayed message named. */
  async attachment(name: string): Promise<BridgeResponse | null> {
    if (!ATTACHMENT_NAME.test(name)) return null;
    for (const home of this.homes.values()) {
      if (!home.state.attachments.includes(name)) continue;
      try {
        const result = await this.call(home, "GET", `/api/attachments/${name}`, undefined, { bytes: true });
        const mime = result.contentType ?? "";
        if (result.status !== 200 || !result.bytes || !/^image\/(?:png|jpeg|gif|webp)$/.test(mime)) return failure(404, "no such attachment");
        return { status: 200, headers: { "content-type": mime, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" }, bytes: result.bytes };
      } catch {
        return failure(502, `${home.link.name} is offline`);
      }
    }
    return null;
  }

  // ── routes ────────────────────────────────────────────────────────────

  async route(method: string, path: string, search: URLSearchParams, readBody: () => Promise<any>): Promise<BridgeResponse> {
    try {
      let match = /^\/api\/bots\/(rb-[\w-]+)(?:\/(.+))?$/.exec(path);
      if (match) return await this.botRoute(method, match[1]!, match[2] ?? "", search, readBody);
      match = /^\/api\/threads\/(rt-[\w-]+)(?:\/(.+))?$/.exec(path);
      if (match) return await this.threadRoute(method, match[1]!, match[2] ?? "", search, readBody);
      return refused();
    } catch (error) {
      if (error instanceof BridgeError) return failure(error.status, error.message);
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) return failure(status, error instanceof Error ? error.message : "bad request");
      return failure(502, "the other Mac did not answer");
    }
  }

  private async botRoute(method: string, virtualBotId: string, rest: string, search: URLSearchParams, readBody: () => Promise<any>): Promise<BridgeResponse> {
    const target = this.parse(virtualBotId, "rb");
    if (!target || !target.home.state.bots[target.remoteId]) return failure(404, "no such bot");
    const { home, remoteId: botId } = target;
    const body = async (): Promise<Record<string, any>> => {
      const value = method === "GET" ? null : await readBody();
      if (value !== null && value !== undefined && !isObject(value)) throw new BridgeError(400, "body must be a JSON object");
      return value ?? {};
    };
    const remoteBot = `/api/bots/${botId}`;
    if (rest === "" && method === "PATCH") {
      const patch = await body();
      if (Object.keys(patch).some((key) => key !== "pinned" && key !== "unread") || patch.unread === true) return refused();
      if (patch.pinned !== undefined) {
        if (typeof patch.pinned !== "boolean") return failure(400, "pinned must be true or false");
        if (patch.pinned) home.state.pinned[botId] = true;
        else delete home.state.pinned[botId];
        this.persist();
      }
      if (patch.unread === false) {
        const threadId = this.selectedThread(home, botId);
        if (threadId) await this.call(home, "POST", `${remoteBot}/read`, { threadId });
        this.markRead(home, threadId);
      }
      const bot = this.virtualBot(home, botId);
      this.options.broadcast({ kind: "bot", bot });
      return { status: 200, json: { bot } };
    }
    if (method !== "POST" && method !== "PATCH" && method !== "DELETE") return refused();
    if (rest === "messages" && method === "POST") return this.send(home, botId, await body());
    // A persistent grant would change what Putri's bot may do on her Mac
    // without her: only one-off answers cross the bridge.
    if (rest === "always-allow") return refused();
    if (method === "POST" && ["interrupt", "read", "compact", "active-branch", "respond"].includes(rest)) {
      const input = await body();
      if (rest === "respond" && input.always !== undefined && input.always !== false) return refused();
      const threadId = await this.threadFor(home, botId, input.threadId, false);
      if (!threadId) {
        return rest === "interrupt" || rest === "read" ? { status: 200, json: { ok: true } } : failure(404, "no such task");
      }
      const forwarded = rest === "respond" ? oneOffAnswer(input) : input;
      const result = await this.call(home, "POST", `${remoteBot}/${rest}`, { ...forwarded, threadId });
      if (rest === "read" && result.status === 200) this.markRead(home, threadId);
      return { status: result.status, json: this.outbound(home, botId, result.body) };
    }
    let match = /^messages\/([\w-]+)\/edit$/.exec(rest);
    if (match && method === "POST") {
      const input = await body();
      const threadId = await this.threadFor(home, botId, input.threadId, false);
      if (!threadId) return failure(404, "no such message");
      const text = typeof input.text === "string" ? await this.rewriteAttachments(home, input.text) : input.text;
      const result = await this.call(home, "POST", `${remoteBot}/messages/${match[1]}/edit`, { ...input, text, threadId });
      return { status: result.status, json: this.outbound(home, botId, result.body) };
    }
    match = /^queue\/([\w-]+)$/.exec(rest);
    if (match && method === "DELETE") {
      const input = await body();
      const threadId = await this.threadFor(home, botId, input.threadId, false);
      if (!threadId) return failure(404, "no such queued message");
      const result = await this.call(home, "DELETE", `${remoteBot}/queue/${match[1]}`, { threadId });
      return { status: result.status, json: this.outbound(home, botId, result.body) };
    }
    match = /^cards\/([\w-]+)$/.exec(rest);
    if (match && method === "PATCH") {
      const input = await body();
      const threadId = await this.threadFor(home, botId, input.threadId, false);
      if (!threadId) return failure(404, "no such card");
      const result = await this.call(home, "PATCH", `${remoteBot}/cards/${match[1]}`, { ...input, threadId });
      return { status: result.status, json: this.outbound(home, botId, result.body) };
    }
    if (rest === "tasks" && method === "POST") {
      const input = await body();
      const title = typeof input.title === "string" && input.title.trim() ? input.title.slice(0, 200) : undefined;
      const threadId = await this.createThread(home, botId, title);
      home.state.selected[botId] = threadId;
      this.persist();
      const bot = { ...this.virtualBot(home, botId), messages: [], hasMore: false, activeLeafId: null };
      this.options.broadcast({ kind: "bot", bot });
      return { status: 201, json: { bot, task: this.virtualTask(home, threadId) } };
    }
    match = /^tasks\/([\w-]+)$/.exec(rest);
    if (match) {
      const threadId = this.parse(match[1]!, "rt")?.home === home ? this.parse(match[1]!, "rt")!.remoteId : null;
      if (!threadId || home.state.threads[threadId]?.botId !== botId || this.isRoomThread(home.state.threads[threadId]!)) return failure(404, "no such task");
      if (method === "POST") {
        const raw = search.get("messages");
        const limit = raw === null ? PAGE_MAX : Number(raw);
        if (!Number.isInteger(limit) || limit < 0) return failure(400, "messages must be a non-negative whole number");
        home.state.selected[botId] = threadId;
        this.persist();
        const settings = this.virtualBot(home, botId);
        this.options.broadcast({ kind: "bot", bot: { ...settings, ...(await this.page(home, threadId, 50)) } });
        return { status: 200, json: { bot: limit === 0 ? settings : { ...settings, ...(await this.page(home, threadId, Math.min(limit, PAGE_MAX))) } } };
      }
      if (method === "PATCH") {
        const input = await body();
        if (Object.keys(input).some((key) => key !== "title" && key !== "archivedAt" && key !== "pinnedMessageId")) return refused();
        const result = await this.call(home, "PATCH", `${remoteBot}/tasks/${threadId}`, input);
        if (result.status === 200 && isObject(result.body?.task) && result.body.task.threadId === threadId) {
          home.state.threads[threadId]!.task = safeTask(result.body.task);
          this.persist();
        }
        const bot = this.virtualBot(home, botId);
        if (result.status === 200) this.options.broadcast({ kind: "bot", bot });
        return { status: result.status, json: this.outbound(home, botId, result.body) };
      }
      if (method === "DELETE") {
        const result = await this.call(home, "DELETE", `${remoteBot}/tasks/${threadId}`);
        if (result.status !== 200) return { status: result.status, json: this.outbound(home, botId, result.body) };
        this.unmap(home, threadId);
        const next = this.selectedThread(home, botId);
        const bot = { ...this.virtualBot(home, botId), ...(next ? await this.page(home, next, 50) : { messages: [], hasMore: false, activeLeafId: null }) };
        this.options.broadcast({ kind: "bot", bot });
        return { status: 200, json: { bot } };
      }
    }
    return refused();
  }

  private async threadRoute(method: string, virtualThreadId: string, rest: string, search: URLSearchParams, readBody: () => Promise<any>): Promise<BridgeResponse> {
    const target = this.parse(virtualThreadId, "rt");
    if (target && target.remoteId.startsWith("pending-") && rest === "messages" && method === "GET") {
      return { status: 200, json: { messages: [], hasMore: false, activeLeafId: null } };
    }
    const entry = target?.home.state.threads[target.remoteId];
    if (!target || !entry || this.isRoomThread(entry)) return failure(404, "no such conversation");
    const { home, remoteId: threadId } = target;
    const remoteThread = `/api/threads/${threadId}`;
    if (rest === "messages" && method === "GET") {
      const query = new URLSearchParams();
      for (const key of ["limit", "before", "around"]) {
        const value = search.get(key);
        if (value !== null) {
          if (!ID.test(value)) return failure(400, `${key} is invalid`);
          query.set(key, value);
        }
      }
      const result = await this.call(home, "GET", `${remoteThread}/messages${query.size ? `?${query}` : ""}`);
      if (result.status !== 200) return { status: result.status, json: this.outbound(home, entry.botId, result.body) };
      return { status: 200, json: {
        messages: this.sanitizeAll(home, result.body?.messages),
        hasMore: result.body?.hasMore === true,
        activeLeafId: typeof result.body?.activeLeafId === "string" ? result.body.activeLeafId : null,
      } };
    }
    let match = /^messages\/([\w-]+)\/image$/.exec(rest);
    if (match && method === "GET") {
      const result = await this.call(home, "GET", `${remoteThread}/messages/${match[1]}/image`, undefined, { bytes: true });
      if (result.status !== 200 || !result.bytes || !result.contentType?.startsWith("image/")) return failure(result.status === 200 ? 502 : result.status, "no image on that message");
      return { status: 200, headers: { "content-type": result.contentType, "cache-control": "private, max-age=31536000, immutable" }, bytes: result.bytes };
    }
    match = /^messages\/([\w-]+)\/file$/.exec(rest);
    if (match && (method === "POST" || (method === "GET" && search.get("preview") === "1"))) {
      const messageId = match[1]!;
      let href: string | null;
      if (method === "POST") {
        const input = await readBody();
        href = isObject(input) && typeof input.path === "string" ? input.path : null;
      } else {
        const ref = search.get("ref");
        if (!ref || !/^\d+$/.test(ref)) return failure(400, "ref must identify a rendered image");
        const message = await this.findMessage(home, threadId, messageId);
        if (!message) return failure(404, "no such message");
        href = messageImageTargetAt(message.text ?? "", Number(ref));
      }
      if (!href) return failure(400, "path is required");
      const result = await this.call(home, "POST", `${remoteThread}/messages/${messageId}/file`, { path: href }, { bytes: true });
      if (result.status !== 200 || !result.bytes) {
        return { status: result.status === 200 ? 502 : result.status, json: this.outbound(home, entry.botId, result.json ?? { error: "the file is unavailable" }) };
      }
      const mime = result.contentType ?? "application/octet-stream";
      if (method === "GET" && !mime.startsWith("image/")) return failure(415, "only images can be previewed here");
      const disposition = (result.disposition ?? "attachment").replace(/[\r\n]/g, "");
      return { status: 200, headers: {
        "content-type": mime,
        "content-disposition": method === "GET" ? "inline" : disposition,
        "cache-control": method === "GET" ? "private, max-age=3600" : "private, no-store",
        "x-content-type-options": "nosniff",
      }, bytes: result.bytes };
    }
    match = /^messages\/([\w-]+)\/reactions$/.exec(rest);
    if (match && method === "POST") {
      const input = await readBody();
      if (!isObject(input)) return failure(400, "body must be a JSON object");
      const result = await this.call(home, "POST", `${remoteThread}/messages/${match[1]}/reactions`, { emoji: input.emoji });
      return { status: result.status, json: this.outbound(home, entry.botId, result.body) };
    }
    if (rest === "respond" && method === "POST") {
      const input = await readBody();
      if (!isObject(input)) return failure(400, "body must be a JSON object");
      if (input.always !== undefined && input.always !== false) return refused();
      const result = await this.call(home, "POST", `${remoteThread}/respond`, oneOffAnswer(input));
      return { status: result.status, json: this.outbound(home, entry.botId, result.body) };
    }
    return refused();
  }

  private async send(home: Home, botId: string, input: Record<string, any>, room = false): Promise<BridgeResponse> {
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim()) return failure(400, "text required");
    // The first real message is what opens a thread on the other Mac.
    const threadId = (await this.threadFor(home, botId, input.threadId, true, room))!;
    const sendId = typeof input.sendId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(input.sendId) ? input.sendId : undefined;
    const run = async (): Promise<BridgeResponse> => {
      const rewritten = await this.rewriteAttachments(home, text);
      const result = await this.call(home, "POST", `/api/bots/${botId}/messages`, {
        text: rewritten, threadId,
        ...(sendId ? { sendId } : {}),
        ...(typeof input.replyToId === "string" && ID.test(input.replyToId) ? { replyToId: input.replyToId } : {}),
      });
      const json = this.outbound(home, botId, result.body);
      // the relayed message frame may trail the receipt; the cache dedupes by id
      if (result.status >= 200 && result.status < 300 && isObject(json.message)) this.remember(home, threadId, json.message as WireMessage, false);
      return { status: result.status, json };
    };
    if (!sendId) return run();
    // B deduplicates retries by sendId; this keeps two racing retries from
    // both re-uploading and both asking before either got its receipt.
    const key = `${home.link.homeId}:${botId}:${threadId}:${sendId}`;
    const pending = this.sends.get(key);
    if (pending) return pending;
    const started = run().finally(() => this.sends.delete(key));
    this.sends.set(key, started);
    return started;
  }

  // ── shared rooms ──────────────────────────────────────────────────────

  /** A shared room member on a linked Mac: the contact's home and bot id, or
   * null when that Mac is not linked or does not share the bot. */
  roomBot(homeId: string, remoteBotId: string): { virtualId: string; name: string } | null {
    const home = this.homes.get(homeId);
    const bot = home?.state.bots[remoteBotId];
    return home && bot ? { virtualId: this.botId(home, remoteBotId), name: String((bot as { name?: unknown }).name ?? "Bot") } : null;
  }

  /** Run one shared-room turn on a linked Mac's bot. The turn goes to a
   * bridge thread kept for that room, so the bot's owner sees it on their own
   * Mac under the bot, with the approval level their own side applies. */
  async roomTurn(input: {
    homeId: string; remoteBotId: string; threadId?: string; title: string; text: string; sendId: string;
    onThread: (threadId: string) => void;
    onActivity: (id: string, tool: { name: string; ok?: boolean; spoken?: string }) => void;
    deadlineMs: number;
  }): Promise<{ reply: string }> {
    const home = this.homes.get(input.homeId);
    if (!home || !home.state.bots[input.remoteBotId]) throw new BridgeError(404, "that bot is no longer shared");
    let threadId = input.threadId && home.state.threads[input.threadId]?.botId === input.remoteBotId ? input.threadId : undefined;
    if (!threadId) {
      threadId = await this.createThread(home, input.remoteBotId, input.title.slice(0, 200), true);
      this.options.broadcast({ kind: "bot", bot: this.virtualBot(home, input.remoteBotId) });
      input.onThread(threadId);
    }
    const sent = await this.send(home, input.remoteBotId, { text: input.text, threadId: this.threadId(home, threadId), sendId: input.sendId }, true);
    if (sent.status < 200 || sent.status >= 300) throw new BridgeError(sent.status, String(("json" in sent ? (sent.json as { error?: unknown } | null)?.error : undefined) ?? "the other Mac refused the message"));
    const delivered = new Set<string>();
    while (Date.now() < input.deadlineMs) {
      let before: string | undefined;
      let messages: Array<Record<string, any>> = [];
      // The latest page can lose the initiating message during a long turn.
      // Walk back to that sendId before deciding which reply belongs here.
      for (let page = 0; page < 100 && Date.now() < input.deadlineMs; page += 1) {
        const query = new URLSearchParams({ limit: "60" });
        if (before) query.set("before", before);
        const result = await this.call(home, "GET", `/api/threads/${threadId}/messages?${query}`).catch(() => null);
        if (result?.status !== 200) break;
        const batch = this.sanitizeAll(home, result.body?.messages) as Array<Record<string, any>>;
        if (!batch.length) break;
        messages = [...batch, ...messages];
        if (messages.some((message) => message.sendId === input.sendId && message.role === "user") || result.body?.hasMore !== true) break;
        const next = String(batch[0]?.id ?? "");
        if (!next || next === before) break;
        before = next;
      }
      const start = messages.findIndex((message) => message.sendId === input.sendId && message.role === "user");
      if (start >= 0) {
        const after = messages.slice(start + 1);
        for (const message of after) {
          if (message.role !== "bot" || message.kind !== "activity" || !message.tool?.name || delivered.has(message.id)) continue;
          delivered.add(message.id);
          input.onActivity(message.id, message.tool);
        }
        const failed = after.find((message) => message.role === "bot" && message.turnTerminal && message.turnOutcome?.ok === false);
        if (failed) throw new BridgeError(502, "the shared bot could not finish its turn");
        const settled = after.find((message) => message.role === "bot" && message.kind === "text" && message.text && message.turnTerminal);
        if (settled) return { reply: String(settled.text) };
        const ask = after.find((message) => message.kind === "options" && message.card?.requestId && !message.card.answered && !message.card.dismissed);
        if (ask && !delivered.has(`ask-${ask.id}`)) {
          delivered.add(`ask-${ask.id}`);
          input.onActivity(`ask-${ask.id}`, { name: "waiting for approval", spoken: `waiting for ${home.link.ownerName ?? "its owner"} to approve ${String(ask.card.tool ?? "a step")} on their Mac` });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    await this.call(home, "POST", `/api/bots/${input.remoteBotId}/interrupt`, { threadId }).catch(() => null);
    return { reply: "" };
  }

  // ── attachments ───────────────────────────────────────────────────────

  /** Re-upload every composer attachment to B and point the tag at B's copy.
   * A's upload id is reused, so B stores the same basename: a retry is
   * idempotent and the transcript image resolves to this Mac's copy too. */
  private async rewriteAttachments(home: Home, text: string): Promise<string> {
    const tags = [...text.matchAll(TAG)];
    if (!tags.length) return text;
    const root = resolve(this.options.attachmentsDir);
    const replacements = new Map<string, string>();
    for (const tag of tags) {
      const path = resolve(decodeAttribute(tag[2]!));
      const name = basename(path);
      if (dirname(path) !== root || !/^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/.test(name)) {
        throw new BridgeError(400, "that attachment is not on this Mac");
      }
      if (replacements.has(tag[0])) continue;
      const displayName = tag[3] === undefined ? name : decodeAttribute(tag[3]);
      const remotePath = await this.upload(home, path, displayName);
      const nameAttribute = tag[3] === undefined ? "" : ` name="${tag[3]}"`;
      replacements.set(tag[0], `<${tag[1]} path="${escapeAttribute(remotePath)}"${nameAttribute} />`);
    }
    return text.replace(TAG, (whole) => replacements.get(whole) ?? whole);
  }

  private async upload(home: Home, path: string, displayName: string): Promise<string> {
    let info;
    try { info = await stat(path); } catch { throw new BridgeError(400, "that attachment is no longer on this Mac"); }
    if (!info.isFile()) throw new BridgeError(400, "that attachment is no longer on this Mac");
    if (info.size > UPLOAD_MAX_BYTES) throw new BridgeError(413, "that attachment is too large to send to the other Mac");
    const bytes = await readFile(path);
    const file = basename(path);
    const extension = extname(file).toLowerCase();
    const stem = file.slice(0, -extension.length);
    const uploadId = UUID.test(stem) ? `uploadId=${stem.toLowerCase()}` : "";
    const imageMime = IMAGE_MIMES[extension];
    let result;
    if (imageMime) {
      result = await this.call(home, "POST", `/api/attachments${uploadId ? `?${uploadId}` : ""}`, undefined, { raw: { bytes, contentType: imageMime } });
    } else {
      const mime = this.options.fileMime(extension);
      if (!mime) throw new BridgeError(400, "that file type cannot be sent to the other Mac");
      const query = new URLSearchParams({ name: displayName.slice(0, 512) || file });
      result = await this.call(home, "POST", `/api/files?${query}${uploadId ? `&${uploadId}` : ""}`, undefined, { raw: { bytes, contentType: mime } });
    }
    if ((result.status !== 200 && result.status !== 201) || typeof result.body?.path !== "string") {
      throw new BridgeError(result.status >= 400 && result.status < 500 ? result.status : 502,
        `the other Mac refused the attachment: ${String(result.body?.error ?? result.status).slice(0, 160)}`);
    }
    return result.body.path;
  }

  private noteAttachments(home: Home, message: Record<string, any>): void {
    const names = new Set<string>();
    if (Array.isArray(message.attachments)) {
      for (const attachment of message.attachments) {
        const name = typeof attachment?.path === "string" ? basename(attachment.path) : "";
        if (ATTACHMENT_NAME.test(name)) names.add(name);
      }
    }
    if (typeof message.text === "string") {
      for (const match of message.text.matchAll(/\/api\/attachments\/([A-Za-z0-9-]+\.(?:png|jpg|gif|webp))/g)) names.add(match[1]!);
      for (const match of message.text.matchAll(TAG)) {
        const name = basename(decodeAttribute(match[2]!));
        if (ATTACHMENT_NAME.test(name)) names.add(name);
      }
    }
    this.addAttachmentNames(home, names);
  }

  private addAttachmentNames(home: Home, names: Iterable<string>): void {
    let changed = false;
    for (const name of names) {
      if (home.state.attachments.includes(name)) continue;
      home.state.attachments.push(name);
      changed = true;
    }
    if (!changed) return;
    if (home.state.attachments.length > MAX_ATTACHMENT_NAMES) home.state.attachments.splice(0, home.state.attachments.length - MAX_ATTACHMENT_NAMES);
    this.persist();
  }

  // ── translation ───────────────────────────────────────────────────────

  private virtualTask(home: Home, remoteThreadId: string): WireTask {
    const entry = home.state.threads[remoteThreadId]!;
    const task = entry.task ?? safeTask({ threadId: remoteThreadId, title: "Linked chat", createdAt: entry.createdAt });
    return { ...task, threadId: this.threadId(home, remoteThreadId) };
  }

  private virtualBot(home: Home, remoteBotId: string): WireBot & { tasks: WireTask[] } {
    const bot = home.state.bots[remoteBotId]!;
    const tasks = this.threadsOf(home, remoteBotId).map((threadId) => this.virtualTask(home, threadId));
    const selected = this.selectedThread(home, remoteBotId);
    const task = selected ? tasks.find((candidate) => candidate.threadId === this.threadId(home, selected)) : undefined;
    const remote: RemoteBotOrigin = { homeId: home.link.homeId, homeName: home.link.name, ownerName: home.link.ownerName };
    return {
      id: this.botId(home, remoteBotId),
      threadId: selected ? this.threadId(home, selected) : this.placeholder(home, remoteBotId),
      tasks,
      name: bot.name,
      title: bot.title,
      description: bot.description,
      notifications: bot.notifications,
      color: bot.color as WireBot["color"],
      ...(bot.mascotExpression !== undefined ? { mascotExpression: bot.mascotExpression } : {}),
      ...(bot.mascotBody !== undefined ? { mascotBody: bot.mascotBody as WireBot["mascotBody"] } : {}),
      avatarUrl: bot.avatarUrl,
      ...(bot.avatarCrop ? { avatarCrop: bot.avatarCrop as WireBot["avatarCrop"] } : {}),
      unread: tasks.some((candidate) => candidate.unread === true),
      modelSelection: task?.modelSelection ?? bot.modelSelection,
      computer: "off",
      ...((task?.approvalMode ?? bot.approvalMode) ? { approvalMode: task?.approvalMode ?? bot.approvalMode } : {}),
      ...((task?.autoApprove ?? bot.autoApprove) !== undefined ? { autoApprove: task?.autoApprove ?? bot.autoApprove } : {}),
      pinned: home.state.pinned[remoteBotId] === true,
      ...(task?.pinnedMessageId ? { pinnedMessageId: task.pinnedMessageId } : {}),
      busy: task?.busy === true,
      activity: task?.activity ?? "idle",
      createdAt: bot.createdAt,
      remote,
    };
  }

  /** Rewrite one B message for this home. Links to anything outside the
   * bridge-created threads are removed rather than translated. */
  private sanitize(home: Home, raw: unknown): WireMessage | null {
    if (!isObject(raw) || typeof raw.id !== "string") return null;
    const message: Record<string, any> = { ...raw };
    delete message.comm;
    delete message.roomRequest;
    if (isObject(message.threadRef)) {
      const threadId = this.mapped(home, message.threadRef.threadId);
      const botId = this.sharedBot(home, message.threadRef.botId);
      if (threadId && botId) message.threadRef = { botId, threadId, title: String(message.threadRef.title ?? "") };
      else delete message.threadRef;
    }
    for (const key of ["from", "peerAsk"] as const) {
      if (!isObject(message[key])) continue;
      const botId = this.sharedBot(home, message[key].botId);
      message[key] = { ...message[key], botId: botId ?? `rb-${home.key}-unknown` };
    }
    if (isObject(message.sender) && typeof message.sender.name === "string" && BRIDGE_SENDER.test(message.sender.name)) delete message.sender;
    if (isObject(message.card)) {
      const card: Record<string, any> = { ...message.card };
      for (const key of ["routineRequest", "profileRequest", "teamSetupRequest", "skillRequest"]) {
        if (card[key] !== undefined) card[key] = this.rewriteIds(home, card[key], 0);
      }
      message.card = card;
    }
    this.noteAttachments(home, message);
    return message as WireMessage;
  }

  private sanitizeAll(home: Home, messages: unknown): WireMessage[] {
    return Array.isArray(messages) ? messages.map((message) => this.sanitize(home, message)).filter((message): message is WireMessage => message !== null) : [];
  }

  /** Nested request cards name a bot and thread; translate known ones, blank the rest. */
  private rewriteIds(home: Home, value: unknown, depth: number): unknown {
    if (depth > 6) return undefined;
    if (Array.isArray(value)) return value.map((item) => this.rewriteIds(home, item, depth + 1));
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/(?:^b|B)otId$/.test(key) && typeof item === "string") out[key] = this.sharedBot(home, item) ?? "";
      else if (/(?:^t|T)hreadId$/.test(key) && typeof item === "string") out[key] = this.mapped(home, item) ?? "";
      else out[key] = this.rewriteIds(home, item, depth + 1);
    }
    return out;
  }

  /** B's JSON answer, reduced to what a client of this home may see. */
  private outbound(home: Home, remoteBotId: string, body: unknown): Record<string, unknown> {
    if (!isObject(body)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "threadId") {
        const threadId = this.mapped(home, value);
        if (threadId) out.threadId = threadId;
      } else if (key === "message") {
        const message = this.sanitize(home, value);
        if (message) out.message = message;
      } else if (key === "messages") {
        out.messages = this.sanitizeAll(home, value);
      } else if (key === "bot") {
        if (isObject(value) && value.id === remoteBotId) this.absorbBot(home, value);
        out.bot = this.virtualBot(home, remoteBotId);
      } else if (key === "task") {
        if (isObject(value) && this.mapped(home, value.threadId)) out.task = this.virtualTask(home, value.threadId);
      } else if ((typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) &&
        !/(?:^b|B)otId$|(?:^t|T)hreadId$|(?:^g|G)roupId$/.test(key)) {
        out[key] = value;
      }
    }
    return out;
  }

  // ── snapshot and threads ──────────────────────────────────────────────

  private async refreshSnapshot(home: Home): Promise<void> {
    if (this.options.replaceLinkToken && !home.peerMigrated) {
      const threads = Object.entries(home.state.threads).map(([threadId, entry]) => ({ botId: entry.botId, threadId }));
      const migrated = await this.call(home, "POST", "/api/multiplayer/peer-migrate", { threads });
      if (migrated.status !== 200 || migrated.body?.scoped !== true) {
        throw new BridgeError(migrated.status, String(migrated.body?.error ?? `update BOS on ${home.link.name} to finish peer security`));
      }
      if (typeof migrated.body?.token === "string") {
        this.options.replaceLinkToken(home.link.homeId, migrated.body.token);
        home.link.token = migrated.body.token;
      }
      home.peerMigrated = true;
    }
    const result = await this.call(home, "GET", "/api/bots?messages=0");
    if (result.status !== 200 || !Array.isArray(result.body?.bots)) throw new BridgeError(502, "the other Mac did not list its bots");
    const seen = new Set<string>();
    for (const raw of result.body.bots as unknown[]) {
      if (!isObject(raw) || typeof raw.id !== "string" || !ID.test(raw.id) || raw.hidden === true || relayed(raw)) continue;
      seen.add(raw.id);
      this.absorbBot(home, raw);
    }
    for (const botId of Object.keys(home.state.bots)) if (!seen.has(botId)) this.removeBot(home, botId);
    this.absorbQueues(home, result.body.botQueuedMessages);
    home.snapshotAt = Date.now();
    this.persist();
  }

  /** Fold one of B's bot records into state: display fields, and the task
   * list filtered to bridge threads. Returns whether the bot is shared. */
  private absorbBot(home: Home, raw: Record<string, any>): boolean {
    const botId = raw.id as string;
    if (relayed(raw)) return false;
    if (raw.hidden === true) {
      if (home.state.bots[botId]) this.removeBot(home, botId);
      return false;
    }
    home.state.bots[botId] = safeBot(raw, home.state.bots[botId]);
    if (typeof raw.threadId === "string" && ID.test(raw.threadId)) home.remoteSelected.set(botId, raw.threadId);
    if (Array.isArray(raw.tasks)) {
      const listed = new Map<string, Record<string, any>>();
      for (const task of raw.tasks) if (isObject(task) && typeof task.threadId === "string") listed.set(task.threadId, task);
      for (const threadId of this.threadsOf(home, botId)) {
        const task = listed.get(threadId);
        const entry = home.state.threads[threadId]!;
        if (task) entry.task = safeTask(task);
        else if (Date.now() - entry.createdAt > FRESH_THREAD_MS) this.unmap(home, threadId);
      }
    }
    this.persist();
    return true;
  }

  private removeBot(home: Home, botId: string): void {
    delete home.state.bots[botId];
    delete home.state.selected[botId];
    delete home.state.pinned[botId];
    for (const threadId of this.threadsOf(home, botId)) this.unmap(home, threadId);
    this.persist();
    this.options.broadcast({ kind: "bot.deleted", botId: this.botId(home, botId) });
  }

  private unmap(home: Home, threadId: string): void {
    const entry = home.state.threads[threadId];
    if (!entry) return;
    delete home.state.threads[threadId];
    if (home.state.selected[entry.botId] === threadId) delete home.state.selected[entry.botId];
    home.cache.delete(threadId);
    const virtual = this.threadId(home, threadId);
    if (home.queues[virtual]) {
      delete home.queues[virtual];
      this.options.queuesChanged?.();
    }
    this.persist();
  }

  private absorbQueues(home: Home, raw: unknown): void {
    const next: BotQueuedMessages = {};
    if (isObject(raw)) {
      for (const [threadId, items] of Object.entries(raw)) {
        const virtual = this.mapped(home, threadId);
        if (!virtual || !Array.isArray(items)) continue;
        next[virtual] = items.filter(isObject).map((item) => ({
          queueId: String(item.queueId), text: String(item.text ?? ""),
          ...(item.reason === "capacity" ? { reason: "capacity" as const } : {}),
        }));
      }
    }
    if (JSON.stringify(next) === JSON.stringify(home.queues)) return;
    home.queues = next;
    this.options.queuesChanged?.();
  }

  private markRead(home: Home, threadId: string | null): void {
    const task = threadId ? home.state.threads[threadId]?.task : undefined;
    if (task) task.unread = false;
  }

  /** B thread id for a request: an explicit virtual id must be a bridge
   * thread of this bot; no id means this home's selection for the bot. */
  private async threadFor(home: Home, botId: string, requested: unknown, create: boolean, room = false): Promise<string | null> {
    const fallback = () => (create ? this.ensureThread(home, botId) : this.selectedThread(home, botId));
    if (requested === undefined || requested === null) return fallback();
    if (typeof requested !== "string") throw new BridgeError(400, "threadId must be a task id");
    const target = this.parse(requested, "rt");
    if (target?.home === home && target.remoteId === `pending-${botId}`) return fallback();
    if (target?.home !== home || home.state.threads[target.remoteId]?.botId !== botId || (!room && this.isRoomThread(home.state.threads[target.remoteId]!))) throw new BridgeError(404, "no such task");
    return target.remoteId;
  }

  private async ensureThread(home: Home, botId: string): Promise<string> {
    const selected = this.selectedThread(home, botId);
    if (selected) return selected;
    const pending = home.creating.get(botId);
    if (pending) return pending;
    const owner = this.options.localOwnerName().trim() || "Linked Mac";
    const started = this.createThread(home, botId, `${owner} · linked Mac`.slice(0, 200))
      .then((threadId) => {
        home.state.selected[botId] = threadId;
        this.persist();
        this.options.broadcast({ kind: "bot", bot: this.virtualBot(home, botId) });
        return threadId;
      })
      .finally(() => home.creating.delete(botId));
    home.creating.set(botId, started);
    return started;
  }

  /** Open a thread on B for this home. B's create also selects it for B's
   * owner, so the owner's previous selection is put back straight after. */
  private async createThread(home: Home, botId: string, title: string | undefined, room = false): Promise<string> {
    const previous = home.remoteSelected.get(botId);
    const result = await this.call(home, "POST", `/api/bots/${botId}/tasks`, title ? { title } : {});
    const task = result.body?.task;
    if (result.status !== 201 && result.status !== 200) {
      throw new BridgeError(result.status >= 400 && result.status < 500 ? result.status : 502, String(result.body?.error ?? "the other Mac could not open a thread"));
    }
    if (!isObject(task) || typeof task.threadId !== "string" || !ID.test(task.threadId)) throw new BridgeError(502, "the other Mac could not open a thread");
    const threadId = task.threadId;
    // B copies the bot's approval mode and always-allow list into a new
    // thread and its create route takes no approval setting. Reset the thread
    // to Ask with no grants before it is used; if B will not, it is removed.
    const reset = task.approvalMode === "ask" && task.autoApprove !== true
      ? { status: 200, body: { task } }
      : await this.call(home, "PATCH", `/api/bots/${botId}/tasks/${threadId}`, {
        modelSelection: task.modelSelection, resetApprovalToAsk: true,
      }).catch(() => null);
    const confirmed = reset?.status === 200 && isObject(reset.body?.task) && reset.body.task.threadId === threadId &&
      reset.body.task.approvalMode === "ask" && reset.body.task.autoApprove !== true;
    if (!confirmed) {
      await this.call(home, "DELETE", `/api/bots/${botId}/tasks/${threadId}`).catch(() => {});
      if (previous && previous !== threadId) await this.call(home, "POST", `/api/bots/${botId}/tasks/${previous}?messages=0`).catch(() => {});
      throw new BridgeError(409, `${home.link.name} keeps this bot on a custom approval setting; ask ${home.link.ownerName ?? "its owner"} to switch it to Ask first`);
    }
    home.state.threads[threadId] = { botId, createdAt: Date.now(), task: safeTask(reset.body.task), ...(room ? { room: true as const } : {}) };
    home.cache.set(threadId, { messages: [], hasMore: false, activeLeafId: null, hydrated: true });
    this.persist();
    if (previous && previous !== threadId) {
      await this.call(home, "POST", `/api/bots/${botId}/tasks/${previous}?messages=0`).catch(() => {});
    }
    return threadId;
  }

  // ── transcript cache ──────────────────────────────────────────────────

  private cachedPage(home: Home, threadId: string, limit: number) {
    const cache = home.cache.get(threadId);
    if (!cache) return { messages: [], hasMore: false, activeLeafId: null };
    const messages = limit === 0 ? [] : cache.messages.slice(-limit);
    return { messages, hasMore: cache.hasMore || cache.messages.length > messages.length, activeLeafId: cache.activeLeafId };
  }

  private async page(home: Home, threadId: string, limit: number) {
    if (limit > 0 && !home.cache.get(threadId)?.hydrated) await this.hydrate(home, threadId, false);
    return this.cachedPage(home, threadId, limit);
  }

  private async findMessage(home: Home, threadId: string, messageId: string): Promise<WireMessage | null> {
    const cached = home.cache.get(threadId)?.messages.find((message) => message.id === messageId);
    if (cached) return cached;
    const result = await this.call(home, "GET", `/api/threads/${threadId}/messages?around=${messageId}&limit=1`);
    return this.sanitizeAll(home, result.body?.messages).find((message) => message.id === messageId) ?? null;
  }

  /** Load a bridge thread's newest page. With `diff`, what the relay missed
   * while disconnected is broadcast as ordinary message frames. */
  private hydrate(home: Home, threadId: string, diff: boolean): Promise<void> {
    const pending = home.hydrating.get(threadId);
    if (pending) return pending;
    const started = (async () => {
      if (!home.state.threads[threadId]) return;
      const result = await this.call(home, "GET", `/api/threads/${threadId}/messages?limit=${CACHE_MAX}`);
      if (result.status !== 200 || !home.state.threads[threadId]) return;
      const messages = this.sanitizeAll(home, result.body?.messages);
      const activeLeafId = typeof result.body?.activeLeafId === "string" ? result.body.activeLeafId : null;
      const previous = home.cache.get(threadId);
      home.cache.set(threadId, { messages, hasMore: result.body?.hasMore === true, activeLeafId, hydrated: true });
      if (!diff || !previous?.hydrated) return;
      const virtual = this.threadId(home, threadId);
      const known = new Map(previous.messages.map((message) => [message.id, JSON.stringify(message)]));
      for (const message of messages) {
        const before = known.get(message.id);
        if (before === undefined) this.options.broadcast({ kind: "message", threadId: virtual, message });
        else if (before !== JSON.stringify(message)) this.options.broadcast({ kind: "message.patch", threadId: virtual, message });
      }
      if (activeLeafId && activeLeafId !== previous.activeLeafId) this.options.broadcast({ kind: "thread", threadId: virtual, activeLeafId });
    })().finally(() => home.hydrating.delete(threadId));
    home.hydrating.set(threadId, started);
    return started;
  }

  private remember(home: Home, threadId: string, message: WireMessage, patch: boolean): void {
    const cache = home.cache.get(threadId);
    if (!cache?.hydrated) return;
    const index = cache.messages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) cache.messages[index] = message;
    else if (!patch) {
      cache.messages.push(message);
      if (cache.messages.length > CACHE_MAX) {
        cache.messages.splice(0, cache.messages.length - CACHE_MAX);
        cache.hasMore = true;
      }
    }
  }

  // ── the relay ─────────────────────────────────────────────────────────

  /** One frame from B. Everything not tied to a bridge thread or a shared
   * bot's display record is dropped here. */
  handleFrame(home: Home, frame: Record<string, any>): void {
    switch (frame.kind) {
      case "message":
      case "message.patch": {
        const virtual = this.mapped(home, frame.threadId);
        if (!virtual) return;
        const message = this.sanitize(home, frame.message);
        if (!message) return;
        this.remember(home, frame.threadId, message, frame.kind === "message.patch");
        this.options.broadcast({ kind: frame.kind, threadId: virtual, message });
        return;
      }
      case "thread": {
        const virtual = this.mapped(home, frame.threadId);
        if (!virtual || typeof frame.activeLeafId !== "string") return;
        const cache = home.cache.get(frame.threadId);
        if (cache) cache.hydrated = false;
        this.options.broadcast({ kind: "thread", threadId: virtual, activeLeafId: frame.activeLeafId });
        void this.hydrate(home, frame.threadId, false).catch(() => {});
        return;
      }
      case "bot": {
        const raw = frame.bot;
        if (!isObject(raw) || typeof raw.id !== "string" || !ID.test(raw.id)) return;
        if (!this.absorbBot(home, raw)) return;
        // messages in a bot frame belong to B's own selection: never relayed
        this.options.broadcast({ kind: "bot", bot: this.virtualBot(home, raw.id) });
        return;
      }
      case "bot.deleted":
        if (typeof frame.botId === "string" && home.state.bots[frame.botId]) this.removeBot(home, frame.botId);
        return;
      case "bot.queued":
        this.absorbQueues(home, frame.queues);
        return;
      case "runtime": {
        const event = frame.event;
        if (!isObject(event)) return;
        const virtual = this.mapped(home, event.threadId);
        if (!virtual) return;
        const { raw: _raw, ...rest } = event;
        this.options.broadcast({ kind: "runtime", event: { ...rest, threadId: virtual } });
        return;
      }
      case "notify": {
        const notification = frame.notification;
        if (!isObject(notification)) return;
        const threadId = this.mapped(home, notification.threadId);
        const botId = this.sharedBot(home, notification.botId);
        if (!threadId || !botId) return;
        this.options.notify?.({
          kind: notification.kind,
          botId, threadId,
          botName: String(notification.botName ?? ""),
          title: String(notification.title ?? ""),
          body: String(notification.body ?? ""),
          ...(typeof notification.avatarUrl === "string" && notification.avatarUrl === home.state.bots[notification.botId]?.avatarUrl
            ? { avatarUrl: notification.avatarUrl } : {}),
        });
        return;
      }
      case "screen": {
        const threadId = this.mapped(home, frame.threadId);
        const botId = this.sharedBot(home, frame.botId);
        if (!threadId || !botId || typeof frame.png !== "string") return;
        this.options.broadcast({ kind: "screen", botId, threadId, png: frame.png, ...(typeof frame.mime === "string" ? { mime: frame.mime } : {}) });
        return;
      }
      default:
        return;
    }
  }

  /** B said it could not replay what this home missed: refresh everything. */
  private async resync(home: Home): Promise<void> {
    await this.refreshSnapshot(home);
    await Promise.all([...home.cache.entries()]
      .filter(([threadId, cache]) => cache.hydrated && home.state.threads[threadId])
      .map(([threadId]) => this.hydrate(home, threadId, true).catch(() => {})));
    for (const botId of Object.keys(home.state.bots)) this.options.broadcast({ kind: "bot", bot: this.virtualBot(home, botId) });
  }

  private async streamLoop(home: Home): Promise<void> {
    const delays = this.options.reconnectDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000];
    const idleMs = this.options.idleTimeoutMs ?? 45_000;
    let attempt = 0;
    while (!this.stopped && home.running) {
      if (home.peerMigrated) {
        try {
          await this.refreshSnapshot(home);
          await Promise.all([...home.cache.entries()].filter(([threadId, cache]) => cache.hydrated && home.state.threads[threadId])
            .map(([threadId]) => this.hydrate(home, threadId, true).catch(() => {})));
          home.connected = true;
        } catch (error) {
          home.connected = false;
          this.log(`${home.link.name}: peer refresh failed (${error instanceof Error ? error.message : "unknown"})`);
        }
        await new Promise<void>(resolveWait => {
          const timer = setTimeout(resolveWait, 5_000);
          home.wake = () => { clearTimeout(timer); resolveWait(); };
        });
        continue;
      }
      const controller = new AbortController();
      home.abort = controller;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const quiet = () => { if (idle) clearTimeout(idle); };
      const bump = () => { quiet(); idle = setTimeout(() => controller.abort(), idleMs); };
      try {
        const url = new URL("/api/events", home.link.origin);
        url.searchParams.set("screens", "off");
        if (home.cursor) url.searchParams.set("since", home.cursor);
        if (url.origin !== new URL(home.link.origin).origin) throw new Error("invalid remote route");
        bump();
        const response = await this.fetcher(url, {
          redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${home.link.token}`, accept: "text/event-stream", ...(home.cursor ? { "last-event-id": home.cursor } : {}) },
        });
        if (!response.ok || !response.body) throw new Error(`event stream answered ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bump();
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            quiet();
            if (await this.handleBlock(home, block)) attempt = 0;
            bump();
            if (this.stopped || !home.running) break;
          }
          if (this.stopped || !home.running) break;
        }
      } catch (error) {
        if (!this.stopped && home.running && !controller.signal.aborted) {
          this.log(`${home.link.name}: event stream interrupted (${error instanceof Error ? error.message : "unknown"})`);
        }
      } finally {
        quiet();
        home.connected = false;
        home.abort = null;
      }
      if (this.stopped || !home.running) break;
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
      attempt += 1;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(() => { home.wake = null; resolveWait(); }, delay);
        home.wake = () => { clearTimeout(timer); home.wake = null; resolveWait(); };
      });
    }
    home.running = false;
  }

  /** Returns true for a hello frame. */
  private async handleBlock(home: Home, block: string): Promise<boolean> {
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
    if (!data.length) return false;
    let frame: unknown;
    try { frame = JSON.parse(data.join("\n")); } catch { return false; }
    if (!isObject(frame)) return false;
    if (frame.kind === "hello") {
      home.connected = true;
      if (frame.resumed !== true) {
        if (typeof frame.cursor === "string" && frame.cursor.length <= 64) home.cursor = frame.cursor;
        try { await this.resync(home); }
        catch (error) { this.log(`${home.link.name}: could not refresh (${error instanceof Error ? error.message : "unknown"})`); }
      }
      return true;
    }
    if (frame.kind !== "ping") {
      try { this.handleFrame(home, frame); }
      catch (error) { this.log(`${home.link.name}: dropped a frame (${error instanceof Error ? error.message : "unknown"})`); }
    }
    if (id && id.length <= 64) home.cursor = id;
    return false;
  }

  // ── transport ─────────────────────────────────────────────────────────

  private async call(
    home: Home,
    method: string,
    path: string,
    body?: unknown,
    options: { bytes?: boolean; raw?: { bytes: Buffer; contentType: string } } = {},
  ): Promise<{ status: number; body: any; json?: any; bytes?: Buffer; contentType?: string; disposition?: string }> {
    const url = new URL(path, home.link.origin);
    if (url.origin !== new URL(home.link.origin).origin) throw new BridgeError(400, "invalid remote route");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method, redirect: "error", signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 20_000),
        headers: {
          authorization: `Bearer ${home.link.token}`,
          ...(options.raw ? { "content-type": options.raw.contentType } : body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(options.raw ? { body: new Uint8Array(options.raw.bytes) } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new BridgeError(502, `${home.link.name} is offline`);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? undefined;
    if (options.bytes && response.ok && contentType !== "application/json") {
      return {
        status: response.status, body: null, contentType,
        disposition: response.headers.get("content-disposition") ?? undefined,
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    }
    let parsed: any = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, body: parsed, json: parsed, contentType };
  }

  private persist(): void {
    const homes: Record<string, HomeState> = {};
    for (const [homeId, state] of this.saved) homes[homeId] = state;
    try {
      mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.options.file, JSON.stringify({ version: 1, homes } satisfies Snapshot), { mode: 0o600 });
    } catch (error) {
      this.log(`could not save the remote bot map (${error instanceof Error ? error.message : "unknown"})`);
    }
  }

  private log(message: string): void {
    (this.options.log ?? ((line: string) => console.warn(`remote bots: ${line}`)))(message);
  }

  /** Test seam: the runtime for a linked home. */
  homeForTest(homeId: string): Home | undefined { return this.homes.get(homeId); }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}
