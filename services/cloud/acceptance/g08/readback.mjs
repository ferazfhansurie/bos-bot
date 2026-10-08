// G08 native: what a signed-in client reads back after cutover, over the
// room service's own HTTP API with the owner's bearer from migrate.mjs.
//
//   node readback.mjs <state.json> <outDir>
//
// Pages /history to the start of every discovered (room, thread) and checks
// it against counts.json (served rows, source order). Writes ui-expected.json:
// for the first discovered row of each room, the snapshot's message ids in
// order, which is exactly what the app renders when that row is opened.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [statePath, out] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));
const bearer = (await readFile(join(out, "owner-bearer"), "utf8")).trim();
const counts = JSON.parse(await readFile(join(out, "counts.json"), "utf8"));
const call = async (method, path, body) => {
  const r = await fetch(state.url + path, {
    method, headers: { authorization: "Bearer " + bearer, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path} ${r.status} ${await r.text()}`);
  return r.json();
};
const discovery = await call("GET", "/v2/discovery/sync");
const ws = discovery.workspaces.find((w) => w.workspace_id === "g08_native");
if (!ws) throw new Error("migrated workspace not discovered");
const result = { role: ws.role, rows: ws.rooms.length, rooms: [] };
const ui = [];
for (const room of counts.rooms.filter((r) => r.served)) {
  const rows = ws.rooms.filter((r) => r.room_id === room.room_id);
  let total = 0;
  const seqs = [];
  for (const row of rows) {
    let before;
    do {
      const q = new URLSearchParams({ thread_id: row.thread_id, limit: "100", ...(before ? { before } : {}) });
      const page = await call("GET", `/v2/workspaces/${ws.workspace_id}/rooms/${room.room_id}/history?${q}`);
      total += page.messages.length;
      for (const m of page.messages) seqs.push(Number(m.sequence));
      before = page.next_before;
    } while (before);
  }
  const sorted = [...seqs].sort((a, b) => a - b);
  const first = rows[0];
  const snap = await call("POST", `/v2/workspaces/${ws.workspace_id}/rooms/${room.room_id}/snapshot`, { thread_id: first.thread_id });
  ui.push({ room_id: room.room_id, thread_id: first.thread_id, rows: rows.length, message_ids: snap.messages.map((m) => m.message_id) });
  result.rooms.push({
    room_id: room.room_id, discovered_threads: rows.length, expected_threads: room.threads.length,
    served_sql: room.served, history_api: total, distinct_sequences: new Set(seqs).size,
    sequences_contiguous: sorted.every((s, i) => s === i + 1), source_order_matches_sql: room.order_matches,
    snapshot_first_thread: snap.messages.length,
  });
}
await writeFile(join(out, "readback.json"), JSON.stringify(result, null, 2));
await writeFile(join(out, "ui-expected.json"), JSON.stringify({ workspace_id: ws.workspace_id, email: "owner@example.test", rooms: ui }, null, 2));
console.log(JSON.stringify(result, null, 2));
