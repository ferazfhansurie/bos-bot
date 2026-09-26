import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

interface Snapshot { version: 1; pending: Record<string, string> }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A new token confirms its own durable handoff by making its first request. */
export class PeerHandoffs {
  private readonly pending = new Map<string, string>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    const saved = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    if (saved.version !== 1 || !saved.pending || typeof saved.pending !== "object") throw new Error("invalid peer handoff state");
    for (const [oldId, newId] of Object.entries(saved.pending)) {
      if (!ID.test(oldId) || !ID.test(newId)) throw new Error("invalid peer handoff state");
      this.pending.set(oldId, newId);
    }
  }

  prepare(oldId: string, newId: string): string | null {
    if (!ID.test(oldId) || !ID.test(newId) || oldId === newId) throw new Error("invalid peer handoff");
    const previous = this.pending.get(oldId) ?? null;
    this.pending.set(oldId, newId);
    try { this.persist(); }
    catch (error) { if (previous) this.pending.set(oldId, previous); else this.pending.delete(oldId); throw error; }
    return previous;
  }

  confirm(newId: string): string | null {
    const row = [...this.pending].find(([, pendingId]) => pendingId === newId);
    if (!row) return null;
    this.pending.delete(row[0]);
    try { this.persist(); }
    catch (error) { this.pending.set(row[0], row[1]); throw error; }
    return row[0];
  }

  forget(sessionId: string): void {
    const row = [...this.pending].find(([oldId, newId]) => oldId === sessionId || newId === sessionId);
    if (!row) return;
    this.pending.delete(row[0]);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, pending: Object.fromEntries(this.pending) } satisfies Snapshot), { mode: 0o600 });
  }
}
