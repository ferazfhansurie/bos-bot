import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VoiceRings, VoiceRingRateLimit, voiceRingInput } from "./voice-ring.ts";
import { buildApnsPayload } from "./apns-push.ts";

describe("owner voice rings", () => {
  it("sends matching foreground and time-sensitive background calls only to the owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-ring-"));
    try {
      const emit = vi.fn(); const push = vi.fn(async () => {});
      const rings = new VoiceRings({ file: join(dir, "rings.json"), ownerId: "home:person:owner", emit, push });
      const input = { botId: "bot-a", threadId: "thread-a", reason: "Your build is ready." };
      const ring = rings.ring(input, "Builder");
      expect(ring).toMatchObject({ type: "voice_ring", ...input });
      expect(ring.ringId).toMatch(/^[a-f0-9-]{36}$/);
      expect(emit).toHaveBeenCalledExactlyOnceWith({ kind: "voice_ring", ...ring });
      expect(push).toHaveBeenCalledExactlyOnceWith("home:person:owner", "Builder is calling", input.reason, { ...ring, botName: "Builder" }, ring.ringId);
      const payload = buildApnsPayload("Builder is calling", input.reason, ring, "device-a");
      expect(payload).toMatchObject({ ...ring, connectionId: "device-a", aps: { category: "VOICE_RING", "interruption-level": "time-sensitive", sound: "default" } });
      expect(buildApnsPayload("Normal", "hello", { botId: "bot-a" }).aps).not.toHaveProperty("category");
      expect(buildApnsPayload("Done", "hello", { type: "voice_work_done", callId: "call-a" }).aps).not.toHaveProperty("interruption-level");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("limits a bot across threads, overlapping requests and server restarts, then expires at ten minutes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-ring-rate-"));
    try {
      let now = 1_000_000; const emit = vi.fn(); const push = vi.fn(async () => {});
      const options = { file: join(dir, "rings.json"), ownerId: "home:person:owner", emit, push, now: () => now };
      const rings = new VoiceRings(options);
      const input = { botId: "bot-a", threadId: "thread-a", reason: "Please join." };
      const results = await Promise.allSettled([0, 1].map(() => Promise.resolve().then(() => rings.ring(input, "A"))));
      expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(() => rings.ring({ ...input, threadId: "thread-b" }, "A")).toThrow(VoiceRingRateLimit);
      const restarted = new VoiceRings(options);
      now += 599_999;
      try { restarted.ring(input, "A"); throw new Error("accepted too soon"); }
      catch (error) { expect(error).toMatchObject({ status: 429, retryAfter: 1 }); }
      expect(() => restarted.ring({ ...input, botId: "bot-b" }, "B")).not.toThrow();
      now += 1;
      expect(() => restarted.ring(input, "A")).not.toThrow();
      expect(emit).toHaveBeenCalledTimes(3);
      expect(push).toHaveBeenCalledTimes(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("bounds payloads and rejects missing reasons, invalid ids and arbitrary push recipients", () => {
    const input = { botId: "bot", reason: "Call me" };
    expect(voiceRingInput.safeParse(input).success).toBe(true);
    for (const bad of [{ ...input, reason: " " }, { ...input, reason: "x".repeat(501) }, { ...input, botId: "../bot" }, { ...input, threadId: "" }, { ...input, actorId: "other:person:owner" }]) {
      expect(voiceRingInput.safeParse(bad).success).toBe(false);
    }
    const reason = "界".repeat(500);
    const payload = buildApnsPayload("界".repeat(120), reason, { type: "voice_ring", ringId: "a".repeat(36), botId: "a".repeat(128), threadId: "a".repeat(128), reason }, "a".repeat(128));
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(4096);
    expect(payload.reason).toBe(reason);
  });

  it("does not publish a ring when its durable reservation cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-ring-disk-"));
    try {
      const parent = join(dir, "blocked-parent"); writeFileSync(parent, "not a directory");
      const emit = vi.fn(); const push = vi.fn(async () => {});
      const rings = new VoiceRings({ file: join(parent, "rings.json"), ownerId: "home:person:owner", emit, push });
      expect(() => rings.ring({ botId: "bot", threadId: "thread", reason: "Call" }, "Bot")).toThrow();
      expect(emit).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
