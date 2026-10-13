import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
let home = "";
afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb(); vi.unstubAllEnvs(); if (home) rmSync(home, { recursive: true, force: true });
});
it("keeps the human timestamp and persists manual stops separately from errors", async () => {
  home = mkdtempSync(join(tmpdir(), "bos-compact-outcome-")); vi.resetModules();
  vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot();
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "start", at: 100 });
  expect(store.settleTurn(bot.threadId, "stopped-turn", { ok: false, stopReason: "interrupted" })?.tool?.name).toBe("stopped");
  expect(store.lastUserMessageAt(bot.threadId)).toBe(100);
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "again", at: 200 });
  expect(store.settleTurn(bot.threadId, "error-turn", { ok: false, stopReason: "provider crashed" })?.tool?.name).toBe("turn failed");
  expect(store.lastUserMessageAt(bot.threadId)).toBe(200);
});
