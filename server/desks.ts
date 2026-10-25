// Desk store: one json file per bot under <data>/desks. Cards are checked
// against the openui component schema before they are saved, so a bot hears
// "unknown component Nope" now instead of the person seeing a broken card.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createParser } from "@openuidev/lang-core";
import schema from "../shared/openui-schema.json" with { type: "json" };
import { DESK_LIMITS, WHATSAPP_DESK_HOST, deskCardSource, deskHost, type Desk, type DeskCard, type DeskKind, type DeskStatus } from "../shared/desks.ts";

export class DeskError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const parser = createParser(schema as Parameters<typeof createParser>[0], "Col");

/** Why a card's openui would not draw, or null when it draws. */
export function cardProblem(source: string): string | null {
  let result: ReturnType<typeof parser.parse>;
  try { result = parser.parse(source); } catch (error) { return error instanceof Error ? error.message : String(error); }
  const errors = result.meta?.errors ?? [];
  if (errors.length) return errors.map((error) => error.message).join("; ");
  if (result.meta?.incomplete) return "the code is cut off (an unclosed bracket or quote)";
  if (!result.root) return "nothing to draw: start with root = Col([...])";
  return null;
}

const SAFE_ID = /^[\w-]{1,128}$/;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface DeskOpenInput { id?: string; name: string; url?: string; kind?: DeskKind; status?: DeskStatus }
export interface DeskCardInput { card_id: string; title?: string; code?: string; data?: unknown; remove?: boolean }
export interface DeskPatch { name?: string; pinned?: boolean; status?: DeskStatus; threadId?: string }

export class DeskStore {
  private root: string;
  private now: () => number;
  constructor(dataDir: string, now = Date.now) {
    this.root = join(dataDir, "desks");
    this.now = now;
  }

  private file(botId: string): string {
    if (!SAFE_ID.test(botId)) throw new DeskError(400, "bad bot id");
    return join(this.root, `${botId}.json`);
  }

  list(botId: string): Desk[] {
    const file = this.file(botId);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { desks?: Desk[] };
      return Array.isArray(parsed.desks) ? parsed.desks : [];
    } catch {
      return [];
    }
  }

  get(botId: string, id: string): Desk | undefined {
    return this.list(botId).find((desk) => desk.id === id);
  }

  private save(botId: string, desks: Desk[]): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.file(botId);
    writeFileSync(file + ".tmp", JSON.stringify({ desks }), { mode: 0o600 });
    const fd = openSync(file + ".tmp", "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(file + ".tmp", file);
  }

  private mutate(botId: string, id: string, change: (desk: Desk) => void): Desk {
    const desks = this.list(botId);
    const desk = desks.find((entry) => entry.id === id);
    if (!desk) throw new DeskError(404, `no desk ${id}. call desk_list for your desks.`);
    change(desk);
    desk.updatedAt = this.now();
    desk.rev += 1;
    this.save(botId, desks);
    return desk;
  }

  /** Create a desk, or update the one with this id (or the same app). */
  open(botId: string, threadId: string, input: DeskOpenInput): { desk: Desk; created: boolean } {
    const name = input.name.trim().slice(0, DESK_LIMITS.name);
    if (!name) throw new DeskError(400, "a desk needs a name, e.g. \"meta ads\"");
    const kind: DeskKind = input.kind ?? "browser";
    let url: string | undefined;
    let host: string | undefined;
    if (kind === "whatsapp") {
      host = WHATSAPP_DESK_HOST;
    } else if (input.url !== undefined) {
      host = deskHost(input.url) ?? undefined;
      if (!host) throw new DeskError(400, "url must be an https:// address, e.g. https://adsmanager.facebook.com/");
      url = input.url;
    }
    const desks = this.list(botId);
    const existing = input.id
      ? desks.find((desk) => desk.id === input.id)
      : desks.find((desk) => desk.kind === kind && (kind === "whatsapp" || (host !== undefined && desk.host === host)));
    if (input.id && !existing) throw new DeskError(404, `no desk ${input.id}. leave id out to make a new desk.`);
    const at = this.now();
    if (existing) {
      existing.name = name;
      existing.threadId = threadId;
      if (url) { existing.url = url; existing.host = host; }
      if (input.status) existing.status = input.status;
      existing.updatedAt = at;
      existing.rev += 1;
      this.save(botId, desks);
      return { desk: existing, created: false };
    }
    if (desks.length >= DESK_LIMITS.desks) throw new DeskError(409, `${DESK_LIMITS.desks} desks is the limit. remove one with desk_remove first.`);
    if (kind === "browser" && !url) throw new DeskError(400, "a new browser desk needs the app's url, e.g. https://mail.google.com/");
    const desk: Desk = {
      id: `d-${randomBytes(4).toString("hex")}`,
      botId,
      threadId,
      name,
      kind,
      ...(url ? { url } : {}),
      ...(host ? { host } : {}),
      // whatsapp's link state comes from the native connection, not this flag
      status: input.status ?? (kind === "whatsapp" ? "ready" : "needs_sign_in"),
      pinned: false,
      cards: [],
      createdAt: at,
      updatedAt: at,
      rev: 1,
    };
    desks.push(desk);
    this.save(botId, desks);
    return { desk, created: true };
  }

  /** Add, replace, partly update or remove one card. */
  card(botId: string, deskId: string, input: DeskCardInput): { desk: Desk; card?: DeskCard; removed?: boolean } {
    if (!CARD_ID.test(input.card_id)) throw new DeskError(400, "card_id is a short lowercase slug, e.g. \"today\" or \"unread-chats\"");
    let saved: DeskCard | undefined;
    let removed = false;
    const desk = this.mutate(botId, deskId, (desk) => {
      const index = desk.cards.findIndex((card) => card.id === input.card_id);
      if (input.remove) {
        if (index < 0) throw new DeskError(404, `no card ${input.card_id} on this desk`);
        desk.cards.splice(index, 1);
        removed = true;
        return;
      }
      const current = index >= 0 ? desk.cards[index] : undefined;
      if (!current && (input.code === undefined || input.title === undefined)) throw new DeskError(400, "a new card needs title and code");
      if (input.code !== undefined && input.code.length > DESK_LIMITS.code) throw new DeskError(400, `card code is over ${DESK_LIMITS.code} characters; split it into two cards`);
      if (input.data !== undefined && JSON.stringify(input.data).length > DESK_LIMITS.data) throw new DeskError(400, `card data is over ${DESK_LIMITS.data} characters; keep the latest rows only`);
      const next: DeskCard = {
        id: input.card_id,
        title: (input.title ?? current?.title ?? "").trim().slice(0, DESK_LIMITS.title),
        code: input.code ?? current!.code,
        ...(input.data !== undefined ? { data: input.data } : current?.data !== undefined ? { data: current.data } : {}),
        updatedAt: this.now(),
      };
      const problem = cardProblem(deskCardSource(next));
      if (problem) throw new DeskError(400, `that card would not draw: ${problem}. nothing was saved.`);
      if (current) desk.cards[index] = next;
      else {
        if (desk.cards.length >= DESK_LIMITS.cards) throw new DeskError(409, `${DESK_LIMITS.cards} cards is the limit on one desk; remove one first`);
        desk.cards.push(next);
      }
      saved = next;
    });
    return { desk, ...(saved ? { card: saved } : {}), ...(removed ? { removed } : {}) };
  }

  /** Owner edits from the tab: pin, sign-in state, rename. */
  patch(botId: string, deskId: string, patch: DeskPatch): Desk {
    return this.mutate(botId, deskId, (desk) => {
      if (patch.name !== undefined) {
        const name = patch.name.trim().slice(0, DESK_LIMITS.name);
        if (name) desk.name = name;
      }
      if (patch.pinned !== undefined) desk.pinned = patch.pinned;
      if (patch.status !== undefined) desk.status = patch.status;
      if (patch.threadId !== undefined) desk.threadId = patch.threadId;
    });
  }

  remove(botId: string, deskId: string): boolean {
    const desks = this.list(botId);
    const next = desks.filter((desk) => desk.id !== deskId);
    if (next.length === desks.length) return false;
    this.save(botId, next);
    return true;
  }
}
