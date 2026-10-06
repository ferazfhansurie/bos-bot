import { expect, it } from "vitest";
import { checkedRoomPeople, personCanReadRoom, roomPeople, roomPushPeople } from "./room-people.ts";
import type { WireGroup } from "../shared/wire.ts";
const owner = "home:person:owner", guest = "other:person:owner";
it("preserves owner access to legacy rooms without admitting any other person", () => {
  const room = { memberIds: ["bot"], peopleIds: undefined } as WireGroup;
  expect(roomPeople(room, owner)).toEqual([owner]);
  expect(personCanReadRoom(room, owner, owner)).toBe(true);
  expect(personCanReadRoom(room, guest, owner)).toBe(false);
  expect(personCanReadRoom({ ...room, peopleIds: [guest] }, guest, owner)).toBe(true);
  expect(personCanReadRoom({ ...room, dm: true, peopleIds: [guest] }, guest, owner)).toBe(false);
});
it("rejects forged identities, bots and duplicates", () => {
  const known = new Set([owner, guest]);
  expect(checkedRoomPeople([guest], owner, known)).toEqual([owner, guest]);
  for (const value of [[guest, guest], ["home:bot:bot"], ["unknown:person:owner"], "guest", null]) expect(() => checkedRoomPeople(value, owner, known)).toThrow();
});
it("pushes only room messages and done notifications to current readable people", () => {
  const blocked = "blocked:person:owner";
  const room = { peopleIds: [guest, blocked, guest], notifications: "all" as const };
  const canRead = (id: string) => id !== blocked;
  expect(roomPushPeople(room, owner, canRead, owner, "done")).toEqual([guest]);
  expect(roomPushPeople(room, owner, canRead, guest)).toEqual([owner]);
  for (const kind of ["approval", "question", "incident", "routine-failed", "routine-deferred", "digest"]) {
    expect(roomPushPeople(room, owner, canRead, owner, kind)).toEqual([]);
  }
  expect(roomPushPeople(room, owner, () => false, owner, "done")).toEqual([]);
  for (const kind of [undefined, "done"]) {
    expect(roomPushPeople({ ...room, notifications: "muted" }, owner, canRead, owner, kind)).toEqual([]);
  }
  expect(roomPushPeople({ peopleIds: [] }, owner, canRead, owner, "done")).toEqual([]);
});
