import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkContinuity } from "./work-continuity.ts";

const plan = { outcome: "package release", status: "active" as const, steps: [
  { id: "mobile", ownerBotId: "mobile", action: "finish editor", status: "waiting" as const, reason: "helper running", dependsOn: [] },
  { id: "bos", ownerBotId: "bos", action: "prepare packaging", status: "ready" as const, dependsOn: [] },
  { id: "install", ownerBotId: "human", action: "install", status: "waiting" as const, reason: "reserved for human", dependsOn: ["bos", "mobile"] },
] };
const gate = { chainId: "user-round", turnId: "turn-1", allowed: true, cancelled: false, awaitingApproval: false, providerSucceeded: true };
function fixture(run: (s: WorkContinuity, file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "work-continuity-"));
  try { const file = join(dir, "plans.json"); run(new WorkContinuity(file), file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
it("keeps independent lead work ready while helper and human gates wait", () => fixture(s => {
  const saved = s.set("bos", "thread", { ...plan, expectedRevision: 0 });
  expect(s.claim("bos", "thread", gate)).toMatchObject({ kind: "continue", steps: [{ id: "bos" }] });
  expect(s.get("mobile", "thread")).toBeUndefined();
  expect(saved.revision).toBe(1);
}));
it("does not infer readiness from prose or bypass dependencies", () => fixture(s => {
  s.set("bos", "thread", { ...plan, expectedRevision: 0, steps: plan.steps.map(x => x.id === "bos" ? { ...x, dependsOn: ["mobile"] } : x) });
  expect(s.claim("bos", "thread", gate).kind).toBe("idle");
}));
it.each(["cancelled", "awaitingApproval", "allowed", "providerSucceeded"] as const)("honours %s before continuation", field => fixture(s => {
  s.set("bos", "thread", { ...plan, expectedRevision: 0 });
  expect(s.claim("bos", "thread", { ...gate, [field]: field === "cancelled" || field === "awaitingApproval" }).kind).toBe("idle");
}));
it("deduplicates provider terminals and persists a two-continuation cap across restarts and plan updates", () => fixture((s, file) => {
  s.set("bos", "thread", { ...plan, expectedRevision: 0 });
  expect(s.claim("bos", "thread", gate).kind).toBe("continue");
  expect(s.claim("bos", "thread", gate).kind).toBe("idle");
  const restarted = new WorkContinuity(file);
  restarted.set("bos", "thread", { ...plan, expectedRevision: 1 });
  expect(restarted.claim("bos", "thread", { ...gate, turnId: "turn-2" }).kind).toBe("continue");
  expect(restarted.claim("bos", "thread", { ...gate, turnId: "turn-3" }).kind).toBe("limited");
  expect(restarted.claim("bos", "thread", { ...gate, chainId: "new-human-round", turnId: "turn-4" }).kind).toBe("continue");
}));
it.each(["paused", "blocked", "completed"] as const)("%s plans never resume", status => fixture(s => {
  const steps = status === "completed" ? plan.steps.map(x => ({ ...x, status: "done" as const, evidence: "verified" })) : plan.steps;
  s.set("bos", "thread", { ...plan, status, steps, reason: "human gate", expectedRevision: 0 });
  expect(s.claim("bos", "thread", gate).kind).toBe("idle");
}));
it("requires evidence for completion, valid dependencies and current revisions", () => fixture(s => {
  expect(() => s.set("bos", "thread", { ...plan, status: "completed", expectedRevision: 0 })).toThrow();
  expect(() => s.set("bos", "thread", { ...plan, steps: [{ ...plan.steps[1], dependsOn: ["missing"] }], expectedRevision: 0 })).toThrow();
  expect(() => s.set("bos", "thread", { ...plan, steps: [{ ...plan.steps[1], dependsOn: ["bos"] }], expectedRevision: 0 })).toThrow();
  s.set("bos", "thread", { ...plan, expectedRevision: 0 });
  expect(() => s.set("bos", "thread", { ...plan, expectedRevision: 0 })).toThrow(/changed/);
}));
it("fails closed on corrupt storage and keeps returned objects detached", () => fixture((s, file) => {
  s.set("bos", "thread", { ...plan, expectedRevision: 0 });
  s.get("bos", "thread")!.steps[1].action = "mutated";
  expect(s.get("bos", "thread")!.steps[1].action).toBe("prepare packaging");
  writeFileSync(file, "broken");
  expect(() => new WorkContinuity(file).claim("bos", "thread", gate)).toThrow(/unreadable/);
}));
