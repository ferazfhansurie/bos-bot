import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contactId } from "../shared/multiplayer.ts";
import { SharedRoomRepository } from "./shared-room-repository.ts";

const root = mkdtempSync(join(tmpdir(), "omb-shared-rooms-"));
afterEach(() => rmSync(root, { force: true, recursive: true }));

describe("shared room repository", () => {
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
    expect(JSON.parse(readFileSync(file, "utf8")).rooms[0].messages).toHaveLength(205);
  });
});
