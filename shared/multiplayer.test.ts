import { describe, expect, it } from "vitest";
import { contactId, parseContactId, SharedRoomLog } from "./multiplayer.ts";

const firaz = { homeId: "home-firaz", kind: "person" as const, localId: "firaz" };
const putri = { homeId: "home-putri", kind: "person" as const, localId: "putri" };
const pixie = { homeId: "home-putri", kind: "bot" as const, localId: "pixie" };
const room = { id: "room-1", homeId: firaz.homeId, name: "Together", memberIds: [firaz, putri, pixie].map(contactId), createdAt: 1 };

describe("multiplayer identity and log", () => {
  it("keeps the home and person/bot kind in every contact key", () => {
    expect(parseContactId(contactId(pixie))).toEqual(pixie);
    expect(contactId(putri)).not.toBe(contactId(pixie));
    expect(parseContactId("home:bot:pixie:extra")).toBeNull();
  });

  it("orders sends at the room home and collapses an identical retry", () => {
    const log = new SharedRoomLog(room);
    const first = log.append({ actor: firaz, text: "hi", sendId: "send-1" }, "message-1", 100);
    expect(first).toMatchObject({ created: true, message: { sequence: 1, actor: firaz } });
    expect(log.append({ actor: firaz, text: "hi", sendId: "send-1" }, "message-2", 101)).toEqual({ message: first.message, created: false });
    expect(log.append({ actor: pixie, text: "hello", sendId: "send-2", responseTo: "message-1" }, "message-3", 102).message.sequence).toBe(2);
    expect(log.after(1)).toHaveLength(1);
  });

  it("rejects a forged member and a changed retry", () => {
    const log = new SharedRoomLog(room);
    expect(() => log.append({ actor: { kind: "person", localId: "firaz" }, text: "hi", sendId: "s-0" }, "m-0", 0)).toThrow("invalid actor");
    expect(() => log.append({ actor: { homeId: "stranger", kind: "person", localId: "x" }, text: "hi", sendId: "s-1" }, "m-1", 1)).toThrow("not in this room");
    log.append({ actor: putri, text: "one", sendId: "s-1" }, "m-1", 1);
    expect(() => log.append({ actor: putri, text: "two", sendId: "s-1" }, "m-2", 2)).toThrow("send id conflict");
  });
  it("lets only an explicitly invoked bot respond without joining the human conversation", () => {
    const humans = { ...room, memberIds: [firaz, putri].map(contactId) };
    const log = new SharedRoomLog(humans);
    const ask = { actor: putri, text: "@Pixie help", sendId: "ask", botTargets: [contactId(pixie)] };
    log.append(ask, "request", 1);
    expect(() => log.append({ actor: pixie, text: "unsolicited", sendId: "no" }, "no", 2)).toThrow();
    expect(() => log.append({ actor: pixie, text: "wrong request", responseTo: "other", sendId: "wrong" }, "wrong", 2)).toThrow();
    expect(log.append({ actor: pixie, text: "answer", responseTo: "request", sendId: "answer" }, "answer", 2).created).toBe(true);
    expect(humans.memberIds).not.toContain(contactId(pixie));
    const revoked = new SharedRoomLog({ ...humans, memberIds: [contactId(firaz)] }, log.all());
    expect(() => revoked.append({ actor: pixie, text: "late answer", responseTo: "request", sendId: "late" }, "late", 3)).toThrow();
    expect(() => log.append({ ...ask, botTargets: [] }, "changed", 4)).toThrow("send id conflict");
  });

  it("lets a bot hand off to another bot only within a member-started, bounded chain", () => {
    const humans = { ...room, memberIds: [firaz, putri].map(contactId) };
    const log = new SharedRoomLog(humans);
    const bot = (localId: string) => ({ homeId: "home-putri", kind: "bot" as const, localId });
    log.append({ actor: putri, text: "@b0 help", sendId: "ask", botTargets: [contactId(bot("b0"))] }, "m0", 1);
    let previous = "m0";
    for (let hop = 0; hop < 5; hop++) {
      const id = `r${hop}`;
      log.append({ actor: bot(`b${hop}`), text: `@b${hop + 1}`, responseTo: previous, sendId: id, botTargets: [contactId(bot(`b${hop + 1}`))] }, id, hop + 2);
      previous = id;
    }
    // b5 would be the fifth handoff: beyond the hop limit.
    expect(() => log.append({ actor: bot("b5"), text: "too deep", responseTo: "r4", sendId: "deep" }, "deep", 9)).toThrow("not in this room");
    expect(() => log.append({ actor: bot("b9"), text: "not asked", responseTo: "r0", sendId: "nope" }, "nope", 9)).toThrow("not in this room");
    expect(() => log.append({ actor: bot("b1"), text: "", kind: "activity", tool: { name: "x" }, responseTo: "r0", sendId: "act", botTargets: [contactId(bot("b2"))] }, "act", 9)).toThrow("invalid bot targets");
    const stranger = new SharedRoomLog({ ...humans, memberIds: [contactId(firaz)] }, log.all());
    expect(() => stranger.append({ actor: bot("b1"), text: "late", responseTo: "r0", sendId: "late" }, "late", 9)).toThrow("not in this room");
  });

});
