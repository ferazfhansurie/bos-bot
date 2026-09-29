import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";
type Hooks = { idle: () => boolean; pause: () => void; resume: () => void; flush: () => Promise<void> };
export type UpdateReceipt = { version: 1; generation: string; pid: number; nonce: string; state: "prepared" | "committed" | "cancelled"; preparedAt: string };
const request = z.object({ action: z.enum(["prepare", "commit", "cancel"]), expectedPid: z.number().int().positive(), nonce: z.string().regex(/^[\w-]{16,128}$/) }).strict();
const generationPattern = /^[a-f0-9-]{36}$/;
const hostRecord = z.object({ version: z.literal(1), generation: z.string().regex(generationPattern), pid: z.number().int().positive(),
  children: z.array(z.number().int().positive()), phase: z.enum(["starting", "running", "quit", "update", "maintenance"]),
  startedAt: z.number().finite().positive(), readyAt: z.number().finite().nullable() });

export function readPreparedUpdateReceipt(dataDir: string, generation: string | undefined): UpdateReceipt | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(dataDir, "desktop-update-receipt.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Update receipt is unreadable; startup held"); }
  const schema = z.object({ version: z.literal(1), generation: z.string().regex(generationPattern), pid: z.number().int().positive(), nonce: z.string().regex(/^[\w-]{16,128}$/), state: z.enum(["prepared", "committed", "cancelled"]), preparedAt: z.string() });
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Update receipt is invalid; startup held");
  if (!generation || !generationPattern.test(generation)) throw new Error("Desktop generation is unavailable; startup held");
  if (parsed.data.generation !== generation) return null;
  if (parsed.data.state === "prepared" || parsed.data.state === "committed") return parsed.data;
  // Cancellation and main's handoff intent live in different processes. A
  // crash between cancelled persistence and its recheck must still hold if
  // main committed update intent, or its record can no longer be verified.
  let parent: unknown;
  try { parent = JSON.parse(readFileSync(join(dataDir, "desktop-lifecycle.json"), "utf8")); }
  catch { throw new Error("Cancelled update parent intent is unverifiable; startup held"); }
  const current = hostRecord.safeParse(parent);
  if (!current.success || current.data.generation !== generation) throw new Error("Cancelled update parent generation is unverifiable; startup held");
  return ["starting", "running"].includes(current.data.phase) ? null : { ...parsed.data, state: "prepared" };
}
export function assertUpdateCancellationSafe(dataDir: string, generation: string, childPid: number): void {
  const refusal = () => Object.assign(new Error("Desktop update intent is committed or unverifiable; cancellation remains held"), { status: 409 });
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(dataDir, "desktop-lifecycle.json"), "utf8")); }
  catch { throw refusal(); }
  const parsed = hostRecord.safeParse(value);
  if (!parsed.success || parsed.data.generation !== generation || !parsed.data.children.includes(childPid) ||
      (parsed.data.readyAt !== null && parsed.data.readyAt < parsed.data.startedAt) || !["starting", "running"].includes(parsed.data.phase)) throw refusal();
}
export class DesktopUpdateLifecycle {
  private receipt: UpdateReceipt | null = null;
  private mutating = false;
  private gate: WorkspaceBackupMaintenance;
  private pid: number;
  private hooks: Hooks;
  private generation: string;
  private assertCancellation: () => void;
  private persist: (receipt: UpdateReceipt) => Promise<void>;
  constructor(gate: WorkspaceBackupMaintenance, pid: number, hooks: Hooks, persist: (receipt: UpdateReceipt) => Promise<void>, generation: string, restored: UpdateReceipt | null = null, assertCancellation: () => void = () => {}) {
    this.gate = gate; this.pid = pid; this.hooks = hooks; this.persist = persist; this.generation = generation; this.assertCancellation = assertCancellation;
    if (restored) {
      this.receipt = { ...restored, pid };
      this.gate.restoreUpdate(restored.nonce, hooks.resume);
      hooks.pause();
    }
  }
  async handle(authorized: boolean, body: unknown): Promise<UpdateReceipt> {
    if (!authorized) throw Object.assign(new Error("Desktop update authority required"), { status: 403 });
    const parsed = request.safeParse(body);
    if (!parsed.success) throw Object.assign(new Error("Invalid update lifecycle request"), { status: 400 });
    const { action, expectedPid, nonce } = parsed.data;
    if (expectedPid !== this.pid) throw Object.assign(new Error("Server identity changed"), { status: 409 });
    if (!generationPattern.test(this.generation)) throw Object.assign(new Error("Desktop generation unavailable; update refused"), { status: 503 });
    if (this.mutating) throw Object.assign(new Error("Update lifecycle mutation is already active"), { status: 409 });
    this.mutating = true;
    try {
      if (action === "prepare") {
        if (this.receipt?.nonce === nonce && this.gate.active) return { ...this.receipt };
        const receipt: UpdateReceipt = { version: 1, generation: this.generation, pid: this.pid, nonce, state: "prepared", preparedAt: new Date().toISOString() };
        await this.gate.prepareUpdate(nonce, async () => { await this.persist(receipt); }, this.hooks);
        this.receipt = receipt;
        return { ...receipt };
      }
      if (!this.receipt || this.receipt.nonce !== nonce || !this.gate.active) throw Object.assign(new Error("Update ownership does not match"), { status: 409 });
      if (action === "commit") {
        // Commit is the single serialized installation authority. From here a
        // failed/uncertain parent handoff can never cancel or reopen work.
        this.receipt = { ...this.receipt, state: "committed" };
        await this.persist(this.receipt);
        return { ...this.receipt };
      }
      if (this.receipt.state === "committed") throw Object.assign(new Error("Update handoff is committed; cancellation remains held"), { status: 409 });
      this.assertCancellation();
      const receipt: UpdateReceipt = { ...this.receipt, state: "cancelled" };
      await this.persist(receipt);
      try { this.assertCancellation(); }
      catch (error) { await this.persist(this.receipt); throw error; }
      this.gate.cancelUpdate(nonce);
      this.receipt = null;
      return receipt;
    } finally { this.mutating = false; }
  }
}
