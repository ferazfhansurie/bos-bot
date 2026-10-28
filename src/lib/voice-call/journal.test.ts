import { describe, expect, it } from "vitest";

import type { VoiceCallEndRequest, VoiceJobsRequest } from "../../../shared/voice-call";
import {
  flushEnds,
  flushJournal,
  MemoryStore,
  VoiceEndQueue,
  VoiceJournal,
  type VoiceServer,
} from "./journal";

function server(overrides: Partial<VoiceServer> = {}): VoiceServer {
  return {
    jobs: async (request: VoiceJobsRequest) => ({
      results: request.jobs.map((job) => ({ jobId: job.jobId, status: "sent" as const })),
    }),
    event: async () => ({ ok: true }),
    tool: async () => ({ output: "" }),
    end: async () => ({ threadId: "t", messageId: "m" }),
    ...overrides,
  };
}

const entry = (jobId: string, callId = "call-1") => ({ callId, botId: "bot-1", job: { jobId, text: `job ${jobId}` }, at: 1 });

describe("journal", () => {
  it("survives a reload: a new journal on the same store sees the entry", () => {
    const store = new MemoryStore();
    new VoiceJournal(store).add(entry("a"));
    expect(new VoiceJournal(store).list().map((e) => e.job.jobId)).toEqual(["a"]);
  });

  it("is idempotent on jobId", () => {
    const journal = new VoiceJournal(new MemoryStore());
    journal.add(entry("a"));
    journal.add(entry("a"));
    expect(journal.list()).toHaveLength(1);
  });

  it("removes only what the server says is sent or duplicate", async () => {
    const journal = new VoiceJournal(new MemoryStore());
    for (const id of ["sent", "dup", "failed", "missing"]) journal.add(entry(id));
    const result = await flushJournal(
      journal,
      server({
        jobs: async () => ({
          results: [
            { jobId: "sent", status: "sent" },
            { jobId: "dup", status: "duplicate" },
            { jobId: "failed", status: "failed" },
          ],
        }),
      }),
    );
    expect(journal.list().map((e) => e.job.jobId)).toEqual(["failed", "missing"]);
    expect(result.remaining).toBe(2);
  });

  it("keeps everything when the request throws", async () => {
    const journal = new VoiceJournal(new MemoryStore());
    journal.add(entry("a"));
    await flushJournal(
      journal,
      server({
        jobs: async () => {
          throw new Error("offline");
        },
      }),
    );
    expect(journal.list()).toHaveLength(1);
  });

  it("groups by call and bot, one request each", async () => {
    const journal = new VoiceJournal(new MemoryStore());
    journal.add(entry("a", "call-1"));
    journal.add(entry("b", "call-2"));
    journal.add(entry("c", "call-1"));
    const seen: Array<[string, string[]]> = [];
    await flushJournal(
      journal,
      server({
        jobs: async (request) => {
          seen.push([request.callId, request.jobs.map((j) => j.jobId)]);
          return { results: request.jobs.map((j) => ({ jobId: j.jobId, status: "sent" as const })) };
        },
      }),
    );
    expect(seen).toEqual([
      ["call-1", ["a", "c"]],
      ["call-2", ["b"]],
    ]);
  });

  it("a flush started mid-flight runs again so a late job is not left behind", async () => {
    const journal = new VoiceJournal(new MemoryStore());
    journal.add(entry("a"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const slow = server({
      jobs: async (request) => {
        await gate;
        sent.push(...request.jobs.map((j) => j.jobId));
        return { results: request.jobs.map((j) => ({ jobId: j.jobId, status: "sent" as const })) };
      },
    });
    const first = flushJournal(journal, slow);
    journal.add(entry("b"));
    const second = flushJournal(journal, slow);
    release();
    await Promise.all([first, second]);
    expect(sent.sort()).toEqual(["a", "b"]);
    expect(journal.list()).toEqual([]);
  });
});

describe("call-end queue", () => {
  const report: VoiceCallEndRequest = {
    callId: "call-9",
    botId: "bot-1",
    seconds: 0,
    startedAt: 1,
    transcript: [],
    jobs: [],
    metrics: { drops: 0, resumes: 0 },
  };

  it("queues an end report while offline, retries, and removes it on a 2xx", async () => {
    const queue = new VoiceEndQueue(new MemoryStore());
    queue.add({ request: report, tries: 0 });
    let online = false;
    const posted: string[] = [];
    const s = server({
      end: async (request) => {
        if (!online) throw new Error("offline");
        posted.push(request.callId);
        return { threadId: "t", messageId: "m" };
      },
    });
    expect(await flushEnds(queue, s)).toBe(1);
    expect(queue.list()[0].tries).toBe(1);
    online = true;
    expect(await flushEnds(queue, s)).toBe(0);
    expect(posted).toEqual(["call-9"]);
  });
  it("drops a report the server will never take (404 from an old server) but keeps one that hit a 500", async () => {
    const queue = new VoiceEndQueue(new MemoryStore());
    queue.add({ request: report, tries: 0 });
    const old = server({ end: async () => Promise.reject(Object.assign(new Error("not found"), { status: 404 })) });
    expect(await flushEnds(queue, old)).toBe(0);

    queue.add({ request: report, tries: 0 });
    const broken = server({ end: async () => Promise.reject(Object.assign(new Error("boom"), { status: 500 })) });
    expect(await flushEnds(queue, broken)).toBe(1);
  });

  it("an empty queue flushes twice without hanging", async () => {
    const queue = new VoiceEndQueue(new MemoryStore());
    expect(await flushEnds(queue, server())).toBe(0);
    expect(await flushEnds(queue, server())).toBe(0);
    const journal = new VoiceJournal(new MemoryStore());
    expect((await flushJournal(journal, server())).remaining).toBe(0);
    expect((await flushJournal(journal, server())).remaining).toBe(0);
  });
});
