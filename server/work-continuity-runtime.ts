import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const rowSchema = z.object({ botId: z.string(), threadId: z.string(), chainId: z.string(), held: z.boolean(), heldAtChain: z.string().optional(), preflight: z.boolean(), assignments: z.record(z.string(), z.string()) }).strict();
/** Server-owned causal round, Stop hold and accepted queue receipts. Never
 * starts work on load. The model cannot write or reset these fields. */
export class WorkRuntimeLedger {
  private rows: z.infer<typeof rowSchema>[] = [];
  private broken = false;
  private file: string;
  constructor(file: string) {
    this.file = file;
    try { this.rows = z.array(rowSchema).max(2000).parse(JSON.parse(readFileSync(file, "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.broken = true; }
  }
  private save() { if (this.broken) throw new Error("Work runtime storage unavailable"); try { writeFileAtomic(this.file, JSON.stringify(this.rows), { mode: 0o600 }); } catch (error) { this.broken = true; throw error; } }
  /** Read Stop state without creating a round or changing its causal chain. */
  isHeld(botId: string, threadId: string): boolean {
    if (this.broken) throw new Error("Work runtime storage unavailable");
    return this.rows.find(row => row.botId === botId && row.threadId === threadId)?.held ?? false;
  }
  round(botId: string, threadId: string, chainId: string) {
    if (this.broken) throw new Error("Work runtime storage unavailable");
    let row = this.rows.find(r => r.botId === botId && r.threadId === threadId);
    if (!row) { if (this.rows.length >= 2000) throw new Error("Too many work rounds"); row = { botId, threadId, chainId, held: false, preflight: false, assignments: {} }; this.rows.push(row); this.save(); }
    else if (row.chainId !== chainId) { row.chainId = chainId; row.preflight = false; this.save(); }
    // A Stop holds only the chain it was pressed in; a newer human request is not starved by it.
    return { ...structuredClone(row), held: row.held && (row.heldAtChain === undefined || row.heldAtChain === chainId) };
  }
  hold(botId: string, threadId: string, chainId: string) { this.round(botId, threadId, chainId); this.rows.find(r => r.botId === botId && r.threadId === threadId)!.held = true; this.rows.find(r => r.botId === botId && r.threadId === threadId)!.heldAtChain = chainId; this.save(); }
  resume(botId: string, threadId: string, chainId: string) { this.round(botId, threadId, chainId); this.rows.find(r => r.botId === botId && r.threadId === threadId)!.held = false; this.save(); }
  retry(botId: string, threadId: string, chainId: string) { const r = this.round(botId, threadId, chainId); if (r.held || r.preflight) return false; this.rows.find(r => r.botId === botId && r.threadId === threadId)!.preflight = true; this.save(); return true; }
  receipt(botId: string, threadId: string, chainId: string, key: string, requestId?: string) {
    const r = this.round(botId, threadId, chainId);
    if (requestId) { this.rows.find(r => r.botId === botId && r.threadId === threadId)!.assignments[key] = requestId; this.save(); }
    return r.assignments[key];
  }
}
