import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PeerThreads } from "./peer-threads.ts";

it("retains shared provenance after grant revocation and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-peer-origins-"));
  try {
    const file = join(dir, "grants.json");
    writeFileSync(file, JSON.stringify({ version: 1, sessions: { legacy: [{ botId: "bot1", threadId: "thread1" }] } }));
    const grants = new PeerThreads(file);
    expect(grants.hasThread("thread1")).toBe(true);
    expect(grants.hasLiveGrant("thread1", () => false)).toBe(false);
    grants.add("rotated", { botId: "bot1", threadId: "thread1" });
    grants.revoke("legacy");
    expect(grants.hasLiveGrant("thread1", id => id === "rotated")).toBe(true);
    grants.revoke("rotated");
    const restored = new PeerThreads(file);
    expect(restored.hasThread("thread1")).toBe(true);
    expect(restored.hasLiveGrant("thread1", () => true)).toBe(false);
    expect(restored.hasThread("private-thread")).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
