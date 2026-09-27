import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contactId } from "../shared/multiplayer.ts";
import { SharedRoomRepository } from "./shared-room-repository.ts";

const root = mkdtempSync(join(tmpdir(), "omb-shared-rooms-"));
afterEach(() => rmSync(root, { force: true, recursive: true }));

describe("shared room repository", () => {
  it("exposes revision 1 for legacy rooms so clients can delete them", () => {
    const file = join(root, "legacy", "rooms.json");
    const owner = "firaz-home:person:owner";
    const repo = new SharedRoomRepository(file, "firaz-home");
    const room = repo.create("Legacy group", [owner, "putri-home:person:owner"]);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    delete saved.rooms[0].room.revision;
    writeFileSync(file, JSON.stringify(saved));
    const before = readFileSync(file, "utf8");
    const loaded = new SharedRoomRepository(file, "firaz-home");
    expect(loaded.summariesFor(owner)[0]?.revision).toBe(1);
    expect(loaded.roomFor(room.id, owner)?.revision).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
    loaded.deleteRoom(room.id, owner, loaded.summariesFor(owner)[0]!.revision!);
    expect(new SharedRoomRepository(file, "firaz-home").listFor(owner)).toEqual([]);
  });
  it("quarantines a bad saved entry while retaining valid room history", () => {
    const file = join(root, "quarantine", "rooms.json");
    const firaz = { homeId: "firaz-home", kind: "person" as const, localId: "owner" };
    const store = new SharedRoomRepository(file, firaz.homeId);
    const room = store.create("Team", [contactId(firaz), contactId({ homeId: "putri-home", kind: "person", localId: "owner" })]);
    store.append(room.id, contactId(firaz), { actor: firaz, text: "history", sendId: "before" });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.rooms.push(null);
    writeFileSync(file, JSON.stringify(saved));
    const recovered = new SharedRoomRepository(file, firaz.homeId);
    expect(recovered.messagesAfter(room.id, contactId(firaz), 0)[0]?.text).toBe("history");
    const backup = readdirSync(join(root, "quarantine")).find(name => name.startsWith("rooms.json.quarantine-"));
    expect(backup).toBeTruthy();
    expect(JSON.parse(readFileSync(join(root, "quarantine", backup!), "utf8")).rooms).toHaveLength(2);
  });
  it("keeps history through revisioned rename and leave, then deletes for everyone", () => {
    const file = join(root, "edits", "rooms.json");
    const firaz = { homeId: "firaz-home", kind: "person" as const, localId: "owner" };
    const putri = { homeId: "putri-home", kind: "person" as const, localId: "owner" };
    const faeez = { homeId: "faeez-home", kind: "person" as const, localId: "owner" };
    const repo = new SharedRoomRepository(file, firaz.homeId);
    const room = repo.create("Group chat", [contactId(firaz), contactId(putri), contactId(faeez)], Date.now(), contactId(firaz));
    repo.append(room.id, contactId(putri), { actor: putri, text: "keep this", sendId: "msg-1" });
    const renamed = repo.updateRoom(room.id, contactId(firaz), 1, { name: "Team" });
    expect(renamed.revision).toBe(2);
    expect(() => repo.updateRoom(room.id, contactId(firaz), 1, { name: "Stale" })).toThrow("room changed");
    const left = repo.updateRoom(room.id, contactId(putri), 2, { memberIds: [contactId(firaz), contactId(faeez)] });
    expect(left.revision).toBe(3);
    expect(repo.messagesAfter(room.id, contactId(firaz), 0)[0]?.text).toBe("keep this");
    expect(repo.roomFor(room.id, contactId(putri))).toBeNull();
    expect(new SharedRoomRepository(file, firaz.homeId).messagesAfter(room.id, contactId(firaz), 0)[0]?.text).toBe("keep this");
    repo.deleteRoom(room.id, contactId(firaz), 3);
    expect(repo.roomFor(room.id, contactId(firaz))).toBeNull();
  });
  it("persists ordered messages and lets only members read or send", () => {
    const file = join(root, "private", "rooms.json");
    const firaz = { homeId: "firaz-home", kind: "person" as const, localId: "firaz" };
    const putri = { homeId: "putri-home", kind: "person" as const, localId: "putri" };
    const outsider = { homeId: "other-home", kind: "person" as const, localId: "other" };
    const store = new SharedRoomRepository(file, firaz.homeId);
    const room = store.create("Together", [contactId(firaz), contactId(putri)]);
    for (let n = 0; n < 205; n++) {
      store.append(room.id, contactId(firaz), { actor: firaz, text: `line ${n}`, sendId: `send-${n}` }, n);
    }
    expect(store.messagesAfter(room.id, contactId(putri), 200)).toHaveLength(5);
    const last = store.messagesAfter(room.id, contactId(putri), 204)[0]!;
    expect(store.messageFor(room.id, contactId(putri), last.id)?.text).toBe("line 204");
    expect(store.messageFor(room.id, contactId(outsider), last.id)).toBeNull();
    expect(store.roomFor(room.id, contactId(outsider))).toBeNull();
    expect(() => store.append(room.id, contactId(outsider), { actor: outsider, text: "no", sendId: "bad" })).toThrow("room unavailable");
    expect(() => store.append(room.id, contactId(putri), { actor: firaz, text: "forged", sendId: "forged" })).toThrow("actor mismatch");
    const reloaded = new SharedRoomRepository(file, firaz.homeId);
    expect(reloaded.messagesAfter(room.id, contactId(putri), 200)).toHaveLength(5);
    expect(JSON.parse(readFileSync(file, "utf8")).rooms[0].messages).toHaveLength(0);
    expect(readFileSync(`${file}.events`, "utf8").trimEnd().split("\n")).toHaveLength(205);
  });
  it("preserves valid journal entries and quarantines a torn tail", () => {
    const file = join(root, "journal", "rooms.json");
    const firaz = { homeId: "firaz-home", kind: "person" as const, localId: "owner" };
    const actorId = contactId(firaz);
    const repo = new SharedRoomRepository(file, firaz.homeId);
    const room = repo.create("Team", [actorId, contactId({ homeId: "putri-home", kind: "person", localId: "owner" })]);
    repo.append(room.id, actorId, { actor: firaz, text: "kept", sendId: "one" });
    writeFileSync(`${file}.events`, `${readFileSync(`${file}.events`, "utf8")}{\"truncated\":`, "utf8");
    const recovered = new SharedRoomRepository(file, firaz.homeId);
    expect(recovered.messagesAfter(room.id, actorId, 0).map(message => message.text)).toEqual(["kept"]);
    expect(readdirSync(join(root, "journal")).some(name => name.startsWith("rooms.json.events.quarantine-"))).toBe(true);
    expect(new SharedRoomRepository(file, firaz.homeId).messagesAfter(room.id, actorId, 0).map(message => message.text)).toEqual(["kept"]);
  });
});
