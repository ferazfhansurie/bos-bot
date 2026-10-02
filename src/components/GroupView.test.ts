import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Message } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { RoomToolChip, RoomReplyText, RoomAvatar } from "./GroupView";

const chip = (patch: Partial<Message> = {}): Message => ({
  id: "chip",
  role: "bot",
  kind: "activity",
  at: 1,
  tool: { name: "Posted in Standup", ok: true },
  ...patch,
});

const render = (message: Message) =>
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(RoomToolChip, { message })));

describe("RoomToolChip", () => {
  it("turns a linked receipt into a button that opens the room it names", () => {
    const markup = render(chip({
      comm: { groupId: "room-standup", withBotId: "scout", withName: "Standup", withColor: "green" },
    }));
    expect(markup).toContain("<button");
    expect(markup).toContain("Posted in Standup");
    expect(markup).toContain('title="Open Standup"');
  });

  it("turns an opened-thread receipt into a button that opens that thread", () => {
    const markup = render(chip({
      tool: { name: "Opened thread #QA PR 245 on Scout", ok: true },
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" },
    }));
    expect(markup).toContain("<button");
    expect(markup).toContain("Opened thread #QA PR 245 on Scout");
    expect(markup).toContain('title="Open #QA PR 245"');
  });

  it("leaves an ordinary step as a plain pill", () => {
    const markup = render(chip());
    expect(markup).not.toContain("<button");
    expect(markup).toContain("Posted in Standup");
  });

  it("shows a same-room teammate avatar without adding a navigation button", () => {
    const message = chip({
      tool: { name: "Sent to Eli", ok: true },
      comm: { groupId: "here", withBotId: "eli", withName: "Eli", withColor: "green" },
    });
    const markup = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(RoomToolChip, { message, roomId: "here" })));
    expect(markup).toContain("Sent to Eli");
    expect(markup).toContain('aria-label="Eli"');
    expect(markup).not.toContain("<button");
  });
});


describe("room presentation", () => {
  it("shows an uploaded room avatar using the private attachment route", () => {
    const markup = renderToStaticMarkup(createElement(RoomAvatar, { name: "HQ", avatarUrl: "/api/attachments/room-photo.png" }));
    expect(markup).toContain('src="/api/attachments/room-photo.png"');
    expect(markup).toContain('alt="HQ"');
    const fallback = renderToStaticMarkup(createElement(RoomAvatar, { name: "HQ", avatarUrl: "https://tracker.invalid/pixel.png" }));
    expect(fallback).not.toContain("tracker.invalid");
  });
  it("keeps the full bot text in an expandable six-line preview, and opens focused replies", () => {
    const message = { ...chip(), kind: "text" as const, text: "long answer\n".repeat(9) };
    const markup = renderToStaticMarkup(createElement(RoomReplyText, { message, members: [], everyone: true }));
    expect(markup).toContain("Show more");
    expect(markup).toContain("line-clamp-6");
    expect(markup).toContain('aria-expanded="false"');
    const focused = renderToStaticMarkup(createElement(RoomReplyText, { message, members: [], everyone: true, forceOpen: true }));
    expect(focused).not.toContain("line-clamp-6");
    expect(focused).toContain('aria-expanded="true"');
  });
});
