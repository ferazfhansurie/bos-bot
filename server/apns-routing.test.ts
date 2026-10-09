import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApnsPush, buildApnsPayload } from "./apns-push.ts";

describe("account scoped push routing", () => {
  it("keeps registered device scope and exact immutable request identity", () => {
    const payload = buildApnsPayload("request", "review", { botId: "bot", threadId: "thread", kind: "approval", requestId: "request-1", messageId: "message-1" }, "device-home-1");
    expect(payload).toMatchObject({ connectionId: "device-home-1", requestId: "request-1", messageId: "message-1", threadId: "thread", kind: "approval" });
    expect(buildApnsPayload("legacy", "review", { roomId: "room" })).not.toHaveProperty("connectionId");
  });
  it("persists the device routing scope without changing actor ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-apns-scope-"));
    try {
      const file = join(dir, "devices.json");
      const push = new ApnsPush(file, (id, actor) => id === "session-a" && actor === "home:person:owner");
      push.register("home:person:owner", "a".repeat(64), "development", "device-home-1", "session-a");
      expect(JSON.parse(readFileSync(file, "utf8")).devices[0]).toMatchObject({ actorId: "home:person:owner", connectionId: "device-home-1" });
      expect(new ApnsPush(file, () => true).countFor("home:person:owner")).toBe(1);
      expect(() => push.register("home:person:owner", "b".repeat(64), "development", "bad scope", "session-a")).toThrow("invalid push connection");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps a PushKit token across alert-only registrations and rejects a malformed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-apns-voip-"));
    try {
      const file = join(dir, "devices.json");
      const push = new ApnsPush(file, () => true);
      push.register("home:person:owner", "a".repeat(64), "development", "device-home-1", "session-a", "C".repeat(64));
      push.register("home:person:owner", "a".repeat(64), "development", "device-home-1", "session-a");
      expect(JSON.parse(readFileSync(file, "utf8")).devices[0].voipToken).toBe("c".repeat(64));
      expect(() => push.register("home:person:owner", "a".repeat(64), "development", "device-home-1", "session-a", "nope")).toThrow("invalid VoIP token");
      expect(() => new ApnsPush(file, () => true)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("push session authority", () => {
  it("drops revoked sessions before sending and fails closed for legacy rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-apns-revoke-"));
    try {
      const file = join(dir, "devices.json"); let live = true;
      const push = new ApnsPush(file, (sessionId: string, actorId: string) => live && sessionId === "session-a" && actorId === "home:person:owner");
      push.register("home:person:owner", "a".repeat(64), "development", "connection-a", "session-a");
      expect(JSON.parse(readFileSync(file, "utf8")).devices[0].sessionId).toBe("session-a");
      live = false; await push.send("home:person:owner", "private", "body", { threadId: "thread" });
      expect(push.countFor("home:person:owner")).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8")).devices).toEqual([]);
      writeFileSync(file, JSON.stringify({ version: 1, devices: [{ actorId: "home:person:owner", token: "b".repeat(64), environment: "development", updatedAt: 1, connectionId: "legacy" }] }));
      expect(new ApnsPush(file, () => true).countFor("home:person:owner")).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses actor impersonation, expired registration and cross-actor token takeover", () => {
    const dir = mkdtempSync(join(tmpdir(), "bos-apns-owner-"));
    try {
      const actors = new Map([["session-a", "home:person:a"], ["session-b", "home:person:b"]]);
      const push = new ApnsPush(join(dir, "devices.json"), (sessionId: string, actorId: string) => actors.get(sessionId) === actorId);
      push.register("home:person:a", "a".repeat(64), "development", "connection-a", "session-a");
      expect(() => push.register("home:person:b", "b".repeat(64), "development", "connection-b", "session-a")).toThrow();
      expect(() => push.register("home:person:b", "a".repeat(64), "development", "connection-b", "session-b")).toThrow();
      actors.delete("session-a");
      expect(() => push.register("home:person:a", "a".repeat(64), "development", "connection-a", "session-a")).toThrow();
      expect(() => push.register("home:person:a", "b".repeat(64), "development", "connection-a")).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
