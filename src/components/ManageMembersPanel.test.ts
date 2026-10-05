import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Group } from "@/state/store";

vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { bots: [] }, dispatch: vi.fn() }),
}));

import { isRoomOwner, ManageMembersPanel, roomPersonCandidates, type RoomContact } from "./ManageMembersPanel";

const contact = (id: string, kind: RoomContact["kind"] = "person"): RoomContact => ({ id, name: id, kind });

describe("roomPersonCandidates", () => {
  it("offers people who are neither you nor already in the room", () => {
    const contacts = [
      contact("home-a:person:owner"),
      contact("home-b:person:owner"),
      contact("home-b:person:sam"),
      contact("home-b:bot:pixie", "bot"),
      contact("home-c:person:lee"),
    ];
    const people = [{ id: "home-a:person:owner" }, { id: "home-c:person:lee" }];
    expect(roomPersonCandidates(contacts, people, "home-b:person:sam").map((c) => c.id)).toEqual(["home-b:person:owner"]);
  });

  it("still filters bots and members when your actor is unknown", () => {
    expect(roomPersonCandidates([contact("x:person:a"), contact("x:bot:b", "bot")], [], null).map((c) => c.id)).toEqual(["x:person:a"]);
  });
});

describe("isRoomOwner", () => {
  it("is the room's home owner only, not owners of other homes", () => {
    expect(isRoomOwner("home-a:person:owner", "home-a")).toBe(true);
    expect(isRoomOwner("home-b:person:owner", "home-a")).toBe(false);
    expect(isRoomOwner("home-a:person:sam", "home-a")).toBe(false);
  });

  it("falls back to the owner id shape before the home is known", () => {
    expect(isRoomOwner("home-a:person:owner", undefined)).toBe(true);
    expect(isRoomOwner("home-a:person:sam", undefined)).toBe(false);
  });
});

describe("ManageMembersPanel people", () => {
  const room = (extra: Partial<Group> = {}) => ({
    id: "room-1",
    name: "Launch",
    memberIds: [],
    people: [
      { id: "home-a:person:owner", name: "Ada", homeId: "home-a" },
      { id: "home-b:person:sam", name: "Sam", homeId: "home-b", homeName: "Sam's Mac" },
    ],
    ...extra,
  }) as unknown as Group;
  const render = (group: Group) =>
    renderToStaticMarkup(createElement(ManageMembersPanel, { group, onClose: () => {}, triggerRef: { current: null } }));

  it("tags the owner and offers remove and invite on a room you host", () => {
    const markup = render(room());
    expect(markup).toContain("People");
    expect(markup).toContain("Owner");
    expect(markup).toContain('aria-label="Remove Sam"');
    expect(markup).not.toContain('aria-label="Remove Ada"');
    expect(markup).toContain("Invite link");
  });

  it("only lists people as a guest in another home's room", () => {
    const markup = render(room({ home: { id: "home-a", name: "Ada's Mac" } }));
    expect(markup).toContain("Sam");
    expect(markup).not.toContain("Remove Sam");
    expect(markup).not.toContain("Invite link");
    expect(markup).not.toContain("Add person");
  });
});
