import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export interface PeerThread { botId: string; threadId: string }
interface Snapshot { version: 1; sessions: Record<string, PeerThread[]>; attachments?: Record<string, string[]> }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ATTACHMENT = /^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/;

/** The only direct bot threads a peer session may read or write. */
export class PeerThreads {
  private readonly sessions = new Map<string, Map<string, string>>();
  private readonly attachments = new Map<string, Set<string>>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    if (saved.version !== 1 || !saved.sessions || typeof saved.sessions !== "object") throw new Error("invalid peer thread grants");
    for (const [sessionId, entries] of Object.entries(saved.sessions)) {
      if (!ID.test(sessionId) || !Array.isArray(entries) || entries.length > 1000) throw new Error("invalid peer thread grants");
      this.sessions.set(sessionId, this.checked(entries));
    }
    for (const [threadId, names] of Object.entries(saved.attachments ?? {})) {
      if (!ID.test(threadId) || !Array.isArray(names) || names.length > 1000 || names.some(name => typeof name !== "string" || !ATTACHMENT.test(name))) {
        throw new Error("invalid peer attachment grants");
      }
      this.attachments.set(threadId, new Set(names));
    }
  }

  private checked(entries: PeerThread[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const entry of entries) {
      if (!entry || !ID.test(entry.botId) || !ID.test(entry.threadId)) throw new Error("invalid peer thread grant");
      if (result.has(entry.threadId) && result.get(entry.threadId) !== entry.botId) throw new Error("conflicting peer thread grant");
      result.set(entry.threadId, entry.botId);
    }
    return result;
  }

  grant(sessionId: string, entries: PeerThread[]): void {
    if (!ID.test(sessionId) || entries.length > 1000) throw new Error("invalid peer thread grants");
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, this.checked(entries));
    try { this.persist(); }
    catch (error) { if (previous) this.sessions.set(sessionId, previous); else this.sessions.delete(sessionId); throw error; }
  }

  add(sessionId: string, entry: PeerThread): void {
    const entries = this.list(sessionId);
    if (entries.some(candidate => candidate.threadId === entry.threadId)) return;
    this.grant(sessionId, [...entries, entry]);
  }

  owns(sessionId: string, botId: string, threadId: string): boolean {
    return this.sessions.get(sessionId)?.get(threadId) === botId;
  }

  botFor(sessionId: string, threadId: string): string | null {
    return this.sessions.get(sessionId)?.get(threadId) ?? null;
  }

  /** The thread id is globally unique. A rotated token inherits the thread,
   * while an unrelated peer cannot read it without its own thread grant. */
  recordAttachment(threadId: string, name: string): void {
    if (!ID.test(threadId) || !ATTACHMENT.test(name)) throw new Error("invalid peer attachment grant");
    const previous = this.attachments.get(threadId);
    const next = new Set(previous);
    next.add(name);
    if (next.size > 1000) throw new Error("peer attachment limit reached");
    this.attachments.set(threadId, next);
    try { this.persist(); }
    catch (error) { if (previous) this.attachments.set(threadId, previous); else this.attachments.delete(threadId); throw error; }
  }

  hasAttachment(threadId: string, name: string): boolean {
    return this.attachments.get(threadId)?.has(name) ?? false;
  }

  list(sessionId: string): PeerThread[] {
    return [...(this.sessions.get(sessionId) ?? new Map())].map(([threadId, botId]) => ({ botId, threadId }));
  }

  revoke(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const sessions = Object.fromEntries([...this.sessions].map(([id]) => [id, this.list(id)]));
    const attachments = Object.fromEntries([...this.attachments].map(([id, names]) => [id, [...names]]));
    writeFileAtomic(this.file, JSON.stringify({ version: 1, sessions, attachments } satisfies Snapshot), { mode: 0o600 });
  }
}
