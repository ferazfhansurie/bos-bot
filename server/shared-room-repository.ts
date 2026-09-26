import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { quarantineSaved } from "./quarantine-saved.ts";
import { contactId, parseContactId, SharedRoomLog, type SharedRoom, type SharedTextMessage } from "../shared/multiplayer.ts";

interface Snapshot {
  version: 1;
  rooms: Array<{ room: SharedRoom; messages: SharedTextMessage[] }>;
}

/** Canonical-home storage. Caller authenticates the actor before append. */
export class SharedRoomRepository {
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
    let invalid = false;
    for (const entry of snapshot.rooms) {
      try {
        if (entry.room.homeId !== homeId || this.rooms.has(entry.room.id)) throw new Error("invalid shared room storage");
        this.rooms.set(entry.room.id, new SharedRoomLog(entry.room, entry.messages));
      } catch { invalid = true; }
    }
    if (invalid) quarantineSaved(file, { version: 1, rooms: [...this.rooms.values()].map(log => ({ room: log.room, messages: log.all() })) });
  }

  listFor(actorId: string): SharedRoom[] {
    if (!parseContactId(actorId)) return [];
    return [...this.rooms.values()].map(log => log.room).filter(room => room.memberIds.includes(actorId));
  }

  summariesFor(actorId: string): Array<SharedRoom & { lastActivity: number; preview: string }> {
    if (!parseContactId(actorId)) return [];
    return [...this.rooms.values()].filter(log => log.room.memberIds.includes(actorId)).map(log => {
      const last = log.all().findLast(message => message.kind !== "activity");
      return { ...log.room, lastActivity: last?.at ?? 0, preview: last?.text ?? "" };
    });
  }

  roomFor(roomId: string, actorId: string): SharedRoom | null {
    const room = this.rooms.get(roomId)?.room;
    return room?.memberIds.includes(actorId) ? room : null;
  }

  create(name: string, memberIds: string[], at = Date.now()): SharedRoom {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 100) throw new Error("invalid room name");
    if (memberIds.length < 2 || memberIds.length > 50 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => !parseContactId(id))) {
      throw new Error("invalid room roster");
    }
    const room: SharedRoom = { id: randomUUID(), homeId: this.homeId, name: cleanName, memberIds, createdAt: at };
    this.rooms.set(room.id, new SharedRoomLog(room));
    try { this.persist(); }
    catch (error) { this.rooms.delete(room.id); throw error; }
    return room;
  }

  append(roomId: string, actorId: string, raw: unknown, at = Date.now()): { message: SharedTextMessage; created: boolean } {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) throw new Error("room unavailable");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid shared send");
    const actor = (raw as Record<string, unknown>).actor;
    if (!actor || typeof actor !== "object" || Array.isArray(actor) ||
        contactId(actor as Parameters<typeof contactId>[0]) !== actorId) throw new Error("actor mismatch");
    const before = log.all();
    const result = log.append(raw, randomUUID(), at);
    if (!result.created) return result;
    try { this.persist(); }
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

  messageFor(roomId: string, actorId: string, messageId: string): SharedTextMessage | null {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) return null;
    return log.all().find(message => message.id === messageId) ?? null;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const snapshot: Snapshot = { version: 1, rooms: [...this.rooms.values()].map(log => ({ room: log.room, messages: log.all() })) };
    writeFileAtomic(this.file, JSON.stringify(snapshot), { mode: 0o600 });
  }
}
