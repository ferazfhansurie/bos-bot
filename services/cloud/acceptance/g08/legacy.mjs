// G08 native: the computer's own server, reopened on the migrated copy after
// cutover, the way an installed app finds it. Hermetic like
// scripts/control-omb.ts's verification server: HOME is the copy, the engine
// is the fake CLI, and peer links are set aside so nothing relays out.
//
//   node --experimental-strip-types legacy.mjs <copyDir> <outDir>
//
// Prints {url, pair_url, chat_name, messages} and leaves the server running
// (pid in <outDir>/legacy.pid). A pairing code is single use and short
// lived: `--pair` mints a fresh pair_url from the running server.
// `--after` stops it and reports the copy's message count and probe rows.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verificationServerEnvironment } from "../../../../scripts/control-omb.ts";

const [copy, out, flag] = process.argv.slice(2);
const ROOT = new URL("../../../../", import.meta.url).pathname;
if (!existsSync(join(copy, ".bos-migration-copy.json"))) throw new Error("not a migration copy");
const count = () => {
  const db = new DatabaseSync(join(copy, "messages.db"), { readOnly: true });
  try {
    return {
      messages: db.prepare("SELECT count(*) n FROM messages").get().n,
      probe_rows: db.prepare("SELECT count(*) n FROM messages WHERE text LIKE '%g08 frozen write probe%' OR json LIKE '%g08 frozen write probe%'").get().n,
    };
  } finally { db.close(); }
};

async function pairUrl(url) {
  const pairing = await (await fetch(url + "/api/auth/pairing", {
    method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify({ label: "g08 reopen" }),
  })).json();
  if (!pairing.credential) throw new Error("no pairing credential: " + JSON.stringify(pairing));
  return `openmausbot://pair?address=${new URL(url).host}&token=${encodeURIComponent(pairing.credential)}`;
}

if (flag === "--pair") {
  console.log(await pairUrl(JSON.parse(readFileSync(join(out, "legacy.json"), "utf8")).url));
  process.exit(0);
}
if (flag === "--after") {
  const pid = Number(readFileSync(join(out, "legacy.pid"), "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  console.log(JSON.stringify({ authority: JSON.parse(readFileSync(join(copy, "cloud-authority.json"), "utf8")), ...count() }));
  process.exit(0);
}

for (const f of ["multiplayer-links.json", "trusted-peers.json"]) {
  if (existsSync(join(copy, f))) renameSync(join(copy, f), join(copy, f + ".g08-aside"));
}
mkdirSync(join(copy, "tmp"), { recursive: true });
writeFileSync(join(copy, "config.json"), JSON.stringify({
  instances: { claude: { driver: "claudeAgent", displayName: "G08 fixture", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") } } },
}, null, 2));
const port = await new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const before = count();
const log = openSync(join(out, "legacy.log"), "a", 0o600);
const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
  cwd: ROOT, env: verificationServerEnvironment(process.env, copy, port), stdio: ["ignore", log, log], detached: true,
});
child.unref();
writeFileSync(join(out, "legacy.pid"), String(child.pid));
const url = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(url + "/.well-known/openmausbot/environment")).ok) break; } catch {}
  if (i > 120) throw new Error("legacy server never came up; see legacy.log");
  await new Promise((r) => setTimeout(r, 500));
}
const groups = JSON.parse(readFileSync(join(copy, "groups.json"), "utf8"));
const list = Array.isArray(groups) ? groups : Object.values(groups.groups ?? groups);
const chat = list.find((g) => g?.name)?.name;
writeFileSync(join(out, "legacy.json"), JSON.stringify({ url, chat_name: chat, before }));
console.log(JSON.stringify({ url, chat_name: chat, before }));
