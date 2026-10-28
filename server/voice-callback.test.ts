import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_BATCH_MAX_MS, CALLBACK_QUIET_MS, CALLBACK_STALE_MS, LIVE_CALL_MAX_MS,
  CallbackPreference, LiveVoiceCalls, VoiceCallbacks, callbackDecision, callbackLine, callbackReason, quietHours,
} from "./voice-callback.ts";
import { VoiceRings } from "./voice-ring.ts";
import { buildApnsPayload } from "./apns-push.ts";

const KL = "Asia/Kuala_Lumpur";
// 2026-10-27 14:00 KL (06:00Z)
const AFTERNOON = Date.UTC(2026, 9, 27, 6, 0);
const facts = { enabled: true, muted: false, onCall: false, askedAt: AFTERNOON - 5 * 60_000, now: AFTERNOON, timeZone: KL };

describe("voice call-back decision", () => {
  it("rings for a call-given job settling in the afternoon", () => {
    expect(callbackDecision(facts).action).toBe("ring");
  });
  it("keeps the banner only when off, muted, stale or in quiet hours", () => {
    expect(callbackDecision({ ...facts, enabled: false }).action).toBe("banner");
    expect(callbackDecision({ ...facts, muted: true }).action).toBe("banner");
    expect(callbackDecision({ ...facts, askedAt: AFTERNOON - CALLBACK_STALE_MS - 1 }).action).toBe("banner");
    expect(callbackDecision({ ...facts, askedAt: AFTERNOON - CALLBACK_STALE_MS + 60_000 }).action).toBe("ring");
    // 23:30 KL and 07:59 KL are quiet, 08:00 KL is not
    expect(callbackDecision({ ...facts, now: Date.UTC(2026, 9, 27, 15, 30), askedAt: Date.UTC(2026, 9, 27, 15, 0) }).action).toBe("banner");
    expect(callbackDecision({ ...facts, now: Date.UTC(2026, 9, 26, 23, 59), askedAt: Date.UTC(2026, 9, 26, 23, 0) }).action).toBe("banner");
    expect(callbackDecision({ ...facts, now: Date.UTC(2026, 9, 27, 0, 0), askedAt: Date.UTC(2026, 9, 26, 23, 30) }).action).toBe("ring");
  });
  it("leaves it to the live call while the owner is on one", () => {
    expect(callbackDecision({ ...facts, onCall: true }).action).toBe("in_call");
    // the owner's switch and mute still win over the call
    expect(callbackDecision({ ...facts, onCall: true, muted: true }).action).toBe("banner");
  });
  it("reads quiet hours in the given time zone", () => {
    expect(quietHours(Date.UTC(2026, 9, 27, 16, 0), KL)).toBe(true); // 00:00 KL
    expect(quietHours(Date.UTC(2026, 9, 27, 16, 0), "UTC")).toBe(false);
  });
});

describe("voice call-back words", () => {
  it("says the result, or why it stopped", () => {
    expect(callbackLine({ reply: "Pushed the fix to staging. All tests pass." })).toBe("Pushed the fix to staging. All tests pass.");
    expect(callbackLine({ reply: "" })).toBe("it's done.");
    expect(callbackLine({ reply: "", failure: "the jira token expired" })).toBe("it stopped: the jira token expired");
    expect(callbackLine({ reply: "half way", failure: "" })).toBe("it stopped: no reason given");
  });
  it("names each bot when several jobs come back together", () => {
    const reason = callbackReason([
      { botId: "a", botName: "oracle", threadId: "t1", reply: "Screenshots are on FCA-179." },
      { botId: "b", botName: "bos", threadId: "t2", reply: "", failure: "whatsapp is signed out" },
    ]);
    expect(reason).toBe("2 jobs from your call are back. oracle: Screenshots are on FCA-179. bos: it stopped: whatsapp is signed out");
    expect(callbackReason([{ botId: "a", botName: "x", threadId: "t", reply: "y".repeat(2000) }]).length).toBeLessThanOrEqual(500);
  });
});

describe("voice call-back batching", () => {
  afterEach(() => { vi.useRealTimers(); });
  const job = (n: number) => ({ botId: `bot-${n}`, botName: `bot ${n}`, threadId: `thread-${n}`, reply: `job ${n} done.` });

  it("rings once for jobs that settle close together, in the newest job's thread", () => {
    vi.useFakeTimers();
    const ring = vi.fn();
    const callbacks = new VoiceCallbacks({ now: () => Date.now(), stillRing: () => true, ring });
    callbacks.add(job(1));
    vi.advanceTimersByTime(CALLBACK_QUIET_MS - 1);
    callbacks.add(job(2));
    vi.advanceTimersByTime(CALLBACK_QUIET_MS - 1);
    expect(ring).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ring).toHaveBeenCalledExactlyOnceWith(
      { botId: "bot-2", threadId: "thread-2", reason: "2 jobs from your call are back. bot 1: job 1 done. bot 2: job 2 done." }, "bot 2");
    expect(callbacks.pending).toBe(0);
  });
  it("never waits more than a minute from the first job", () => {
    vi.useFakeTimers();
    const ring = vi.fn();
    const callbacks = new VoiceCallbacks({ now: () => Date.now(), stillRing: () => true, ring });
    for (let at = 0; at < CALLBACK_BATCH_MAX_MS; at += 10_000) { callbacks.add(job(at)); vi.advanceTimersByTime(10_000); }
    expect(ring).toHaveBeenCalledTimes(1);
    expect(ring.mock.calls[0]![0].reason).toMatch(/^6 jobs from your call are back/);
  });
  it("drops the ring when a call started or the switch went off meanwhile, and never retries a failed ring", () => {
    vi.useFakeTimers();
    let ok = false;
    const ring = vi.fn(() => { throw new Error("push down"); });
    const callbacks = new VoiceCallbacks({ now: () => Date.now(), stillRing: () => ok, ring });
    callbacks.add(job(1));
    vi.advanceTimersByTime(CALLBACK_QUIET_MS);
    expect(ring).not.toHaveBeenCalled();
    ok = true;
    callbacks.add(job(2));
    vi.advanceTimersByTime(CALLBACK_QUIET_MS);
    expect(ring).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * CALLBACK_BATCH_MAX_MS);
    expect(ring).toHaveBeenCalledTimes(1);
  });
});

describe("live calls and the owner's switch", () => {
  it("counts a call from start to end, and forgets one that never ended", () => {
    let now = 0;
    const calls = new LiveVoiceCalls(() => now);
    expect(calls.onCall()).toBe(false);
    calls.start("call-a");
    expect(calls.onCall()).toBe(true);
    calls.end("call-a");
    expect(calls.onCall()).toBe(false);
    calls.start("call-b");
    now = LIVE_CALL_MAX_MS + 1;
    expect(calls.onCall()).toBe(false);
  });
  it("defaults on and persists the owner's choice", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-callback-"));
    try {
      const file = join(dir, "voice-callback.json");
      expect(new CallbackPreference(file).enabled).toBe(true);
      new CallbackPreference(file).set(false);
      expect(new CallbackPreference(file).enabled).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ enabled: false });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("call-back rings", () => {
  it("skip the ten-minute window and carry purpose job_done to the phone", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-callback-ring-"));
    try {
      const emit = vi.fn(); const push = vi.fn(async () => {});
      const rings = new VoiceRings({ file: join(dir, "rings.json"), ownerId: "home:person:owner", emit, push });
      rings.ring({ botId: "bot-a", threadId: "t1", reason: "first" }, "Builder");
      const ring = rings.ring({ botId: "bot-a", threadId: "t2", reason: "Pushed the fix.", purpose: "job_done" }, "Builder");
      expect(ring).toMatchObject({ type: "voice_ring", purpose: "job_done", reason: "Pushed the fix." });
      expect(push).toHaveBeenLastCalledWith("home:person:owner", "Builder is calling", "Pushed the fix.", { ...ring, botName: "Builder" }, ring.ringId, expect.any(Function));
      expect(buildApnsPayload("Builder is calling", ring.reason, ring, "device-a")).toMatchObject({ purpose: "job_done", reason: "Pushed the fix.", aps: { category: "VOICE_RING" } });
      // an ordinary ring right after is still held by the window
      expect(() => rings.ring({ botId: "bot-a", threadId: "t3", reason: "again" }, "Builder")).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
