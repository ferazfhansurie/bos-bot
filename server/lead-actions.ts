import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
const text = z.string().trim().min(1).max(12_000);
export const leadReportSchema = z.object({ groupId: text, threadId: text, messageId: text, runId: text,
  reporterBotId: text, leadBotId: text, kind: z.enum(["completion", "blocker", "correction"]), requiredAction: text, report: text, requestKey: z.string().trim().min(1).max(100).optional() }).strict();
export const leadResolutionSchema = z.object({ decision: text, evidence: text, expectedUpdatedAt: z.number().int().nonnegative() }).strict();
const actionSchema = leadReportSchema.extend({ id: text, status: z.enum(["pending", "blocked", "resolved"]), createdAt: z.number(), updatedAt: z.number(),
  resolution: z.object({ decision: text, evidence: text, by: text, at: z.number() }).optional() });
export type LeadAction = z.infer<typeof actionSchema>;
/** Durable receipts; no timers, replay, implicit acknowledgement or inferred success. */
export class LeadActions {
  private actions: LeadAction[] = [];
  private broken = false;
  private file: string;
  constructor(file: string) {
    this.file = file;
    try { this.actions = z.array(actionSchema).max(2000).parse(JSON.parse(readFileSync(file, "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.broken = true; }
  }
  private ready() { if (this.broken) throw new Error("Lead action storage is unreadable; repair it before changing reports"); }
  private persist(actions: LeadAction[]) { this.ready(); writeFileAtomic(this.file, JSON.stringify(actions), { mode: 0o600 }); this.actions = actions; }
  list(): LeadAction[] { this.ready(); return structuredClone(this.actions); }
  report(input: z.infer<typeof leadReportSchema>): LeadAction {
    this.ready(); const source = leadReportSchema.parse(input);
    const existing = this.actions.find(a => a.groupId === source.groupId && a.threadId === source.threadId && a.messageId === source.messageId && a.leadBotId === source.leadBotId && a.kind === source.kind);
    if (existing) { if (JSON.stringify(leadReportSchema.strip().parse(existing)) !== JSON.stringify(source)) throw new Error("Source report already recorded with different content"); return structuredClone(existing); }
    const now = Date.now(); const action: LeadAction = { ...source, id: randomUUID(), status: source.kind === "blocker" ? "blocked" : "pending", createdAt: now, updatedAt: now };
    const retained = this.actions.length < 2000 ? this.actions : this.actions.filter(a => a.status !== "resolved");
    if (retained.length >= 2000) throw new Error("Too many open lead actions");
    this.persist([...retained, action]); return structuredClone(action);
  }
  resolve(id: string, input: z.infer<typeof leadResolutionSchema>, actor: string): LeadAction {
    this.ready(); const resolution = leadResolutionSchema.parse(input); const action = this.actions.find(a => a.id === id);
    if (!action || actor !== action.leadBotId) throw Object.assign(new Error("Only the accountable lead can resolve this report"), { status: 403 });
    if (action.status === "resolved" || resolution.expectedUpdatedAt !== action.updatedAt) throw Object.assign(new Error("Report changed; read it again before resolving"), { status: 409 });
    if (resolution.evidence.toLowerCase() === action.report.toLowerCase()) throw Object.assign(new Error("Resolution requires changed evidence, not the original report"), { status: 409 });
    const at = Math.max(Date.now(), action.updatedAt + 1);
    const updated: LeadAction = { ...action, status: "resolved", updatedAt: at, resolution: { decision: resolution.decision, evidence: resolution.evidence, by: actor, at } };
    this.persist(this.actions.map(a => a.id === id ? updated : a)); return structuredClone(updated);
  }
}
/** Explicit leading status + one exact room-member tag; ordinary chatter is inert. */
export function taggedLeadReport(value: string, members: readonly { id: string; name: string }[]) {
  const status = /^\s*(done|completed|completion|blocked|blocker|correction)\b[:\s-]*/i.exec(value);
  if (!status) return undefined;
  const tagged = members.filter(m => [m.id, m.name].some(name => value.includes(`@${name}`) && new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|:|,|$)`, "i").test(value)));
  if (tagged.length !== 1) return undefined;
  const requiredAction = value.slice(status[0].length).replace(new RegExp(`@(?:${[tagged[0].id, tagged[0].name].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[:\\s]*`, "i"), "").trim();
  if (!requiredAction) return undefined;
  return { leadBotId: tagged[0].id, kind: /block/i.test(status[1]) ? "blocker" as const : /correction/i.test(status[1]) ? "correction" as const : "completion" as const, requiredAction };
}
