import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { quarantineSaved } from "./quarantine-saved.ts";
import { contactId, parseContactId, SharedRoomLog, type SharedRoom, type SharedTextMessage } from "../shared/multiplayer.ts";

interface Snapshot {
  version: 1;
  rooms: Array<{ room: SharedRoom; messages: SharedTextMessage[] }>;
}
interface RoomEvent { roomId: string; id: string; at: number; input: unknown }

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

  create(name: string, memberIds: string[], at = Date.now(), createdBy?: string): SharedRoom {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 100) throw new Error("invalid room name");
    if (memberIds.length < 2 || memberIds.length > 50 || new Set(memberIds).size !== memberIds.length || memberIds.some(id => !parseContactId(id))) {
      throw new Error("invalid room roster");
    }
    const room: SharedRoom = { id: randomUUID(), homeId: this.homeId, name: cleanName, memberIds, createdAt: at,
      ...(createdBy ? { createdBy } : {}), revision: 1 };
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
    if (!name || name.length > 100 || members.length < 2 || members.length > 50 || new Set(members).size !== members.length ||
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
    if (!log || !log.room.memberIds.includes(actorId)) throw new Error("room unavailable");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid shared send");
    const actor = (raw as Record<string, unknown>).actor;
    if (!actor || typeof actor !== "object" || Array.isArray(actor) ||
        contactId(actor as Parameters<typeof contactId>[0]) !== actorId) throw new Error("actor mismatch");
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

  messageFor(roomId: string, actorId: string, messageId: string): SharedTextMessage | null {
    const log = this.rooms.get(roomId);
    if (!log || !log.room.memberIds.includes(actorId)) return null;
    return log.all().find(message => message.id === messageId) ?? null;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const snapshot: Snapshot = { version: 1, rooms: [...this.rooms.values()].map(log => ({ room: log.room, messages: log.all() })) };
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
