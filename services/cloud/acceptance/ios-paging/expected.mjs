// iOS cloud-room paging on a migrated copy: what the app must show when it
// scrolls a thread back past the newest 50.
//
//   node expected.mjs <state.json> <outDir> [workspace_id]
//
// Run after ../real-migration/run.mjs (which leaves owner-bearer in outDir).
// For each room's first discovered thread, pages /history to the start as
// the owner and writes ios-paging-expected.json: the thread's message ids in
// sequence order (ids only, no text). CloudHistoryPagingUITests picks the
// largest thread and the largest one that fits in the snapshot plus one page.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [statePath, out, workspace = "real_migration"] = process.argv.slice(2);
if (!statePath || !out) throw new Error("usage: expected.mjs <state.json> <outDir> [workspace_id]");
const state = JSON.parse(await readFile(statePath, "utf8"));
const bearer = (await readFile(join(out, "owner-bearer"), "utf8")).trim();
const call = async (path) => {
  const r = await fetch(state.url + path, { headers: { authorization: "Bearer " + bearer } });
  if (!r.ok) throw new Error(`GET ${path} ${r.status}`);
  return r.json();
};
const ws = (await call("/v2/discovery/sync")).workspaces.find((w) => w.workspace_id === workspace);
if (!ws) throw new Error("migrated workspace not discovered");
const seen = new Set();
const rooms = [];
for (const row of ws.rooms) {
  if (seen.has(row.room_id)) continue;
  seen.add(row.room_id);
  const ids = [];
  let before;
  do {
    const q = new URLSearchParams({ thread_id: row.thread_id, limit: "100", ...(before ? { before } : {}) });
    const page = await call(`/v2/workspaces/${ws.workspace_id}/rooms/${row.room_id}/history?${q}`);
    ids.unshift(...page.messages.map((m) => m.message_id));
    before = page.next_before;
  } while (before);
  rooms.push({ room_id: row.room_id, thread_id: row.thread_id, message_ids: ids });
}
const email = JSON.parse(await readFile(join(out, "counts.json"), "utf8")).owner_email ?? "owner@example.test";
await writeFile(join(out, "ios-paging-expected.json"), JSON.stringify({ email, rooms }));
console.log(JSON.stringify(rooms.map((r) => ({ room: r.room_id.slice(0, 8), messages: r.message_ids.length }))));
