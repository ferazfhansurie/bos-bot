import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      const push = new ApnsPush(file);
      push.register("home:person:owner", "a".repeat(64), "development", "device-home-1");
      expect(JSON.parse(readFileSync(file, "utf8")).devices[0]).toMatchObject({ actorId: "home:person:owner", connectionId: "device-home-1" });
      expect(new ApnsPush(file).countFor("home:person:owner")).toBe(1);
      expect(() => push.register("home:person:owner", "b".repeat(64), "development", "bad scope")).toThrow("invalid push connection");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
