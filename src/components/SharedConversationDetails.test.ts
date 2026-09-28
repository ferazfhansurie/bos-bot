import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SharedConversationDetails } from "./SharedConversationDetails";
import type { SharedRoom } from "./shared-conversation";

const room: SharedRoom = { id: "group", homeId: "home", name: "Design", kind: "group", memberIds: ["home:person:owner", "away:person:owner"], createdBy: "home:person:owner" };
const render = (selfId: string, patch: Partial<SharedRoom> = {}) => renderToStaticMarkup(createElement(SharedConversationDetails, {
  room: { ...room, ...patch }, selfId, title: "Design", pending: false, error: "", onClose() {}, onShowMessage: async () => {}, onChange: async () => true,
  contacts: [
    { id: "home:person:owner", name: "Firaz", kind: "person" },
    { id: "away:person:owner", name: "Faeez", kind: "person" },
    { id: "third:person:owner", name: "Alex", kind: "person" },
    { id: "home:bot:scout", name: "Scout", kind: "bot" },
  ],
}));

describe("shared conversation details", () => {
  it("shows a full group panel with people-only additions and member roles", () => {
    const html = render("home:person:owner");
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Conversation details");
    expect(html).toContain("Group name");
    expect(html).toContain("Owner");
    expect(html).toContain('value="third:person:owner"');
    expect(html).not.toContain('value="home:bot:scout"');
    expect(html).toContain("Delete for everyone");
    expect(html).toContain("Leave group");
    expect(html).toContain("@mention your bots here — no need to add them");
  });

  it("prevents ordinary members from editing membership or deleting for everyone", () => {
    const html = render("away:person:owner");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('aria-label="Add person"');
    expect(html).not.toContain(">Remove</button>");
    expect(html).not.toContain("Delete for everyone");
    expect(html).toContain("Leave group");
  });

  it("omits group-only controls for direct chats", () => {
    const html = render("home:person:owner", { kind: "direct" });
    expect(html).toContain("Direct conversation");
    expect(html).not.toContain("Group name");
    expect(html).not.toContain("Leave group");
    expect(html).not.toContain('aria-label="Add person"');
  });
});

it("shows per-person reply modes and the eligible fixed responder", () => {
  const html = renderToStaticMarkup(createElement(SharedConversationDetails, {
    room, selfId: "home:person:owner", title: "Design", pending: false, error: "", contacts: [],
    onClose() {}, onShowMessage: async () => {}, onChange: async () => true, onRepliesChange: async () => {},
    preferences: { readSequence: 0, notifications: "all", replyMode: "fixed", replyBotId: "home:bot:scout" },
    eligibleBots: [{ id: "home:bot:scout", name: "Scout", ownerName: "Firaz" }],
  }));
  expect(html).toContain("Who replies to you");
  expect(html).toContain("Follow my last @bot");
  expect(html).toContain("Only when I @mention");
  expect(html).toContain('value="home:bot:scout" selected=""');
});
