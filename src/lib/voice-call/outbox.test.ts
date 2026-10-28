import { describe, expect, it } from "vitest";

import type { VoiceCallEndRequest } from "../../../shared/voice-call";
import { MemoryStore, VoiceEndQueue, VoiceJournal, type VoiceServer } from "./journal";
import { END_FLUSH_WAIT_MS, END_RETRY_MS, flushOutbox, settleCall } from "./outbox";

const report: VoiceCallEndRequest = {
  callId: "call-1",
  botId: "bot-1",
  seconds: 0,
  startedAt: 1,
  transcript: [],
  jobs: [],
  metrics: { drops: 0, resumes: 0 },
};

class Timers {
  pending: Array<{ fn: () => void; ms: number }> = [];
  setTimeout(fn: () => void, ms: number) {
    this.pending.push({ fn, ms });
    return this.pending.length;
  }
  fire(ms: number) {
    const i = this.pending.findIndex((t) => t.ms === ms);
    if (i < 0) return false;
    const [t] = this.pending.splice(i, 1);
    t.fn();
    return true;
  }
}

function setup() {
  const state = { online: false, ends: [] as string[], jobs: [] as string[] };
  const server: VoiceServer = {
    jobs: async (request) => {
      if (!state.online) throw new Error("offline");
      state.jobs.push(...request.jobs.map((j) => j.jobId));
      return { results: request.jobs.map((j) => ({ jobId: j.jobId, status: "sent" as const })) };
    },
    event: async () => ({ ok: true }),
    tool: async () => ({ output: "" }),
    end: async (request) => {
      if (!state.online) throw new Error("offline");
      state.ends.push(request.callId);
      return { threadId: "t", messageId: "m" };
    },
  };
  const timers = new Timers();
  const outbox = { journal: new VoiceJournal(new MemoryStore()), ends: new VoiceEndQueue(new MemoryStore()), server, timers };
  return { state, outbox, timers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("settleCall", () => {
  it("offline: the end report stays queued and a retry lands it once the network is back", async () => {
    const { state, outbox, timers } = setup();
    const engine = { flushJobs: async () => undefined, endReport: () => report };
    await settleCall(engine, outbox);
    expect(outbox.ends.list()).toHaveLength(1);
    expect(state.ends).toEqual([]);

    state.online = true;
    expect(timers.fire(END_RETRY_MS[0])).toBe(true);
    await flush();
    expect(state.ends).toEqual(["call-1"]);
    expect(outbox.ends.list()).toEqual([]);
  });

  it("reports even when the job flush hangs", async () => {
    const { state, outbox, timers } = setup();
    state.online = true;
    const engine = { flushJobs: () => new Promise<void>(() => undefined), endReport: () => report };
    const done = settleCall(engine, outbox);
    await flush();
    expect(state.ends).toEqual([]);
    timers.fire(END_FLUSH_WAIT_MS);
    await done;
    expect(state.ends).toEqual(["call-1"]);
  });
});

describe("flushOutbox", () => {
  it("pushes leftover jobs on focus / online and says how many landed", async () => {
    const { state, outbox } = setup();
    outbox.journal.add({ callId: "c", botId: "bot-1", job: { jobId: "j1", text: "one" }, at: 1 });
    outbox.journal.add({ callId: "c", botId: "bot-1", job: { jobId: "j2", text: "two" }, at: 1 });
    const heard: number[] = [];
    await flushOutbox(outbox, (n) => heard.push(n));
    expect(heard).toEqual([]);
    state.online = true;
    await flushOutbox(outbox, (n) => heard.push(n));
    expect(heard).toEqual([2]);
    expect(outbox.journal.list()).toEqual([]);
  });

  it("does nothing when there is nothing to send", async () => {
    const { outbox } = setup();
    expect(await flushOutbox(outbox)).toBeNull();
  });
});
