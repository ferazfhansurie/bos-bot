import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";
import { roomMemberTurns } from "@/lib/room-member-turns";

const at = Date.UTC(2026, 9, 5, 12);
const bots: Bot[] = ["Atlas", "Juniper", "Kai"].map((name, i) => ({
  id: name.toLowerCase(), threadId: "thread-" + name.toLowerCase(), name,
  title: "Test bot", description: "", notifications: false, unread: false,
  color: (["green", "purple", "blue"] as const)[i]!,
  // Atlas keeps an uploaded photo; the others draw the full-body mascot
  avatarUrl: i === 0 ? "/api/attachments/atlas.png" : null, avatarCrop: i === 0 ? "circle" : undefined,
  modelSelection: { instanceId: "fixture", model: "fixture-model" },
  tasks: [{ threadId: "thread-" + name.toLowerCase(), title: "Task", createdAt: at }],
  messages: [],
}));
const from = (id: string) => ({ botId: id, name: id[0]!.toUpperCase() + id.slice(1), color: "green" as const });
const room: Group = {
  id: "room", threadId: "room-a", name: "Room", memberIds: ["atlas", "juniper", "kai"],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: at, setupCompletedAt: at,
  tasks: [
    { threadId: "room-a", title: "A", createdAt: at, state: "running" },
    { threadId: "room-b", title: "B", createdAt: at, state: "idle" },
  ],
  working: true,
  messages: [{ id: "ask", role: "user", kind: "text", text: "both of you, go", at }],
};

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return { ...actual, useStore: () => ({ state: { ...actual.initialState, bots, groups: [room] }, dispatch: vi.fn() }) };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } } }),
  useCaptionChrome: () => ({}),
}));
vi.mock("react-dom", async (original) => ({ ...await original<object>(), createPortal: (children: unknown) => children }));
import { GroupView } from "./GroupView";

const render = (group: Group) => {
  vi.stubGlobal("window", { ogb: undefined });
  vi.stubGlobal("document", { body: {}, hidden: false, addEventListener() {}, removeEventListener() {} });
  return renderToStaticMarkup(createElement(GroupView, { group }));
};
const rows = (html: string) => html.split('class="turn-presence').slice(1);
const started = (threadId: string, botId: string, seconds: number) =>
  roomMemberTurns.event({ type: "turn.started", threadId, roomBotId: botId, turnId: `${botId}-${threadId}`, createdAt: new Date(at + seconds * 1000).toISOString() });

beforeEach(() => roomMemberTurns.reset());
afterEach(() => vi.unstubAllGlobals());

describe("room presence for simultaneous members", () => {
  it("draws one row per member working in this thread, each with its own body and activity", () => {
    started("room-a", "atlas", 0);
    started("room-a", "juniper", 5);
    const search: Message = { id: "search", role: "bot", kind: "activity", at: at + 6000, from: from("juniper"), tool: { name: "search" } };
    const html = render({ ...room, activeBotIds: ["atlas", "juniper"], busyBotId: "atlas", messages: [...room.messages, search] });
    const shown = rows(html);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toContain("Atlas · Thinking");
    expect(shown[0]).toContain('src="/api/attachments/atlas.png"');
    expect(shown[1]).toContain("Juniper · Searching");
    expect(shown[1]).toContain('data-gesture="searching"');
    expect(shown[1]).not.toContain("<img");
  });

  it("drops a stopped member and keeps the survivor", () => {
    started("room-a", "atlas", 0);
    started("room-a", "juniper", 5);
    // the room frame after Juniper is stopped; its completion never arrived
    roomMemberTurns.room(["room-a", "room-b"], ["atlas"]);
    const shown = rows(render({ ...room, activeBotIds: ["atlas"], busyBotId: "atlas" }));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Atlas · Thinking");
  });

  it("drops a member once its own turn completes", () => {
    started("room-a", "atlas", 0);
    started("room-a", "juniper", 5);
    roomMemberTurns.event({ type: "turn.completed", threadId: "room-a", roomBotId: "juniper", turnId: "juniper-room-a" });
    const reply: Message = { id: "reply", role: "bot", kind: "text", text: "done", at: at + 9000, from: from("juniper") };
    const shown = rows(render({ ...room, activeBotIds: ["atlas"], busyBotId: "atlas", messages: [...room.messages, reply] }));
    expect(shown.filter((row) => row.includes("Atlas · Thinking"))).toHaveLength(1);
    expect(shown.some((row) => row.includes("Juniper ·"))).toBe(false);
  });

  it("leaves out members working in another thread of the room or in their private thread", () => {
    started("room-a", "atlas", 0);
    started("room-b", "kai", 0);
    // private work carries no roomBotId and is never recorded
    roomMemberTurns.event({ type: "turn.started", threadId: "thread-juniper", turnId: "private", createdAt: new Date(at).toISOString() });
    const html = render({ ...room, activeBotIds: ["atlas", "kai"], busyBotId: "atlas",
      tasks: room.tasks!.map((task) => ({ ...task, state: "running" as const })) });
    const shown = rows(html);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Atlas · Thinking");
  });

  it("does not turn a finished receipt into live activity", () => {
    started("room-a", "juniper", 0);
    const done: Message = { id: "read", role: "bot", kind: "activity", at: at + 2000, from: from("juniper"), tool: { name: "Read", ok: true } };
    const shown = rows(render({ ...room, activeBotIds: ["juniper"], busyBotId: "juniper", messages: [...room.messages, done] }));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Juniper · Thinking");
  });
});

it("lead review: shows a fresh turn even when the tail is this member's previous reply", () => {
  started("room-a", "atlas", 10);
  const oldReply: Message = { id: "old-reply", role: "bot", kind: "text", text: "previous result", at: at + 5000, from: from("atlas") };
  const shown = rows(render({ ...room, activeBotIds: ["atlas"], busyBotId: "atlas", messages: [...room.messages, oldReply] }));
  expect(shown.some((row) => row.includes("Atlas · Thinking"))).toBe(true);
});

describe("room presence after opening or reconnecting mid-turn", () => {
  const snapshot = [
    { botId: "atlas", threadId: "room-a", startedAt: at, turnId: "atlas-room-a" },
    { botId: "kai", threadId: "room-b", startedAt: at, turnId: "kai-room-b" },
  ];

  it("draws members the snapshot places in this thread, and only them", () => {
    const shown = rows(render({ ...room, activeBotIds: ["atlas", "kai"], busyBotId: "atlas", activeMemberTurns: snapshot }));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Atlas · Thinking");
  });

  it("draws nobody for room-wide activity with no snapshot to place it", () => {
    expect(rows(render({ ...room, activeBotIds: ["atlas", "kai"], busyBotId: "atlas" }))).toHaveLength(0);
  });

  it("keeps a completed member out while the frame before its completion is still current", () => {
    started("room-a", "atlas", 0);
    roomMemberTurns.event({ type: "turn.completed", threadId: "room-a", roomBotId: "atlas", turnId: "atlas-room-a" });
    expect(rows(render({ ...room, activeBotIds: ["atlas"], busyBotId: "atlas", activeMemberTurns: snapshot.slice(0, 1) }))).toHaveLength(0);
  });
});
