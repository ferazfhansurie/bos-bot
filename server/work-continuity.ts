import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(4000);
const stepSchema = z.object({
  id, ownerBotId: id, action: text,
  status: z.enum(["ready", "waiting", "blocked", "done"]),
  dependsOn: z.array(id).max(40), reason: text.optional(), evidence: text.optional(),
}).strict();
const teamCheckSchema = z.array(z.object({
  botId: id, decision: z.enum(["assign", "already_working", "no_ready_work", "unavailable"]),
  reason: text, stepIds: z.array(id).max(40).default([]),
}).strict()).max(100);
export const workPlanInputSchema = z.object({
  outcome: text, status: z.enum(["active", "paused", "blocked", "completed"]),
  steps: z.array(stepSchema).min(1).max(40), reason: text.optional(),
  expectedRevision: z.number().int().nonnegative(),
  teamCheck: teamCheckSchema.optional(),
}).strict().superRefine((plan, ctx) => {
  const steps = new Map(plan.steps.map(step => [step.id, step]));
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (steps.size !== plan.steps.length) invalid("Step ids must be unique");
  for (const step of plan.steps) {
    if (step.status === "done" && !step.evidence) invalid("Done steps require verification evidence");
    if ((step.status === "waiting" || step.status === "blocked") && !step.reason) invalid("Held steps require a reason");
    for (const dependency of step.dependsOn) {
      if (!steps.has(dependency)) invalid("Dependency must name an existing step");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycle = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    if (steps.get(key)?.dependsOn.some(cycle)) return true;
    visiting.delete(key); visited.add(key); return false;
  };
  if ([...steps.keys()].some(cycle)) invalid("Dependencies must not contain cycles");
  if (plan.status === "completed" && plan.steps.some(step => step.status !== "done")) invalid("Completed plans require all steps verified done");
  if ((plan.status === "paused" || plan.status === "blocked") && !plan.reason) invalid("Held plans require a reason");
});
const recordSchema = z.object({
  botId: id, threadId: id, revision: z.number().int().positive(),
  plan: workPlanInputSchema,
  chainId: id.optional(), attempts: z.number().int().min(0).max(2),
  terminalIds: z.array(id).max(3),
}).strict();
type Record = z.infer<typeof recordSchema>;
export type WorkPlan = Omit<Record, "plan"> & Omit<z.infer<typeof workPlanInputSchema>, "expectedRevision">;
export type ContinuationGate = {
  /** Server-owned causal user round; never accept this from an agent tool. */
  chainId: string; turnId: string;
  allowed: boolean; cancelled: boolean; awaitingApproval: boolean; providerSucceeded: boolean;
};
export type ContinuationDecision = { kind: "idle" } | { kind: "continue" | "limited"; steps: z.infer<typeof stepSchema>[]; revision: number };

export type TeamCandidate = { botId: string; available: boolean; hasOutstandingWork: boolean };
/** A mandatory structural check for opted-in leads. The caller supplies the
 * current reachable roster and actual outstanding assignments, never the model.
 * Decisions describe work; they do not grant authority or send messages. */
export function assessTeamWork(plan: Pick<WorkPlan, "steps" | "teamCheck">, candidates: readonly TeamCandidate[]) {
  const errors: string[] = [];
  const assignments: z.infer<typeof stepSchema>[] = [];
  const checks = plan.teamCheck ?? [];
  const checked = new Set<string>();
  const assigned = new Set<string>();
  for (const check of checks) {
    const candidate = candidates.find(peer => peer.botId === check.botId);
    if (!candidate || checked.has(check.botId)) { errors.push(`Invalid or duplicate teammate ${check.botId}`); continue; }
    checked.add(check.botId);
    if (check.decision === "already_working" && !candidate.hasOutstandingWork) errors.push(`No outstanding work for ${check.botId}`);
    if (check.decision === "unavailable" && candidate.available) errors.push(`Teammate ${check.botId} is available`);
    if (check.decision !== "assign") {
      if (check.stepIds.length) errors.push(`Non-assignment decision has steps for ${check.botId}`);
      continue;
    }
    if (!candidate.available || !check.stepIds.length) { errors.push(`No eligible assignment for ${check.botId}`); continue; }
    for (const stepId of check.stepIds) {
      const step = plan.steps.find(item => item.id === stepId);
      if (!step || step.ownerBotId !== check.botId || step.status !== "ready" || assigned.has(stepId)
        || !step.dependsOn.every(key => plan.steps.some(dependency => dependency.id === key && dependency.status === "done"))) {
        errors.push(`Step ${stepId} is not independently ready for ${check.botId}`); continue;
      }
      assigned.add(stepId); assignments.push(structuredClone(step));
    }
  }
  for (const peer of candidates) if (!checked.has(peer.botId)) errors.push(`Missing team decision for ${peer.botId}`);
  for (const step of plan.steps) {
    if (candidates.some(peer => peer.botId === step.ownerBotId) && step.status === "ready"
      && step.dependsOn.every(key => plan.steps.some(dependency => dependency.id === key && dependency.status === "done"))
      && !assigned.has(step.id)) errors.push(`Ready helper step ${step.id} has no assignment`);
  }
  return { errors, assignments: errors.length ? [] : assignments };
}

/** A durable opt-in work ledger. It never launches providers or assigns peers.
 * Runtime callers must recheck authority, Stop, approvals and ownership before
 * dispatch. Loading a ledger at boot must not start any work. */
export class WorkContinuity {
  private records: Record[] = [];
  private broken = false;
  constructor(private file: string) {
    try { this.records = z.array(recordSchema).max(2000).parse(JSON.parse(readFileSync(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.broken = true; }
  }
  private ready() { if (this.broken) throw new Error("Work plan storage is unreadable; no automatic continuation is permitted"); }
  private find(botId: string, threadId: string) { return this.records.find(record => record.botId === botId && record.threadId === threadId); }
  private persist(record: Record) {
    this.ready();
    const next = this.records.filter(prior => prior.botId !== record.botId || prior.threadId !== record.threadId);
    if (next.length >= 2000) throw new Error("Too many work plans");
    next.push(record);
    writeFileAtomic(this.file, JSON.stringify(next), { mode: 0o600 });
    this.records = next;
  }
  get(botId: string, threadId: string): WorkPlan | undefined {
    this.ready(); const record = this.find(botId, threadId);
    if (!record) return undefined;
    const { plan, ...metadata } = record;
    const { expectedRevision: _expectedRevision, ...body } = plan;
    return structuredClone({ ...metadata, ...body });
  }
  set(botId: string, threadId: string, input: unknown): WorkPlan {
    this.ready(); id.parse(botId); id.parse(threadId);
    const plan = workPlanInputSchema.parse(input);
    const prior = this.find(botId, threadId);
    if (plan.expectedRevision !== (prior?.revision ?? 0)) throw Object.assign(new Error("Work plan changed; read it before updating"), { status: 409 });
    this.persist({ botId, threadId, plan, revision: (prior?.revision ?? 0) + 1,
      attempts: prior?.attempts ?? 0, terminalIds: prior?.terminalIds ?? [], ...(prior?.chainId ? { chainId: prior.chainId } : {}) });
    return this.get(botId, threadId)!;
  }
  claim(botId: string, threadId: string, gate: ContinuationGate): ContinuationDecision {
    this.ready();
    if (!gate.allowed || gate.cancelled || gate.awaitingApproval || !gate.providerSucceeded) return { kind: "idle" };
    id.parse(gate.chainId); id.parse(gate.turnId);
    const record = this.find(botId, threadId);
    if (!record || record.plan.status !== "active") return { kind: "idle" };
    const steps = record.plan.steps.filter(step => step.ownerBotId === botId && step.status === "ready"
      && step.dependsOn.every(key => record.plan.steps.some(dependency => dependency.id === key && dependency.status === "done")));
    if (!steps.length) return { kind: "idle" };
    const sameChain = record.chainId === gate.chainId;
    if (sameChain && record.terminalIds.includes(gate.turnId)) return { kind: "idle" };
    const attempts = sameChain ? record.attempts : 0;
    if (attempts >= 2) return { kind: "limited", steps: structuredClone(steps), revision: record.revision };
    this.persist({ ...record, chainId: gate.chainId, attempts: attempts + 1,
      terminalIds: [...(sameChain ? record.terminalIds : []), gate.turnId] });
    return { kind: "continue", steps: structuredClone(steps), revision: record.revision };
  }
}
