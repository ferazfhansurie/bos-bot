import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SharedRoomRepository } from "./shared-room-repository.ts";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bos-message-actions-")); roots.push(root);
  const file = join(root, "rooms.json");
  const repo = new SharedRoomRepository(file, "one");
  const owner = "one:person:owner", teammate = "two:person:owner";
  const actor = { homeId: "one", kind: "person" as const, localId: "owner" };
  const room = repo.create("Humans", [owner, teammate], 1, owner, "group");
  return { repo, room, owner, teammate, actor, file };
}
it("syncs a monotonic per-person read cursor and notification choice across restarts", () => {
  const { repo, room, actor, owner, teammate, file } = fixture();
  repo.append(room.id, owner, { actor, text: "one", sendId: "first" });
  repo.append(room.id, owner, { actor, text: "two", sendId: "second" });
  expect(repo.summariesFor(teammate)[0]?.unreadCount).toBe(2);
  repo.updatePreferences(room.id, teammate, { readSequence: 2, notifications: "mentions" });
  repo.updatePreferences(room.id, teammate, { readSequence: 1 });
  const reloaded = new SharedRoomRepository(file, "one");
  expect(reloaded.summariesFor(teammate)[0]).toMatchObject({ unreadCount: 0, readSequence: 2, notifications: "mentions" });
  expect(reloaded.preferencesFor(room.id, owner)).toEqual({ readSequence: 0, notifications: "all" });
  expect(() => repo.updatePreferences(room.id, teammate, { readSequence: 3 })).toThrow("invalid read");
  expect(() => repo.preferencesFor(room.id, "outsider:person:owner")).toThrow("room unavailable");
});
it("edits and tombstones only the author's message; original send retries remain idempotent", () => {
  const { repo, room, actor, owner, teammate, file } = fixture();
  const request = { actor, text: "original", sendId: "first", botTargets: [] };
  const { message } = repo.append(room.id, owner, request);
  expect(() => repo.editMessage(room.id, teammate, message.id, "forged")).toThrow("only your own");
  const edited = repo.editMessage(room.id, owner, message.id, "corrected", 100);
  expect(edited).toMatchObject({ text: "corrected", editedAt: 100, changeSequence: 1 });
  expect(repo.changesAfter(room.id, teammate, 0)).toEqual({ changes: [edited], version: 1 });
  expect(repo.append(room.id, owner, request)).toEqual({ created: false, message: edited });
  const removed = repo.editMessage(room.id, owner, message.id, null, 200);
  expect(removed).toMatchObject({ text: "", deletedAt: 200, attachments: [], changeSequence: 2 });
  const reloaded = new SharedRoomRepository(file, "one");
  expect(reloaded.append(room.id, owner, request)).toEqual({ created: false, message: removed });
  expect(() => reloaded.append(room.id, owner, { ...request, text: "different" })).toThrow("send id conflict");
  expect(reloaded.allMessages(room.id)).toHaveLength(1);
});
it("binds reply references to an existing visible message in the same conversation", () => {
  const { repo, room, actor, owner, teammate } = fixture();
  const first = repo.append(room.id, owner, { actor, text: "context", sendId: "first" }).message;
  const reply = repo.append(room.id, owner, { actor, text: "this", sendId: "reply", replyTo: first.id }).message;
  expect(reply.replyTo).toBe(first.id);
  const other = repo.create("Other", [owner, teammate]);
  expect(() => repo.append(other.id, owner, { actor, text: "leak", sendId: "wrong", replyTo: first.id })).toThrow("reply message unavailable");
  repo.editMessage(room.id, owner, first.id, null);
  expect(() => repo.append(room.id, owner, { actor, text: "gone", sendId: "gone", replyTo: first.id })).toThrow("reply message unavailable");
});

it("persists member reactions and pins without changing the original send or read order", () => {
  const { repo, room, actor, owner, teammate, file } = fixture();
  const input = { actor, text: "agreed decision", sendId: "decision" };
  const message = repo.append(room.id, owner, input).message;
  repo.annotateMessage(room.id, teammate, message.id, { reaction: "✅", active: true });
  const duplicate = repo.annotateMessage(room.id, teammate, message.id, { reaction: "✅", active: true });
  expect(duplicate.reactions).toEqual({ "✅": [teammate] });
  expect(duplicate.changeSequence).toBe(1);
  repo.annotateMessage(room.id, owner, message.id, { reaction: "✅", active: true });
  repo.annotateMessage(room.id, teammate, message.id, { pinned: true });
  const reloaded = new SharedRoomRepository(file, "one");
  expect(reloaded.searchFor(room.id, owner, { kind: "pinned" }).messages.map(item => item.id)).toEqual([message.id]);
  expect(reloaded.append(room.id, owner, input).created).toBe(false);
  expect(() => repo.annotateMessage(room.id, "other:person:owner", message.id, { pinned: true })).toThrow("unavailable");
  expect(() => repo.annotateMessage(room.id, owner, message.id, { reaction: "garbage", active: true })).toThrow("invalid reaction");
  expect(repo.annotateMessage(room.id, teammate, message.id, { reaction: "✅", active: false }).reactions).toEqual({ "✅": [owner] });
  repo.annotateMessage(room.id, owner, message.id, { pinned: false });
  expect(repo.searchFor(room.id, owner, { kind: "pinned" }).messages).toEqual([]);
  repo.editMessage(room.id, owner, message.id, null);
  expect(() => repo.annotateMessage(room.id, teammate, message.id, { pinned: true })).toThrow("unavailable");
});
