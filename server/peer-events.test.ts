import { describe, expect, it } from "vitest";
import { peerEvent } from "./peer-events.ts";
import { peerAllowed } from "./request-auth.ts";

describe("scoped peer events", () => {
  const view = { id: "bot", tasks: [{ threadId: "shared" }], messages: [] };
  const access = { owns: (threadId: string) => threadId === "shared", botView: (id: string) => id === "bot" ? view : null };
  it("allows scoped event routes, but never event writes", () => {
    expect(peerAllowed("GET", "/api/multiplayer/peer-events")).toBe(true);
    expect(peerAllowed("GET", "/api/events")).toBe(true);
    expect(peerAllowed("POST", "/api/multiplayer/peer-events")).toBe(false);
  });
  it("drops private events and rebuilds bot snapshots from scoped state", () => {
    for (const kind of ["message", "message.patch", "thread", "screen", "config", "notify", "bot.queued", "unknown"]) {
      expect(peerEvent({ kind, threadId: "private", message: { text: "secret" } }, access)).toBeNull();
    }
    expect(peerEvent({ kind: "runtime", event: { threadId: "private", raw: "secret" } }, access)).toBeNull();
    expect(peerEvent({ kind: "bot", bot: { id: "bot", messages: ["secret"] } }, access)).toEqual({ kind: "bot", bot: view });
    expect(peerEvent({ kind: "bot", bot: { id: "hidden" } }, access)).toBeNull();
    expect(peerEvent({ kind: "bot", bot: { id: "hidden" } }, { ...access, knownBot: () => true })).toEqual({ kind: "bot.deleted", botId: "hidden" });
  });
  it("relays incremental events without raw provider state or private thread references", () => {
    expect(peerEvent({ kind: "runtime", event: { threadId: "shared", type: "content.delta", payload: { delta: "hello" }, raw: "secret" } }, access))
      .toEqual({ kind: "runtime", event: { threadId: "shared", type: "content.delta", payload: { delta: "hello" } } });
    expect(peerEvent({ kind: "message", threadId: "shared", message: { id: "m", text: "hi", comm: "secret", roomRequest: "secret", threadRef: { threadId: "private" } } }, access))
      .toEqual({ kind: "message", threadId: "shared", message: { id: "m", text: "hi" } });
    expect(peerEvent({ kind: "thread", threadId: "shared", activeLeafId: "m" }, { ...access, owns: () => false })).toBeNull();
  });
  it("projects joined rooms and evicts only previously visible memberships", () => {
    const scoped = { ...access, roomView: (id: string) => id === "joined" ? { id, peopleIds: ["guest"] } : null, knownRoom: (id: string) => id === "removed" };
    expect(peerEvent({ kind: "group", group: { id: "joined", cwd: "/private", memberIds: ["secret"] } }, scoped)).toEqual({ kind: "group", group: { id: "joined", peopleIds: ["guest"] } });
    expect(peerEvent({ kind: "group", group: { id: "removed", name: "private" } }, scoped)).toEqual({ kind: "group.deleted", groupId: "removed" });
    expect(peerEvent({ kind: "group", group: { id: "unknown" } }, scoped)).toBeNull();
    expect(peerEvent({ kind: "group.deleted", groupId: "removed" }, scoped)).toEqual({ kind: "group.deleted", groupId: "removed" });
    expect(peerEvent({ kind: "group.deleted", groupId: "unknown" }, scoped)).toBeNull();
  });

});
