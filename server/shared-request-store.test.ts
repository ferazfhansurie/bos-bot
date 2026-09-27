import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SharedRequestStore } from "./shared-request-store.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bos-request-store-")); directories.push(root);
  const file = join(root, "requests.json");
  return { root, file, store: new SharedRequestStore(file) };
}
const input = { roomId: "room", roomRevision: 1, sourceId: "source", requesterId: "requester:person:owner",
  botId: "bot-home:bot:helper", botName: "Helper", ownerId: "bot-home:person:owner", ownerName: "Owner", createdAt: 100 };

it("persists one request per exact source and bot, independent of display names", () => {
  const { file, store } = fixture();
  const first = store.ensure(input);
  expect(store.ensure({ ...input, botName: "Renamed" })).toEqual(first);
  expect(store.ensure({ ...input, sourceId: "source-2" }).id).not.toBe(first.id);
  expect(store.ensure({ ...input, botId: "bot-home:bot:other" }).id).not.toBe(first.id);
  const restored = new SharedRequestStore(file);
  expect(restored.all()).toHaveLength(3);
  const copy = restored.get(first.id)!; copy.botName = "Mutated";
  expect(restored.get(first.id)?.botName).toBe("Helper");
});
it("retains dispatch evidence and never reopens a terminal request", () => {
  const { file, store } = fixture();
  const { id } = store.ensure(input);
  store.transition(id, "queued");
  store.transition(id, "working");
  expect(() => store.transition(id, "queued")).toThrow("cannot be queued again");
  store.transition(id, "waiting-approval");
  const interrupted = new SharedRequestStore(file);
  expect(interrupted.get(id)?.dispatchedAt).toBeGreaterThan(0);
  interrupted.transition(id, "outcome-unknown");
  expect(interrupted.ensure(input).state).toBe("outcome-unknown");
  expect(interrupted.transition(id, "working").state).toBe("outcome-unknown");
});
it("allows only the requester or bot owner to cancel, with distinct queued and dispatched explanations", () => {
  const { store } = fixture();
  const queued = store.ensure(input);
  expect(() => store.cancel(queued.id, "bystander:person:owner")).toThrow("only the requester");
  expect(store.cancel(queued.id, input.requesterId)).toMatchObject({ state: "cancelled", cancelledBy: input.requesterId, explanation: "Cancelled before the bot started." });
  expect(store.transition(queued.id, "completed", { resultId: "late-result" }).state).toBe("cancelled");
  const working = store.ensure({ ...input, sourceId: "working" });
  store.transition(working.id, "working");
  expect(store.cancel(working.id, input.ownerId)).toMatchObject({ state: "cancelled", cancelledBy: input.ownerId });
  expect(store.get(working.id)?.explanation).toContain("cannot be undone");
});
it("retains completion and its result when a delayed stop arrives", () => {
  const { store } = fixture(); const { id } = store.ensure(input);
  const completed = store.transition(id, "completed", { resultId: "result" });
  expect(store.cancel(id, input.requesterId)).toEqual(completed);
});
it("rolls memory back on write failure and refuses a corrupt store", () => {
  const { file, store } = fixture(); const { id } = store.ensure(input);
  const saved = readFileSync(file, "utf8");
  rmSync(file); mkdirSync(file);
  expect(() => store.transition(id, "working")).toThrow();
  expect(store.get(id)?.state).toBe("accepted");
  rmSync(file, { recursive: true }); writeFileSync(file, saved.replace('"state":"accepted"', '"state":"made-up"'));
  expect(() => new SharedRequestStore(file)).toThrow("invalid shared request");
});
it("rejects an owner identity unrelated to the bot home", () => {
  const { store } = fixture();
  expect(() => store.ensure({ ...input, ownerId: input.requesterId })).toThrow("invalid shared request");
});
