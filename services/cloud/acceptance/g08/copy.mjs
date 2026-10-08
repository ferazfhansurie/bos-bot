// G08 native: make the migration copy of ~/.bos-bot this run works on. The
// live data dir is only read (SQLite online backup + plain file copies);
// everything after this runs against the copy. Node >= 22.22 (node:sqlite).
import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, cp, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const dest = resolve(process.argv[2] ?? "");
const live = join(homedir(), ".bos-bot");
if (!process.argv[2] || dest === live || dest.startsWith(live + "/")) throw new Error("usage: copy.mjs <new dir outside ~/.bos-bot>");
await mkdir(dest, { recursive: false, mode: 0o700 });
const db = new DatabaseSync(join(live, "messages.db"), { readOnly: true });
try { await backup(db, join(dest, "messages.db")); } finally { db.close(); }
for (const name of ["groups.json", "bots.json", "multiplayer-actors.json", "multiplayer-links.json", "shared-rooms.json",
  "shared-rooms.json.events", "workspace-membership.json", "trusted-peers.json", "work-runtime.json", "environment-id"]) {
  await copyFile(join(live, name), join(dest, name)).catch((e) => { if (e.code !== "ENOENT") throw e; });
}
for (const name of (await readdir(live)).filter((n) => /^messages-.+\.json$/.test(n)).sort()) await copyFile(join(live, name), join(dest, name));
if (await stat(join(live, "attachments")).catch(() => null)) await cp(join(live, "attachments"), join(dest, "attachments"), { recursive: true, verbatimSymlinks: true });
await writeFile(join(dest, ".bos-migration-copy.json"), JSON.stringify({ source_install_id: "firaz-local-g08-20261008" }), { mode: 0o600 });
console.log(JSON.stringify({ copy: dest }));
