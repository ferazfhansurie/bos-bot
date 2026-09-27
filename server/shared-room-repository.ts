import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { searchSharedMessages, type SharedSearchOptions } from "../shared/shared-search.ts";
import { writeFileAtomic } from "./atomic.ts";
import { quarantineSaved } from "./quarantine-saved.ts";
import { contactId, parseContactId, SharedRoomLog, validateSharedSend, type SharedRoom, type SharedTextMessage } from "../shared/multiplayer.ts";

export interface SharedConversationPreferences { readSequence: number; notifications: "all" | "mentions" | "muted" }
interface Snapshot {
  version: 1;
  preferences?: Record<string, Record<string, SharedConversationPreferences>>;
  editedReceipts?: Record<string, string>;
  rooms: Array<{ room: SharedRoom; messages: SharedTextMessage[] }>;
}
interface RoomEvent { roomId: string; id: string; at: number; input: unknown }

/** Canonical-home storage. Caller authenticates the actor before append. */
export class SharedRoomRepository {
  private readonly editedReceipts = new Map<string, string>();
  private readonly preferences = new Map<string, Map<string, SharedConversationPreferences>>();
  private readonly rooms = new Map<string, SharedRoomLog>();
  private readonly file: string;
  private readonly homeId: string;

  constructor(file: string, homeId: string) {
    this.file = file;
    this.homeId = homeId;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(homeId)) throw new Error("invalid home id");
    if (!existsSync(file)) return;
    let snapshot: Snapshot;
    try { snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot; }
    catch {
      quarantineSaved(file, { version: 1, rooms: [] });
      return;
    }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.rooms)) throw new Error("invalid shared room storage");
    for (const [key, hash] of Object.entries(snapshot.editedReceipts ?? {})) { if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) this.editedReceipts.set(key, hash); }
    for (const [roomId, actors] of Object.entries(snapshot.preferences ?? {})) {
      const values = new Map<string, SharedConversationPreferences>();
      for (const [actorId, pref] of Object.entries(actors)) {
        if (parseContactId(actorId) && Number.isSafeInteger(pref.readSequence) && pref.readSequence >= 0 && ["all", "mentions", "muted"].includes(pref.notifications)) values.set(actorId, pref);
      }
      this.preferences.set(roomId, values);
    }
    let invalid = false;
    for (const entry of snapshot.rooms) {
      try {
        if (entry.room.homeId !== homeId || this.rooms.has(entry.room.id)) throw new Error("invalid shared room storage");
        // Legacy rooms predate revisions; match the edit/delete default on reads.
        this.rooms.set(entry.room.id, new SharedRoomLog({ ...entry.room, revision: entry.room.revision ?? 1 }, entry.messages));
      } catch { invalid = true; }
    }
    if (invalid) quarantineSaved(file, { version: 1, preferences: Object.fromEntries([...this.preferences].map(([id, prefs]) => [id, Object.fromEntries(prefs)])), editedReceipts: Object.fromEntries(this.editedReceipts), rooms: [...this.rooms.values()].map(log => ({ room: log.room, messages: log.all() })) });
    const journal = `${file}.events`;
    if (existsSync(journal)) {
      let broken = false;
      for (const line of readFileSync(journal, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const event = JSON.parse(line) as RoomEvent;
          if (!event || typeof event.roomId !== "string") throw new Error("invalid room event");
          const log = this.rooms.get(event.roomId);
          if (!log) throw new Error("room event has no room");
          const result = log.append(event.input, event.id, event.at);
          if (result.message.id !== event.id) throw new Error("room event conflicts with snapshot");
        } catch { broken = true; break; }
      }
      if (broken) {
        quarantineSaved(journal, "");
        this.persist();
      }
    }
  }

  listFor(actorId: string): SharedRoom[] {
    if (!parseContactId(actorId)) return [];
    return [...this.rooms.values()].map(log => log.room).filter(room => room.memberIds.includes(actorId));
  }

  /** Internal restart recovery only; request handlers must use member-filtered reads. */
  allRooms(): SharedRoom[] { return [...this.rooms.values()].map(log => log.room); }
  allMessages(roomId: string): SharedTextMessage[] { return this.rooms.get(roomId)?.all() ?? []; }

  summariesFor(actorId: string): Array<SharedRoom & { lastActivity: number; preview: string; unreadCount: number; readSequence: number; notifications: SharedConversationPreferences["notifications"] }> {
    if (!parseContactId(actorId)) return [];
    return [...this.rooms.values()].filter(log => log.room.memberIds.includes(actorId)).map(log => {
      const all = log.all();
      const last = all.findLast(message => message.kind !== "activity");
      const preferences = this.preferencesFor(log.room.id, actorId);
      const unreadCount = all.filter(message => message.sequence > preferences.readSequence && contactId(message.actor) !== actorId && message.kind !== "activity" && !message.deletedAt).length;
      return { ...log.room, lastActivity: last?.at ?? 0, preview: last?.deletedAt ? "Message removed" : last?.text ?? "", ...preferences, unreadCount };
    });
  }

  roomFor(roomId: string, actorId: string): SharedRoom | null {
    const room = this.rooms.get(roomId)?.room;
    return room?.memberIds.includes(actorId) ? room : null;
  }

  create(name: string, memberIds: string[], at = Date.now(), createdBy?: string, kind?: "direct" | "group"): SharedRoom {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 100) throw new Error("invalid room name");
    if (memberIds.length < 2 || memberIds.length > 50 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => !parseContactId(id))) {
      throw new Error("invalid room roster");
    }
    const room: SharedRoom = { id: randomUUID(), homeId: this.homeId, name: cleanName, memberIds, createdAt: at,
      ...(createdBy ? { createdBy } : {}), ...(kind ? { kind } : {}), revision: 1 };
    this.rooms.set(room.id, new SharedRoomLog(room));
    try { this.persist(); }
    catch (error) { this.rooms.delete(room.id); throw error; }
    return room;
  }

  updateRoom(roomId: string, actorId: string, expectedRevision: number, patch: { name?: string; memberIds?: string[] }): SharedRoom {
    const previous = this.rooms.get(roomId);
    if (!previous || !previous.room.memberIds.includes(actorId)) throw new Error("room unavailable");
    if ((previous.room.revision ?? 1) !== expectedRevision) throw new Error("room changed; reload before editing");
    const name = patch.name?.trim() ?? previous.room.name;
    const members = patch.memberIds ?? previous.room.memberIds;
    if (!name || name.length > 100 || members.length < (previous.room.kind === "group" ? 1 : 2) || members.length > 50 || new Set(members).size !== members.length ||
        members.some(id => !parseContactId(id))) throw new Error("invalid room update");
    const room = { ...previous.room, name, memberIds: [...members], revision: expectedRevision + 1 };
    this.rooms.set(roomId, new SharedRoomLog(room, previous.all()));
    try { this.persist(); }
    catch (error) { this.rooms.set(roomId, previous); throw error; }
    return room;
  }

  deleteRoom(roomId: string, actorId: string, expectedRevision: number): void {
    const previous = this.rooms.get(roomId);
    if (!previous || !previous.room.memberIds.includes(actorId)) throw new Error("room unavailable");
    if ((previous.room.revision ?? 1) !== expectedRevision) throw new Error("room changed; reload before deleting");
    this.rooms.delete(roomId);
    try { this.persist(); }
    catch (error) { this.rooms.set(roomId, previous); throw error; }
  }

  append(roomId: string, actorId: string, raw: unknown, at = Date.now()): { message: SharedTextMessage; created: boolean } {
    const log = this.rooms.get(roomId);
    if (!log || (!log.room.memberIds.includes(actorId) && parseContactId(actorId)?.kind !== "bot")) throw new Error("room unavailable");
    // SharedRoomLog permits a non-member bot only for a recorded human invocation.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid shared send");
    const actor = (raw as Record<string, unknown>).actor;
    if (!actor || typeof actor !== "object" || Array.isArray(actor) ||
        contactId(actor as Parameters<typeof contactId>[0]) !== actorId) throw new Error("actor mismatch");
    const input = validateSharedSend(raw);
    const receiptKey = `${roomId}:${actorId}:${input.sendId}`;
    const editedReceipt = this.editedReceipts.get(receiptKey);
    if (editedReceipt) {
      if (this.sendHash(input) !== editedReceipt) throw new Error("send id conflict");
      const message = log.all().find(message => contactId(message.actor) === actorId && message.sendId === input.sendId);
      if (!message) throw new Error("message receipt unavailable");
      return { message, created: false };
    }
    const before = log.all();
    const result = log.append(raw, randomUUID(), at);
    if (!result.created) return result;
    try { this.appendEvent({ roomId, id: result.message.id, at: result.message.at, input: raw }); }
    catch (error) {
      // Recreate from the durable snapshot. A failed disk write must not
      // leave a message visible in memory that a restart would forget.
      this.rooms.set(roomId, new SharedRoomLog(log.room, before));
      throw error;
    }
    return result;
  }

  messagesAfter(roomId: string, actorId: string, sequence: number, limit = 100): SharedTextMessage[] {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) throw new Error("room unavailable");
    return log.after(sequence, limit);
  }

  latestFor(roomId: string, actorId: string, limit = 100): SharedTextMessage[] {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) return [];
    return log.all().slice(-limit);
  }

  /** Page by source message so files from one message never straddle cursors.
   * Only published, non-removed messages enter the index; staged uploads do not. */
  filesFor(roomId: string, actorId: string, before = Number.MAX_SAFE_INTEGER, limit = 30) {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) throw new Error("conversation unavailable");
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid file cursor");
    const sources = log.all().filter(message => message.sequence < before && !message.deletedAt && message.kind !== "activity" && message.attachments?.length).reverse();
    const page = sources.slice(0, limit);
    return {
      files: page.flatMap(message => message.attachments!.map(attachment => ({ attachment, messageId: message.id, sequence: message.sequence, actor: message.actor, at: message.at }))),
      hasMore: sources.length > limit,
      before: page.at(-1)?.sequence ?? null,
    };
  }

  searchFor(roomId: string, actorId: string, options: SharedSearchOptions = {}) {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) throw new Error("conversation unavailable");
    return searchSharedMessages(log.all(), options);
  }

  messageFor(roomId: string, actorId: string, messageId: string): SharedTextMessage | null {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) return null;
    return log.all().find(message => message.id === messageId) ?? null;
  }

  preferencesFor(roomId: string, actorId: string): SharedConversationPreferences {
    if (!this.roomFor(roomId, actorId)) throw new Error("room unavailable");
    return this.preferences.get(roomId)?.get(actorId) ?? { readSequence: 0, notifications: "all" };
  }

  updatePreferences(roomId: string, actorId: string, patch: Partial<SharedConversationPreferences>): SharedConversationPreferences {
    const previous = this.preferencesFor(roomId, actorId);
    const latest = this.allMessages(roomId).at(-1)?.sequence ?? 0;
    if (patch.readSequence !== undefined && (!Number.isSafeInteger(patch.readSequence) || patch.readSequence < 0 || patch.readSequence > latest)) throw new Error("invalid read cursor");
    if (patch.notifications !== undefined && !["all", "mentions", "muted"].includes(patch.notifications)) throw new Error("invalid notification preference");
    const next = { readSequence: Math.max(previous.readSequence, patch.readSequence ?? 0), notifications: patch.notifications ?? previous.notifications };
    if (next.readSequence === previous.readSequence && next.notifications === previous.notifications) return next;
    const values = this.preferences.get(roomId) ?? new Map<string, SharedConversationPreferences>();
    values.set(actorId, next);
    this.preferences.set(roomId, values);
    try { this.persist(); }
    catch (error) { values.set(actorId, previous); throw error; }
    return next;
  }

  editMessage(roomId: string, actorId: string, messageId: string, text: string | null, at = Date.now()): SharedTextMessage {
    const room = this.roomFor(roomId, actorId);
    const previous = this.rooms.get(roomId);
    if (!room || !previous) throw new Error("room unavailable");
    const messages = previous.all();
    const index = messages.findIndex(message => message.id === messageId);
    const target = messages[index];
    if (!target || target.actor.kind !== "person" || contactId(target.actor) !== actorId || target.kind === "activity") throw new Error("only your own messages can be changed");
    if (target.deletedAt) return target;
    if (text !== null && (typeof text !== "string" || text.length > 20_000 || (!text.trim() && !target.attachments?.length))) throw new Error("invalid message text");
    const receiptKey = `${roomId}:${actorId}:${target.sendId}`;
    const hadReceipt = this.editedReceipts.has(receiptKey);
    if (!hadReceipt) this.editedReceipts.set(receiptKey, this.sendHash(target));
    const version = (room.messageVersion ?? 0) + 1;
    const edited = text === null
      ? { ...target, text: "", attachments: [], deletedAt: at, changeSequence: version }
      : { ...target, text: text.trim(), editedAt: at, changeSequence: version };
    messages[index] = edited;
    this.rooms.set(roomId, new SharedRoomLog({ ...room, messageVersion: version }, messages));
    try { this.persist(); }
    catch (error) { this.rooms.set(roomId, previous); if (!hadReceipt) this.editedReceipts.delete(receiptKey); throw error; }
    return edited;
  }

  annotateMessage(roomId: string, actorId: string, messageId: string, patch: { reaction?: unknown; active?: unknown; pinned?: unknown }): SharedTextMessage {
    const room = this.roomFor(roomId, actorId);
    const previous = this.rooms.get(roomId);
    if (!room || !previous || parseContactId(actorId)?.kind !== "person") throw new Error("room unavailable");
    const messages = previous.all();
    const index = messages.findIndex(message => message.id === messageId);
    const target = messages[index];
    if (!target || target.deletedAt || target.kind === "activity") throw new Error("message unavailable");
    const edited = { ...target };
    if (patch.reaction !== undefined) {
      if (!["👍", "❤️", "😂", "🎉", "👀", "✅"].includes(patch.reaction as string) || typeof patch.active !== "boolean" || patch.pinned !== undefined) throw new Error("invalid reaction");
      const emoji = patch.reaction as string;
      const actors = new Set(target.reactions?.[emoji] ?? []);
      if (patch.active) actors.add(actorId); else actors.delete(actorId);
      edited.reactions = { ...target.reactions };
      if (actors.size) edited.reactions[emoji] = [...actors]; else delete edited.reactions[emoji];
    } else {
      if (typeof patch.pinned !== "boolean") throw new Error("invalid pin");
      if (!patch.pinned && target.pinnedBy && target.pinnedBy !== actorId && room.createdBy !== actorId) throw new Error("only the person who pinned this or group creator can unpin it");
      if (patch.pinned && target.pinnedBy) return target;
      edited.pinnedBy = patch.pinned ? actorId : null;
    }
    if (JSON.stringify(edited) === JSON.stringify(target)) return target;
    edited.changeSequence = (room.messageVersion ?? 0) + 1;
    messages[index] = edited;
    this.rooms.set(roomId, new SharedRoomLog({ ...room, messageVersion: edited.changeSequence }, messages));
    try { this.persist(); } catch (error) { this.rooms.set(roomId, previous); throw error; }
    return edited;
  }

  changesAfter(roomId: string, actorId: string, version: number): { changes: SharedTextMessage[]; version: number } {
    const room = this.roomFor(roomId, actorId);
    if (!room) throw new Error("room unavailable");
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("invalid change cursor");
    const changes = this.allMessages(roomId).filter(message => (message.changeSequence ?? 0) > version)
      .sort((a, b) => a.changeSequence! - b.changeSequence!).slice(0, 200);
    return { changes, version: changes.at(-1)?.changeSequence ?? room.messageVersion ?? 0 };
  }

  private sendHash(raw: unknown): string {
    const { humanMentions: _mentions, ...input } = validateSharedSend(raw);
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const snapshot: Snapshot = { version: 1, editedReceipts: Object.fromEntries(this.editedReceipts), preferences: Object.fromEntries([...this.preferences].map(([id, actors]) => [id, Object.fromEntries(actors)])), rooms: [...this.rooms.values()].map(log => ({ room: log.room, messages: log.all() })) };
    writeFileAtomic(this.file, JSON.stringify(snapshot), { mode: 0o600 });
    const journal = `${this.file}.events`;
    if (existsSync(journal)) {
      try { writeFileAtomic(journal, "", { mode: 0o600 }); }
      catch (error) { console.warn(`room journal compaction deferred: ${error instanceof Error ? error.message : "unknown"}`); }
    }
  }

  private appendEvent(event: RoomEvent): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const journal = `${this.file}.events`;
    const previousSize = existsSync(journal) ? statSync(journal).size : 0;
    const fd = openSync(journal, "a", 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
      if (writeSync(fd, bytes) !== bytes.length) throw new Error("short room journal write");
      fsyncSync(fd);
    } catch (error) {
      try { truncateSync(journal, previousSize); } catch { /* replay quarantines a torn entry */ }
      throw error;
    } finally { closeSync(fd); }
  }
}
