import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
let home: string;
async function fixture() {
  home = mkdtempSync(join(tmpdir(), "omb-room-controls-"));
  vi.resetModules(); vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  const module = await import("./store.ts");
  return { ...module, store: new module.Store(() => ({ instanceId: "claude", model: "m" })) };
}
afterEach(async () => {
  (await import("./message-db.ts")).closeMessageDb(); vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
describe("saved room controls", () => {
  it("retains settings and transcript across restart; prunes only removed member policies", async () => {
    const { store, Store } = await fixture();
    const a = store.createBot(); const b = store.createBot();
    const group = store.createGroup("HQ fixture", [a.id, b.id]);
    store.appendMessage(group.threadId, { role: "user", kind: "text", text: "keep this history" });
    store.patchGroup(group.id, { avatarUrl: "/api/attachments/photo.png", notifications: "mentions", memberReplyModes: { [a.id]: "always", [b.id]: "mentions" } });
    const reopened = new Store(() => ({ instanceId: "claude", model: "m" }));
    expect(reopened.group(group.id)).toMatchObject({ avatarUrl: "/api/attachments/photo.png", notifications: "mentions", memberReplyModes: { [a.id]: "always", [b.id]: "mentions" } });
    reopened.patchGroup(group.id, { memberIds: [a.id] });
    expect(reopened.group(group.id)?.memberReplyModes).toEqual({ [a.id]: "always" });
    expect(reopened.messagesFor(group.threadId).map(m => m.text)).toContain("keep this history");
  });
  it("always responds to human messages; tagged mode never inherits a default lead", async () => {
    const { roomResponders } = await fixture();
    const members = [{ id: "a", name: "Jarvis" }, { id: "b", name: "Engineer" }];
    const modes = { a: "always", b: "mentions" } as const;
    expect(roomResponders("hello", members, { kind: "member", botId: "b" }, modes).map(m => m.id)).toEqual(["a"]);
    expect(roomResponders("@Engineer inspect", members, { kind: "mentions" }, modes).map(m => m.id)).toEqual(["a", "b"]);
    expect(roomResponders("@everyone inspect", members, { kind: "mentions" }, modes).map(m => m.id)).toEqual(["a", "b"]);
    expect(roomResponders("hello", members, { kind: "member", botId: "b" }).map(m => m.id)).toEqual(["b"]);
  });
});
