import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
const id = z.string().regex(/^[\w-]{1,128}$/);
const reviewer = z.string().min(1).max(200).refine(value => value.trim().length > 0, "review actor must not be blank");
const record = z.object({ id, botId: id, threadId: id, sourceId: id.optional(), groupId: id.optional(), cwd: z.string().refine(isAbsolute).optional(), workspace: z.string().refine(value => value.startsWith("workspace:") && isAbsolute(value.slice("workspace:".length))).optional(),
  state: z.enum(["dispatching", "outcome-unknown"]), providerTurnId: z.string().min(1).max(200).optional(),
  createdAt: z.number().int().nonnegative(), serverPid: z.number().int().positive().optional(), hostGeneration: id.optional(), reviewedAt: z.number().int().positive().optional(), reviewedBy: reviewer.optional() }).strict()
  .refine(row => (row.reviewedAt === undefined && row.reviewedBy === undefined) ||
    (row.state === "outcome-unknown" && row.reviewedAt !== undefined && row.reviewedBy !== undefined), "invalid private dispatch review audit");
const binding = z.object({ threadId: id, providerTurnId: z.string().min(1).max(200), generation: id }).strict();
export type PrivateTurnDispatch = z.infer<typeof record>;
/** Authority records only: never a work queue. A dead host's receipts require
 * review; neither a server restart nor a duplicate generation dispatches them. */
export class PrivateTurnDispatches {
  private records = new Map<string, PrivateTurnDispatch>();
  private bindings = new Map<string, z.infer<typeof binding>>();
  private file: string;
  constructor(file: string) {
    this.file = file;
    if (!existsSync(file)) return;
    const saved = z.object({ version: z.literal(1), records: z.array(record), bindings: z.array(binding).optional() }).strict().parse(JSON.parse(readFileSync(file, "utf8")));
    for (const entry of saved.bindings ?? []) {
      const key = JSON.stringify([entry.threadId, entry.providerTurnId]);
      if (this.bindings.has(key)) throw new Error("duplicate private provider binding");
      this.bindings.set(key, entry);
    }
    for (const row of saved.records) {
      if (this.records.has(row.id)) throw new Error("duplicate private dispatch generation");
      this.records.set(row.id, row);
      if (row.providerTurnId) {
        const key = JSON.stringify([row.threadId, row.providerTurnId]);
        const existing = this.bindings.get(key);
        if (existing && existing.generation !== row.id) throw new Error("ambiguous private provider binding");
        this.bindings.set(key, { threadId: row.threadId, providerTurnId: row.providerTurnId, generation: row.id });
      }
    }
  }
  all(): PrivateTurnDispatch[] { return [...this.records.values()].map(row => ({ ...row })); }
  pending(): PrivateTurnDispatch[] { return this.all().filter(row => row.reviewedAt === undefined || row.reviewedBy === undefined); }
  acknowledge(generation: string, botId: string, threadId: string, actor: string): PrivateTurnDispatch {
    const row = this.records.get(generation);
    if (!row || row.botId !== botId || row.threadId !== threadId) throw Object.assign(new Error("Recovery receipt scope does not match"), { status: 404 });
    if (row.state !== "outcome-unknown") throw Object.assign(new Error("This request is still active; finish or stop it before review"), { status: 409 });
    reviewer.parse(actor);
    if (row.reviewedAt !== undefined && row.reviewedBy !== undefined) return { ...row };
    const next = record.parse({ ...row, reviewedAt: Date.now(), reviewedBy: actor });
    this.change(() => this.records.set(generation, next));
    return { ...next };
  }
  prepare(input: Omit<PrivateTurnDispatch, "state" | "providerTurnId" | "reviewedAt" | "reviewedBy">): void {
    if (this.records.has(input.id) || [...this.bindings.values()].some(entry => entry.generation === input.id)) throw new Error("private dispatch generation already used");
    this.change(() => this.records.set(input.id, record.parse({ ...input, state: "dispatching" })));
  }
  bind(generation: string, providerTurnId: string): void {
    const row = this.records.get(generation);
    if (!row) return; // An early completion may already have retired it.
    if (row.providerTurnId && row.providerTurnId !== providerTurnId) throw new Error("private dispatch provider identity changed");
    const key = JSON.stringify([row.threadId, providerTurnId]);
    const existing = this.bindings.get(key);
    if (existing && existing.generation !== generation) throw new Error("private provider identity reused across generations");
    this.change(() => {
      this.bindings.set(key, binding.parse({ threadId: row.threadId, providerTurnId, generation }));
      this.records.set(generation, record.parse({ ...row, providerTurnId }));
    });
  }
  hold(generation: string): void {
    const row = this.records.get(generation);
    if (!row || row.state === "outcome-unknown") return;
    this.change(() => this.records.set(generation, { ...row, state: "outcome-unknown" }));
  }
  settle(generation: string, threadId: string, providerTurnId: string): boolean {
    const row = this.records.get(generation);
    if (!row || row.state !== "dispatching" || row.threadId !== threadId || row.providerTurnId !== providerTurnId) return false;
    this.change(() => { this.records.delete(generation); });
    // Provider identity tombstones are retained: silently evicting them could
    // let a stale terminal event retire a newer generation after id reuse.
    return true;
  }
  private change(mutate: () => void): void {
    const previous = new Map(this.records), previousBindings = new Map(this.bindings);
    mutate();
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify({ version: 1, records: this.all(), bindings: [...this.bindings.values()] }), { mode: 0o600 });
    } catch (error) { this.records = previous; this.bindings = previousBindings; throw error; }
  }
}
