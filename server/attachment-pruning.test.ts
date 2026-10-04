import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const root = mkdtempSync(join(tmpdir(), "omb-attachment-pruning-"));
process.env.OMB_DATA_DIR = root;
vi.resetModules();
const { ATTACHMENTS_DIR, ATTACHMENTS_MAX_BYTES, __resetAttachmentAccountingForTests, saveImage, saveFile } = await import("./attachments.ts");
const names = [1, 2, 3, 4, 5, 6].map(n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}.png`);
function file(index: number, bytes: number, ageDays = 3): string {
  const path = join(ATTACHMENTS_DIR, names[index]!);
  writeFileSync(path, "x");
  truncateSync(path, bytes);
  const time = new Date(Date.now() - ageDays * 86400_000);
  utimesSync(path, time, time);
  __resetAttachmentAccountingForTests();
  return path;
}
beforeEach(() => { mkdirSync(ATTACHMENTS_DIR, { recursive: true }); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  __resetAttachmentAccountingForTests();
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

it("raises the aggregate attachment cap to 2 GiB", () => {
  expect(ATTACHMENTS_MAX_BYTES).toBe(2 * 1024 ** 3);
});

it("prunes only the oldest unreferenced file needed to admit an image", () => {
  const oldest = file(0, 4, 5);
  const newer = file(1, ATTACHMENTS_MAX_BYTES - 4, 3);
  const saved = saveImage(Buffer.from("new"), "image/png");
  expect(existsSync(oldest)).toBe(false);
  expect(existsSync(newer)).toBe(true);
  expect(readFileSync(saved.path, "utf8")).toBe("new");
});

it("preserves all sqlite transcript branches, queued sends and persisted avatars while pruning for a streamed file", async () => {
  const referenced = [file(0, ATTACHMENTS_MAX_BYTES - 20, 9), file(1, 4, 8), file(2, 4, 7), file(3, 4, 6)];
  const garbage = file(4, 8, 5);
  const db = new DatabaseSync(join(root, "messages.db"));
  db.exec("CREATE TABLE messages (thread_id TEXT, json TEXT); CREATE TABLE chat_followups (payload TEXT)");
  db.prepare("INSERT INTO messages VALUES (?, ?)").run("archived-off-branch", JSON.stringify({ text: `<attached-image path=\"${referenced[0]}\"/>` }));
  db.prepare("INSERT INTO messages VALUES (?, ?)").run("old-retained-thread", JSON.stringify({ attachments: [{ path: referenced[1] }] }));
  db.prepare("INSERT INTO chat_followups VALUES (?)").run(JSON.stringify({ text: `<attached-image path=\"${referenced[2]}\"/>` }));
  db.close();
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ avatarUrl: `/api/attachments/${names[3]}` }]));
  const saved = await saveFile((async function* () { yield Buffer.from("new"); })(), "new.txt", "text/plain", { expectedBytes: 3 });
  expect(referenced.every(existsSync)).toBe(true);
  expect(existsSync(garbage)).toBe(false);
  expect(saved.bytes).toBe(3);
});

it("protects fresh uploads and unknown filenames with an actionable storage error", () => {
  const recent = file(0, ATTACHMENTS_MAX_BYTES - 1, 0);
  const unknown = join(ATTACHMENTS_DIR, "notes.txt");
  writeFileSync(unknown, "x");
  __resetAttachmentAccountingForTests();
  expect(() => saveImage(Buffer.from("new"), "image/png")).toThrow(/storage is full.*remove.*retry/i);
  expect(existsSync(recent)).toBe(true);
  expect(existsSync(unknown)).toBe(true);
});

it("fails closed when persisted reference data cannot be read", () => {
  const old = file(0, ATTACHMENTS_MAX_BYTES, 5);
  writeFileSync(join(root, "bots.json"), "{broken");
  expect(() => saveImage(Buffer.from("new"), "image/png")).toThrow(/could not verify.*retry/i);
  expect(existsSync(old)).toBe(true);
});
