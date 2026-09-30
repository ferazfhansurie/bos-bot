import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegatedJobs } from "./delegated-jobs.ts";
test("same requestKey survives restart and uncertain work is not replayed", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegated-jobs-"));
  try {
    const file = join(dir, "jobs.json"); const jobs = new DelegatedJobs(file);
    const input = { identity: { sessionId: "peer", tokenHash: "a".repeat(64), homeId: "firaz", botId: "jarvis" }, targetBotId: "sol", requestKey: "one", message: "fixture" };
    const first = jobs.enqueue(input);
    expect(jobs.enqueue(input)).toMatchObject({ duplicate: true, job: { id: first.job.id } });
    expect(() => jobs.enqueue({ ...input, message: "different" })).toThrow(/different/);
    const restored = new DelegatedJobs(file);
    expect(restored.enqueue(input)).toMatchObject({ duplicate: true, job: { id: first.job.id, status: "failed" } });
    expect(restored.pending()).toHaveLength(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a durable-write failure opens a circuit instead of repeatedly dispatching", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegated-jobs-"));
  try {
    const file = join(dir, "jobs.json"); const jobs = new DelegatedJobs(file);
    const input = { identity: { homeId: "firaz", botId: "jarvis", sessionId: "peer", tokenHash: "a".repeat(64) }, targetBotId: "sol", requestKey: "one", message: "fixture" };
    const { job } = jobs.enqueue(input);
    rmSync(file); mkdirSync(file);
    expect(() => jobs.patch(job, { status: "running" })).toThrow();
    expect(jobs.pending()).toHaveLength(0);
    expect(() => jobs.enqueue({ ...input, requestKey: "two" })).toThrow(/storage/);
    expect(() => jobs.get(job.id, input.identity)).toThrow(/storage/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
