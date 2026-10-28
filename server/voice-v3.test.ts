// Voice calls v3 server rules against a fake world: jobs land once however
// often a dropped phone resends them, names route to the right bot, the
// read tools answer short, approvals stay on screen, and the card + memory
// note are written once per call.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { VoiceCallCard } from "../shared/voice-call.ts";
import { voiceCallPlanV3 } from "./voice-call.ts";
import { cleanKeyterms, createXaiSummarizer, SCREEN_ONLY, startOfDay, topicWords, VoiceCalls, type VoiceNeedsMeItem, type VoiceThreadView, type VoiceWorld } from "./voice-v3.ts";
import { flushVoiceUsage, RM_PER_MINUTE, voiceRm, recordVoiceCallEnd, recordVoiceCallStart, recordVoiceEvent, summarizeVoiceUsage } from "./xai-usage.ts";

const NOW = Date.parse("2026-10-27T03:00:00Z");

function fakeWorld(overrides: Partial<VoiceWorld> = {}) {
  const memory = new Map<string, string>();
  const threads = new Map<string, VoiceThreadView>();
  const sent: Array<{ botId: string; threadId: string; text: string; sendId: string }> = [];
  const accepted = new Set<string>();
  const mode: { failSend: null | "before" | "after" } = { failSend: null };
  const started: Array<{ botId: string; title: string; text: string; sendId: string }> = [];
  const cards = new Map<string, VoiceCallCard>();
  const answered: Array<{ id: string; answer: string }> = [];
  let needs: VoiceNeedsMeItem[] = [];
  let n = 0;
  const world: VoiceWorld = {
    now: () => NOW,
    timeZone: "Asia/Kuala_Lumpur",
    userName: "Firaz Fhansurie",
    roster: () => [{ id: "b-bos", name: "bos" }, { id: "b-oracle", name: "oracle" }, { id: "b-cash", name: "cash" }],
    memory: (botId, path) => memory.get(`${botId}:${path}`) ?? "",
    memoryTopics: (botId) => [...memory.keys()].filter((key) => key.startsWith(`${botId}:memory/`)).map((key) => key.slice(botId.length + 1)),
    writeMemory: (botId, path, update) => { memory.set(`${botId}:${path}`, update(memory.get(`${botId}:${path}`) ?? "")); },
    openWork: (limit) => [...threads.values()].filter((t) => t.state !== "idle").slice(0, limit),
    findThreads: (words, limit) => [...threads.values()].filter((t) => words.some((w) => t.title.toLowerCase().includes(w))).slice(0, limit),
    thread: (_botId, threadId) => threads.get(threadId) ?? null,
    needsMe: () => needs,
    routineRuns: () => [],
    upcoming: () => [],
    startJob: async ({ botId, title, text, sendId, threadId: reuse, opened }) => {
      const kept = reuse && threads.has(reuse) ? reuse : undefined;
      if (kept && accepted.has(`${kept}:${sendId}`)) return { threadId: kept };
      await new Promise((resolve) => setTimeout(resolve, 5));
      const threadId = kept ?? `t${++n}`;
      if (!kept) threads.set(threadId, { botId, botName: botId, threadId, title, state: "running", at: NOW });
      opened?.(threadId);
      if (mode.failSend === "before") {
        if (!kept) threads.delete(threadId);
        throw new Error("send refused");
      }
      accepted.add(`${threadId}:${sendId}`);
      started.push({ botId, title, text, sendId });
      if (mode.failSend === "after") throw new Error("connection reset");
      return { threadId };
    },
    sendToThread: async ({ botId, threadId, text, sendId }) => {
      if (accepted.has(`${threadId}:${sendId}`)) return;
      accepted.add(`${threadId}:${sendId}`);
      sent.push({ botId, threadId, text, sendId });
    },
    answerQuestion: async (item, answer) => { answered.push({ id: item.id, answer }); return true; },
    postCard: (_botId, card) => { const messageId = `m${++n}`; cards.set(messageId, structuredClone(card)); return { threadId: `card-${n}`, messageId }; },
    patchCard: (_botId, _threadId, messageId, card) => { cards.set(messageId, structuredClone(card)); },
    readCard: (_threadId, messageId) => cards.get(messageId) ?? null,
    ...overrides,
  };
  return { world, memory, threads, sent, started, cards, answered, mode, setNeeds: (items: VoiceNeedsMeItem[]) => { needs = items; } };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "voice-v3-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("jobs", () => {
  it("a job resent after a drop lands once, on the same thread", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, f.world);
    const job = { jobId: "job-abc123", text: "check prod errors" };
    // the phone sends, the line drops before the answer, the journal resends
    // twice while the first send is still in flight
    const [a, b] = await Promise.all([
      calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] }),
      calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] }),
    ]);
    const c = await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] });
    expect(f.started).toHaveLength(1);
    expect(a[0]).toMatchObject({ status: "sent", threadId: "t1" });
    expect(b[0].threadId).toBe("t1");
    expect(c[0]).toMatchObject({ status: "duplicate", threadId: "t1" });
    // and after a server restart
    const again = await new VoiceCalls(dir, f.world).jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] });
    expect(again[0]).toMatchObject({ status: "duplicate", threadId: "t1" });
    expect(f.started).toHaveLength(1);
  });

  it("each job gets its own thread, routed by the bot named on the call", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, f.world);
    const results = await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [
      { jobId: "job-000001", text: "check prod errors", bot: "Oracle" },
      { jobId: "job-000002", text: "how is ad e doing", bot: "cash" },
      { jobId: "job-000003", text: "note: ad idea", bot: "someone else" },
      { jobId: "job-000004", text: "draft partner a reply" },
    ] });
    expect(results.map((r) => r.botId)).toEqual(["b-oracle", "b-cash", "b-bos", "b-bos"]);
    expect(new Set(results.map((r) => r.threadId)).size).toBe(4);
    expect(f.started[0]).toMatchObject({ text: "check prod errors", title: "voice · check prod errors" });
    expect(f.started[0].sendId).toBe("voicejob-job-000001");
  });

  it("a failed start reports failed and is not remembered, so the journal retries it", async () => {
    let fail = true;
    const f = fakeWorld();
    const base = f.world.startJob;
    f.world.startJob = async (input) => { if (fail) throw new Error("spend cap"); return base(input); };
    const calls = new VoiceCalls(dir, f.world);
    const first = await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [{ jobId: "job-retry1", text: "do it" }] });
    expect(first[0]).toMatchObject({ status: "failed", error: "spend cap" });
    fail = false;
    const second = await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [{ jobId: "job-retry1", text: "do it" }] });
    expect(second[0].status).toBe("sent");
  });

  it("a send that landed but lost its answer is not sent again on retry, even after a restart", async () => {
    const f = fakeWorld();
    f.mode.failSend = "after";
    const job = { jobId: "job-lost01", text: "check prod errors" };
    const first = await new VoiceCalls(dir, f.world).jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] });
    expect(first[0].status).toBe("failed");
    f.mode.failSend = null;
    const again = await new VoiceCalls(dir, f.world).jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] });
    expect(again[0]).toMatchObject({ status: "sent", threadId: "t1" });
    expect(f.started).toHaveLength(1);
    expect(f.threads.size).toBe(1);
  });

  it("a send refused before it landed leaves no thread and retries on a fresh one", async () => {
    const f = fakeWorld();
    f.mode.failSend = "before";
    const calls = new VoiceCalls(dir, f.world);
    const job = { jobId: "job-refuse", text: "check prod errors", bot: "oracle" };
    expect((await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] }))[0].status).toBe("failed");
    expect(f.threads.size).toBe(0);
    f.mode.failSend = null;
    const again = await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [job] });
    expect(again[0]).toMatchObject({ status: "sent", botId: "b-oracle" });
    expect(f.started).toHaveLength(1);
  });
});

describe("end-of-call summary", () => {
  it("lists only this call's sent jobs, oldest first, with where each one is", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, f.world);
    await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [
      { jobId: "job-000001", text: "check prod errors", bot: "oracle" },
      { jobId: "job-000002", text: "how is ad e doing", bot: "cash" },
      { jobId: "job-000003", text: "draft partner a reply" },
    ] });
    await calls.jobs({ callId: "call-00000002", botId: "b-bos", jobs: [{ jobId: "job-000009", text: "another call's job" }] });
    f.threads.get("t2")!.state = "waiting-on-you";
    Object.assign(f.threads.get("t3")!, { state: "idle", last: "drafted the reply to partner, it's on your screen" });
    const jobs = calls.callJobs("call-00000001");
    expect(jobs.map((j) => [j.jobId, j.state])).toEqual([["job-000001", "working"], ["job-000002", "needs_you"], ["job-000003", "done"]]);
    expect(jobs[2]).toMatchObject({ text: "draft partner a reply", botId: "b-bos", threadId: "t3", last: "drafted the reply to partner, it's on your screen" });
    expect(calls.callJobs("call-00000003")).toEqual([]);
  });

  it("a job whose thread is gone counts as done", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, f.world);
    await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [{ jobId: "job-000001", text: "check prod errors" }] });
    f.threads.clear();
    expect(calls.callJobs("call-00000001")[0]).toMatchObject({ state: "done", botName: "bos" });
  });

  it("prices a call at the voice rate per minute", () => {
    expect(voiceRm(0)).toBe(0);
    expect(voiceRm(60)).toBe(Math.round(RM_PER_MINUTE * 100) / 100);
    expect(voiceRm(5 * 60)).toBe(1.68);
  });
});

describe("keyterms (mumbled names)", () => {
  it("merges saved terms with bot names and the caller's first name, capped for xAI", () => {
    mkdirSync(join(dir, "voice-calls"), { recursive: true });
    writeFileSync(join(dir, "voice-calls", "keyterms.txt"), "# names\npartner\nsam\nacme\nad e\nops\nPartner\nfull send\n" + "x".repeat(80) + "\n");
    const terms = new VoiceCalls(dir, fakeWorld().world).keyterms();
    expect(terms).toEqual(expect.arrayContaining(["partner", "sam", "acme", "ad e", "ops", "full send", "bos", "oracle", "cash", "Firaz"]));
    expect(terms.filter((t) => t.toLowerCase() === "partner")).toHaveLength(1);
    expect(terms.every((t) => t.length <= 50)).toBe(true);
    expect(cleanKeyterms(Array.from({ length: 150 }, (_, i) => `t${i}`))).toHaveLength(100);
  });

  it("the v3 plan carries the terms, roster and brief", () => {
    const plan = voiceCallPlanV3({ agentName: "bos", userName: "Firaz", brief: "now: monday", keyterms: ["partner"], roster: [{ id: "b-bos", name: "bos" }] });
    expect(plan.v).toBe(3);
    expect(plan.keyterms).toEqual(["partner"]);
    expect(plan.roster).toEqual([{ id: "b-bos", name: "bos" }]);
    expect(plan.instructions).toContain("now: monday");
    expect(plan.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["send_task", "confirm_job", "check_jobs", "recall_memory", "calendar", "status", "needs_me", "answer_item", "follow_up", "end_the_call"]));
  });
});

describe("read tools", () => {
  it("answer_item never answers an approval by voice", async () => {
    const f = fakeWorld();
    f.setNeeds([
      { id: "i1", botId: "b-bos", botName: "bos", threadId: "t9", title: "send partner the invoice", preview: "allow gmail send?", requestId: "r1", approval: true },
      { id: "i2", botId: "b-cash", botName: "cash", threadId: "t8", title: "which ad", preview: "e or f?", requestId: "r2", options: ["e", "f"] },
    ]);
    const calls = new VoiceCalls(dir, f.world);
    const list = await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "needs_me", args: {} });
    expect(list).toContain("1. bos");
    expect(list).toContain("screen only");
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "answer_item", args: { item: "1", answer: "yes" } })).toBe(SCREEN_ONLY);
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "answer_item", args: { item: "the second one", answer: "e" } })).toBe("answered.");
    expect(f.answered).toEqual([{ id: "i2", answer: "e" }]);
  });

  it("recall_memory finds lines across memory files; noise words match nothing", async () => {
    const f = fakeWorld();
    f.memory.set("b-bos:MEMORY.md", "- partner pays rm300/month\n- unrelated line\n");
    f.memory.set("b-bos:memory/voice.md", "## call\n- sam trial starts monday\n");
    const calls = new VoiceCalls(dir, f.world);
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "recall_memory", args: { query: "how much does partner pay" } })).toContain("rm300");
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "recall_memory", args: { query: "sam" } })).toContain("monday");
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "recall_memory", args: { query: "uh the" } })).toBe("say what to look for.");
    expect(topicWords("what's the status of ad e")).toEqual(["ad"]);
  });

  it("check_jobs and follow_up reach the call's own jobs", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, f.world);
    await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [{ jobId: "job-000010", text: "check prod errors", bot: "oracle" }] });
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "check_jobs", args: {} })).toContain("still running");
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "follow_up", args: { topic: "prod errors", text: "only the collector ones" } })).toContain("added to");
    // the client retries the same tool call after a timeout: one send
    await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "follow_up", args: { topic: "prod errors", text: "only the collector ones" } });
    expect(f.sent).toEqual([expect.objectContaining({ botId: "b-oracle", threadId: "t1", text: "only the collector ones" })]);
    expect(f.sent[0].sendId).toMatch(/^voicefu-call-00000001-[0-9a-f]{16}$/);
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "launch_rockets" as never, args: {} })).toContain("no tool");
  });

  it("follow_up about an older thread starts a new thread instead of queueing in it", async () => {
    const f = fakeWorld();
    f.threads.set("t-old", { botId: "b-bos", botName: "bos", threadId: "t-old", title: "whatsapp fix for tara", state: "running", at: NOW });
    const calls = new VoiceCalls(dir, f.world);
    const ask = { callId: "call-00000001", botId: "b-bos", name: "follow_up" as const, args: { topic: "whatsapp fix", text: "call me when it's done" } };
    expect(await calls.tool(ask)).toContain("new thread");
    // a timeout retry of the same tool call opens no second thread
    await calls.tool(ask);
    expect(f.sent).toEqual([]);
    expect(f.started).toHaveLength(1);
    expect(f.started[0]).toMatchObject({ botId: "b-bos", title: "voice · call me when it's done" });
    expect(f.started[0].text).toContain("call me when it's done");
    expect(f.started[0].text).toContain("t-old");
    // more on that new thread later in the call goes into it, not a third one
    await calls.tool({ ...ask, args: { topic: "call me", text: "and send the test log" } });
    expect(f.started).toHaveLength(1);
    expect(f.sent).toEqual([expect.objectContaining({ text: "and send the test log" })]);
  });

  it("calendar says what it can't read", async () => {
    const calls = new VoiceCalls(dir, fakeWorld().world);
    expect(await calls.tool({ callId: "call-00000001", botId: "b-bos", name: "calendar", args: {} })).toContain("google calendar isn't readable");
  });
});

describe("call end", () => {
  const end = (overrides = {}) => ({
    callId: "call-00000001", botId: "b-bos", seconds: 95, startedAt: NOW - 95_000,
    transcript: [{ role: "user" as const, text: "tell oracle to check prod errors" }, { role: "bot" as const, text: "oracle: check prod errors. go?" }, { role: "user" as const, text: "go" }],
    jobs: [{ jobId: "job-000020", text: "check prod errors", bot: "oracle", status: "confirmed" as const }],
    metrics: { drops: 1, resumes: 1 },
    ...overrides,
  });

  it("writes one card, one memory note, and the next brief knows the call", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, { ...f.world, summarize: async () => ({ summary: "asked oracle to check prod errors", facts: ["sam trial starts monday"] }) });
    const [a, b] = await Promise.all([calls.end(end()), calls.end(end())]);
    expect(a).toEqual(b);
    expect(f.cards.size).toBe(1);
    const card = [...f.cards.values()][0];
    expect(card).toMatchObject({ seconds: 95, summary: "asked oracle to check prod errors", drops: 1, resumes: 1 });
    expect(card.jobs[0]).toMatchObject({ botId: "b-oracle", status: "confirmed" });
    const note = f.memory.get("b-bos:memory/voice.md") ?? "";
    expect(note).toContain("1:35");
    expect(note).toContain("sam trial starts monday");
    expect(note).toContain("job: check prod errors");
    expect(calls.brief("b-bos").text).toContain("asked oracle to check prod errors");
    // a late job send updates the card's row
    await calls.jobs({ callId: "call-00000001", botId: "b-bos", jobs: [{ jobId: "job-000020", text: "check prod errors", bot: "oracle" }] });
    expect([...f.cards.values()][0].jobs[0]).toMatchObject({ status: "sent", threadId: "t2" });
    // rating after a restart reads the stored card
    expect(new VoiceCalls(dir, f.world).rate("call-00000001", true)).toBe(true);
    expect([...f.cards.values()][0].rating).toBe("good");
  });

  it("falls back to a plain summary when the summariser fails, and a silent call writes no memory", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, { ...f.world, summarize: async () => { throw new Error("offline"); } });
    await calls.end(end());
    expect([...f.cards.values()][0].summary).toContain("check prod errors");
    await calls.end(end({ callId: "call-00000002", transcript: [], jobs: [], seconds: 0 }));
    expect([...f.cards.values()][1].summary).toBe("a short call, nothing said.");
    expect((f.memory.get("b-bos:memory/voice.md") ?? "").match(/## /g)).toHaveLength(1);
  });

  it("keeps memory/voice.md bounded", async () => {
    const f = fakeWorld();
    const calls = new VoiceCalls(dir, { ...f.world, summarize: async () => ({ summary: "y".repeat(200), facts: ["z".repeat(190), "w".repeat(190)] }) });
    for (let i = 0; i < 40; i += 1) await calls.end(end({ callId: `call-${String(i).padStart(8, "0")}` }));
    const note = f.memory.get("b-bos:memory/voice.md") ?? "";
    expect(note.length).toBeLessThan(12_500);
    expect(note.startsWith("# voice calls")).toBe(true);
  });
});

describe("summariser", () => {
  it("picks a fast grok text model from xAI's list and parses the json", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "grok-voice-3.0" }, { id: "grok-5" }, { id: "grok-5-fast-reasoning" }, { id: "grok-5-fast-non-reasoning" }] }));
      expect(JSON.parse(String(init?.body)).model).toBe("grok-5-fast-non-reasoning");
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"summary\":\"talked ads\",\"facts\":[\"ad e at rm20\"]}\n```" } }] }));
    }) as unknown as typeof fetch;
    const summarize = createXaiSummarizer(() => "k", fetchImpl, "https://stub");
    expect(await summarize([{ role: "user", text: "how is ad e" }], [])).toEqual({ summary: "talked ads", facts: ["ad e at rm20"] });
    expect(await createXaiSummarizer(() => undefined, fetchImpl)([], [])).toBeNull();
  });
});

describe("quality counters", () => {
  it("adds drops, resumes, first audio, ratings and jobs to the month", async () => {
    const at = new Date("2026-10-27T03:00:00Z");
    await recordVoiceCallStart(dir, "call-00000001", "b-bos", at);
    await recordVoiceEvent(dir, "call-00000001", { kind: "first_audio", ms: 700 }, at);
    await recordVoiceEvent(dir, "call-00000001", { kind: "drop" }, at);
    await recordVoiceEvent(dir, "call-00000001", { kind: "resume", ms: 2100 }, at);
    await recordVoiceEvent(dir, "call-00000001", { kind: "unclear" }, at);
    await recordVoiceEvent(dir, "call-00000001", { kind: "rating", good: false }, at);
    await recordVoiceEvent(dir, "call-00000001", { kind: "rating", good: true }, at);
    await recordVoiceCallEnd(dir, "call-00000001", 600, at, { said: 2, sent: 2 });
    await recordVoiceCallStart(dir, "call-00000002", "b-bos", at);
    await recordVoiceEvent(dir, "call-00000002", { kind: "first_audio", ms: 1500 }, at);
    await recordVoiceEvent(dir, "call-00000002", { kind: "memo" }, at);
    await flushVoiceUsage(dir);
    const { quality } = summarizeVoiceUsage(dir, at);
    expect(quality).toMatchObject({ drops: 1, resumes: 1, unclear: 1, memos: 1, good: 1, bad: 0, jobsSaid: 2, jobsSent: 2, firstAudioP50: 700, firstAudioP90: 1500 });
    expect(quality.rmEstimate).toBeCloseTo(3.36, 2);
    expect(readFileSync(join(dir, "voice-usage", "2026-10.jsonl"), "utf8")).not.toContain("transcript");
  });

  it("startOfDay is midnight in the caller's zone", () => {
    expect(new Date(startOfDay(NOW, "Asia/Kuala_Lumpur")).toISOString()).toBe("2026-10-26T16:00:00.000Z");
  });
});
