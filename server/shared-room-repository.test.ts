import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contactId } from "../shared/multiplayer.ts";
import { SharedRoomRepository } from "./shared-room-repository.ts";

const root = mkdtempSync(join(tmpdir(), "omb-shared-rooms-"));
afterEach(() => rmSync(root, { force: true, recursive: true }));

describe("shared room repository", () => {
  it("searches retained history with stable cursors, filters and current membership", () => {
    const path = join(root, "search", "rooms.json");
    const repo = new SharedRoomRepository(path, "home");
    const actor = { homeId: "home", kind: "person" as const, localId: "owner" };
    const bot = { homeId: "home", kind: "bot" as const, localId: "helper" };
    const owner = contactId(actor), member = "away:person:owner";
    const room = repo.create("Search", [owner, member]);
    const first = repo.append(room.id, owner, { actor, text: "CAFÉ + plan", sendId: "first", botTargets: [contactId(bot)] }).message;
    for (let i = 0; i < 205; i += 1) repo.append(room.id, owner, { actor, text: `Team update ${i}`, sendId: `update-${i}` });
    const file = repo.append(room.id, owner, { actor, text: "The board", sendId: "file", attachments: [{ id: "board", name: "café-plan.png", mime: "image/png", size: 5 }] }).message;
    const link = repo.append(room.id, owner, { actor, text: "https://example.com/plan", sendId: "link" }).message;
    const result = repo.append(room.id, contactId(bot), { actor: bot, text: "Your café plan", responseTo: first.id, sendId: "result" }).message;
    repo.append(room.id, contactId(bot), { actor: bot, text: "café tool progress", responseTo: first.id, kind: "activity", tool: { name: "working" }, sendId: "progress" });
    const removed = repo.append(room.id, owner, { actor, text: "café removed", sendId: "removed" }).message;
    repo.editMessage(room.id, owner, removed.id, null);
    const page = repo.searchFor(room.id, member, { query: "cafe\u0301", limit: 2 });
    expect(page.messages.map(message => message.id)).toEqual([result.id, file.id]);
    expect(page.hasMore).toBe(true);
    expect(repo.searchFor(room.id, member, { query: "CAFÉ", before: page.before!, limit: 2 }).messages.map(message => message.id)).toEqual([first.id]);
    expect(repo.searchFor(room.id, member, { query: "+" }).messages.map(message => message.id)).toEqual([first.id]);
    expect(repo.searchFor(room.id, member, { kind: "files" }).messages.map(message => message.id)).toEqual([file.id]);
    expect(repo.searchFor(room.id, member, { kind: "links" }).messages.map(message => message.id)).toEqual([link.id]);
    for (const kind of ["bots", "results"] as const) expect(repo.searchFor(room.id, member, { kind }).messages.map(message => message.id)).toEqual([result.id]);
    expect(repo.searchFor(room.id, member, { kind: "people", query: "café" }).messages.map(message => message.id)).toEqual([file.id, first.id]);
    expect(repo.searchFor(room.id, member, { author: contactId(bot) }).messages.map(message => message.id)).toEqual([result.id]);
    repo.editMessage(room.id, owner, first.id, "Revised brief");
    expect(repo.searchFor(room.id, owner, { query: "+ plan" }).messages).toEqual([]);
    expect(new SharedRoomRepository(path, "home").searchFor(room.id, owner, { query: "Revised" }).messages[0]?.id).toBe(first.id);
    for (const options of [{ query: "a".repeat(201) }, { before: 0 }, { limit: 51 }, { author: "invalid" }, { kind: "unknown" }]) {
      expect(() => repo.searchFor(room.id, owner, options as any)).toThrow("invalid conversation search");
    }
    repo.updateRoom(room.id, owner, 1, { memberIds: [owner, "other:person:owner"] });
    expect(() => repo.searchFor(room.id, member)).toThrow("conversation unavailable");
    expect(() => repo.searchFor("missing", owner)).toThrow("conversation unavailable");
  });

  it("pages published files by source message and revokes access with membership", () => {
    const path = join(root, "files", "rooms.json");
    const repo = new SharedRoomRepository(path, "home");
    const actor = { homeId: "home", kind: "person" as const, localId: "owner" };
    const owner = contactId(actor), member = "away:person:owner";
    const room = repo.create("Files", [owner, member]);
    const attachment = (id: string) => ({ id, name: `${id}.txt`, mime: "text/plain", size: 5 });
    const old = repo.append(room.id, owner, { actor, text: "old", sendId: "old", attachments: [attachment("first")] }).message;
    repo.append(room.id, owner, { actor, text: "no file", sendId: "text" });
    const removed = repo.append(room.id, owner, { actor, text: "remove", sendId: "removed", attachments: [attachment("removed")] }).message;
    repo.editMessage(room.id, owner, removed.id, null);
    const recent = repo.append(room.id, owner, { actor, text: "recent", sendId: "recent", attachments: [attachment("second"), attachment("third")] }).message;
    const page = repo.filesFor(room.id, member, Number.MAX_SAFE_INTEGER, 1);
    expect(page.files.map(file => file.attachment.id)).toEqual(["second", "third"]);
    expect(page.files.every(file => file.messageId === recent.id)).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(page.before).toBe(recent.sequence);
    expect(repo.filesFor(room.id, member, page.before!, 1)).toMatchObject({ files: [{ messageId: old.id }], hasMore: false });
    expect(new SharedRoomRepository(path, "home").filesFor(room.id, owner).files).toHaveLength(3);
    for (const before of [0, -1, NaN, 1.2]) expect(() => repo.filesFor(room.id, owner, before)).toThrow("invalid file cursor");
    expect(() => repo.filesFor(room.id, owner, 100, 51)).toThrow("invalid file cursor");
    expect(() => repo.filesFor(room.id, "unknown:person:owner")).toThrow("conversation unavailable");
    repo.updateRoom(room.id, owner, 1, { memberIds: [owner, "other:person:owner"] });
    expect(() => repo.filesFor(room.id, member)).toThrow("conversation unavailable");
  });
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
