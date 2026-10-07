import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
const url = process.env.CLOUD_MIGRATION_URL;
if (!url) throw new Error("CLOUD_MIGRATION_URL required");
const u = new URL(url);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
  !u.pathname.startsWith("/cloud_slice1_")
)
  throw new Error("throwaway loopback database only");
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const migrations = new URL("./migrations/",import.meta.url);
  for(const name of (await readdir(migrations)).filter(v=>v.endsWith('.sql')).sort())
    await c.query(await readFile(new URL(name,migrations),'utf8'));
  console.log("local cloud schema migrated");
} finally {
  await c.end();
}
