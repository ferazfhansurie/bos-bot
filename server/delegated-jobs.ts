import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { DelegatedIdentity } from "./cross-home-delegations.ts";
const identitySchema = z.object({ homeId: z.string(), botId: z.string(), sessionId: z.string(), tokenHash: z.string() }).strict();
const sameIdentity = (a: DelegatedIdentity, b: DelegatedIdentity) => a.homeId === b.homeId && a.botId === b.botId && a.sessionId === b.sessionId && a.tokenHash === b.tokenHash;
const jobSchema = z.object({ id: z.string(), identity: identitySchema, targetBotId: z.string(), requestKey: z.string(), message: z.string(),
  label: z.string().optional(), threadId: z.string().optional(), createdAt: z.number(),
  status: z.enum(["queued", "running", "completed", "failed"]), result: z.string() }).strict();
export class DelegatedJobError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}
export type DelegatedJob = z.infer<typeof jobSchema>;
export class DelegatedJobs {
  private jobs: DelegatedJob[] = [];
  private failed = false;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    try {
      this.jobs = z.array(jobSchema).max(10000).parse(JSON.parse(readFileSync(file, "utf8")));
      for (const job of this.jobs) if (["queued", "running"].includes(job.status)) {
        job.status = "failed"; job.result = "Interrupted by server restart; not replayed.";
      }
      this.save();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failed = true; }
  }
  private save() { writeFileAtomic(this.file, JSON.stringify(this.jobs), { mode: 0o600 }); }
  pending() { return this.failed ? [] : this.jobs.filter(job => job.status === "queued"); }
  get(id: string, identity: DelegatedIdentity) {
    if (this.failed) throw new DelegatedJobError("Delegated receipt storage is unavailable", 503);
    return this.jobs.find(job => job.id === id && sameIdentity(job.identity, identity));
  }
  enqueue(input: { identity: DelegatedIdentity; targetBotId: string; requestKey: string; message: string; label?: string }) {
    if (this.failed) throw new DelegatedJobError("Delegated receipt storage is unreadable; repair before sending work", 503);
    const previous = this.jobs.find(job => job.identity.homeId === input.identity.homeId && job.identity.botId === input.identity.botId && job.requestKey === input.requestKey && job.targetBotId === input.targetBotId);
    if (previous) {
      if (!sameIdentity(previous.identity, input.identity) || previous.message !== input.message || previous.label !== input.label) throw new DelegatedJobError("requestKey was already used for different work or authority");
      return { job: previous, duplicate: true };
    }
    // Never evict idempotency receipts: refusal is safer than replay.
    if (this.jobs.length >= 10000) throw new DelegatedJobError("Delegated receipt limit reached");
    const job: DelegatedJob = { ...input, id: randomUUID(), createdAt: Date.now(), status: "queued", result: "" };
    this.jobs.push(job);
    try { this.save(); } catch (error) { this.jobs.pop(); this.failed = true; throw error; }
    return { job, duplicate: false };
  }
  patch(job: DelegatedJob, patch: Partial<Pick<DelegatedJob, "threadId" | "status" | "result">>) {
    const before = { ...job }; Object.assign(job, patch);
    try { this.save(); } catch (error) { Object.assign(job, before); this.failed = true; throw error; }
  }
}
