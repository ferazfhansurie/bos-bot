import { expect, it } from "vitest";
import { checkedRoomPeople, personCanReadRoom, roomPeople } from "./room-people.ts";
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
