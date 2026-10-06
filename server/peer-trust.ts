import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

interface Snapshot { version: 1; sessions: string[] }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Peer sessions the owner explicitly trusts. Their threads run with the
 * bot's full soul, memory, recent work and tools instead of the
 * conversation-only shared policy. Trust follows token rotation. */
export class TrustedPeers {
  private readonly sessions = new Set<string>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error("invalid trusted peers");
    for (const id of saved.sessions) {
      if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid trusted peer");
      this.sessions.add(id);
    }
  }

  has(sessionId: string): boolean { return this.sessions.has(sessionId); }

  list(): string[] { return [...this.sessions]; }

  set(sessionId: string, trusted: boolean): void {
    if (!ID.test(sessionId)) throw new Error("invalid trusted peer");
    if (trusted === this.sessions.has(sessionId)) return;
    if (trusted) this.sessions.add(sessionId); else this.sessions.delete(sessionId);
    try { this.persist(); }
    catch (error) { if (trusted) this.sessions.delete(sessionId); else this.sessions.add(sessionId); throw error; }
  }

  /** A rotated or migrated peer token keeps the trust of the one it replaces. */
  carry(from: string, to: string): void {
    if (this.sessions.has(from)) this.set(to, true);
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, sessions: [...this.sessions] } satisfies Snapshot), { mode: 0o600 });
  }
}
