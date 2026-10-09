import { compatEnv } from "../../../electron/branding-env.cjs";
import {
  mkdtemp,
  writeFile,
  copyFile,
  stat,
  rm,
  mkdir,
  readdir,
  lstat,
  cp,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync, backup } from "node:sqlite";
import assert from "node:assert/strict";
import pg from "pg";
import { connect, migrate, inventory, mappedId } from "./tool.mjs";
const node = process.execPath;
const root = await mkdtemp(join(tmpdir(), "bos-migration-rehearsal-"));
let server, c;
const source = join(root, "copy");
const evidenceDir = compatEnv.BOS_MIGRATION_EVIDENCE;
if (!evidenceDir) throw new Error("BOS_MIGRATION_EVIDENCE required");
const evidence = {
  date: new Date().toISOString(),
  mode:
    compatEnv.BOS_MIGRATION_REAL_COPY === "1" ? "local-copy" : "fictional",
  serving_projection: false,
  checks: {},
};
async function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(bin + " failed (private output withheld)");
}
try {
  await mkdir(source, { mode: 0o700 });
  await writeFile(
    join(source, ".bos-migration-copy.json"),
    JSON.stringify({ source_install_id: "firaz-local-20261008" }),
    { mode: 0o600 },
  );
  if (evidence.mode === "local-copy") {
    const live = join(homedir(), ".bos-bot");
    const db = new DatabaseSync(join(live, "messages.db"), { readOnly: true });
    try {
      await backup(db, join(source, "messages.db"));
    } finally {
      db.close();
    }
    for (const name of [
      "groups.json",
      "bots.json",
      "multiplayer-actors.json",
      "multiplayer-links.json",
      "shared-rooms.json",
      "shared-rooms.json.events",
      "workspace-membership.json",
      "trusted-peers.json",
      "work-runtime.json",
    ]) {
      await copyFile(join(live, name), join(source, name)).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
    // Include the complete legacy transcript/attachment inventory, not just
    // SQLite's already-touched threads. Abort instead of silently truncating
    // a rehearsal that cannot fit the frozen local disk budget.
    let budget = (await stat(join(source, "messages.db"))).size;
    async function extra(rel) {
      const st = await lstat(join(live, rel));
      if (st.isDirectory()) {
        await mkdir(join(source, rel), { recursive: true, mode: 0o700 });
        for (const name of (await readdir(join(live, rel))).sort())
          await extra(join(rel, name));
        return;
      }
      budget += st.size;
      if (budget >= 1024 ** 3)
        throw new Error("complete rehearsal copy exceeds 1Gi budget");
      if (st.isSymbolicLink())
        await cp(join(live, rel), join(source, rel), {
          dereference: false,
          verbatimSymlinks: true,
        });
      else if (st.isFile()) await copyFile(join(live, rel), join(source, rel));
      else throw new Error("non-regular source cannot be copied");
    }
    for (const name of (await readdir(live))
      .filter((n) => /^messages-.+\.json$/.test(n))
      .sort())
      await extra(name);
    if (
      await lstat(join(live, "attachments")).catch((e) => {
        if (e.code === "ENOENT") return null;
        throw e;
      })
    )
      await extra("attachments");
  } else {
    const db = new DatabaseSync(join(source, "messages.db"));
    db.exec(
      "CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,json TEXT)",
    );
    const insert = db.prepare("INSERT INTO messages VALUES(?,?,?,?)");
    for (let n = 0; n < 223; n++)
      insert.run(
        "thread",
        "m" + n,
        n,
        JSON.stringify({
          id: "m" + n,
          role: "user",
          text: n === 7 ? "hello\u0000\ud800" : "fixture " + n,
          deleted: n === 8,
        }),
      );
    db.close();
    await writeFile(
      join(source, "groups.json"),
      JSON.stringify([{ id: "room", name: "fictional" }]),
    );
  }
  const measuredCopy = spawnSync("/usr/bin/du", ["-sk", source], {
    encoding: "utf8",
  });
  const copyBytes = Number(measuredCopy.stdout.trim().split(/\s+/)[0]) * 1024;
  evidence.copy_bytes = copyBytes;
  assert.ok(copyBytes < 1024 * 1024 * 1024, "copy below 1Gi");
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  await run("/opt/homebrew/bin/initdb", [
    "-D",
    join(root, "pg"),
    "-U",
    "bos_owner",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  server = spawn(
    "/opt/homebrew/bin/postgres",
    [
      "-D",
      join(root, "pg"),
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-k",
      "",
      "-c",
      "shared_buffers=16MB",
      "-c",
      "max_wal_size=128MB",
    ],
    { stdio: "ignore", env: { ...compatEnv, LC_ALL: "C" } },
  );
  const url = `postgres://bos_owner@127.0.0.1:${port}/bos_migration_rehearsal_${process.pid}`;
  for (let n = 0; ; n++) {
    const a = new pg.Client({
      connectionString: `postgres://bos_owner@127.0.0.1:${port}/postgres`,
      connectionTimeoutMillis: 200,
    });
    try {
      await a.connect();
      await a.query("CREATE DATABASE bos_migration_rehearsal_" + process.pid);
      break;
    } catch (e) {
      if (n > 60) throw e;
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await a.end().catch(() => {});
    }
  }
  c = await connect(url);
  const workspace = "rehearsal";
  evidence.inventory = await migrate(c, source, workspace, "inventory");
  await migrate(c, source, workspace, "freeze");
  // Child dies after committing batch one. Checkpoint and rows must survive it.
  const child = spawn(
    node,
    [
      "--input-type=module",
      "-e",
      `import {connect,migrate} from ${JSON.stringify(new URL("./tool.mjs", import.meta.url).href)}; const c=await connect(process.env.BOS_MIGRATION_URL);await migrate(c,process.env.COPY,'rehearsal','import',{batch:50,onBatch:()=>{process.send('committed');return new Promise(()=>{});}});`,
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...compatEnv, BOS_MIGRATION_URL: url, COPY: source },
    },
  );
  await new Promise((r, j) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      j(new Error("kill checkpoint timeout"));
    }, 30000);
    child.once("message", () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
    child.once("exit", (code) =>
      code === null ? r() : j(new Error("child failed")),
    );
  });
  const checkpoint = Number(
    (await c.query("SELECT checkpoint FROM migration.migration_runs")).rows[0]
      .checkpoint,
  );
  assert.equal(checkpoint, 50);
  evidence.checks.kill_committed_checkpoint = checkpoint;
  await migrate(c, source, workspace, "import", { batch: 500 });
  const first = await migrate(c, source, workspace, "validate");
  await migrate(c, source, workspace, "import");
  const second = await migrate(c, source, workspace, "validate");
  assert.deepEqual(second, first);
  evidence.validation = second;
  evidence.checks.idempotent = true;
  const measured = spawnSync("/usr/bin/du", ["-sk", root], {
    encoding: "utf8",
  });
  evidence.peak_measured_bytes =
    Number(measured.stdout.trim().split(/\s+/)[0]) * 1024;
  assert.ok(
    evidence.peak_measured_bytes < 3 * 1024 ** 3,
    "copy and PG must stay under 3Gi",
  );
  await assert.rejects(migrate(c, source, workspace, "cutover"), /projection/);
  evidence.checks.cutover_refused = true;
  await c.query(
    "UPDATE migration.migration_runs SET state='cloud_active' WHERE workspace_id=$1",
    [workspace],
  );
  await assert.rejects(
    migrate(c, source, workspace, "rollback"),
    /forward repair/,
  );
  await c.query(
    "UPDATE migration.migration_runs SET state='validated' WHERE workspace_id=$1",
    [workspace],
  );
  evidence.checks.post_write_rollback_refused = true;
  const groupsFile = join(source, "groups.json");
  const before = await (await import("node:fs/promises")).readFile(groupsFile);
  await writeFile(groupsFile, "[]");
  await assert.rejects(
    migrate(c, source, workspace, "import"),
    /source changed/,
  );
  await writeFile(groupsFile, before);
  evidence.checks.source_drift_refused = true;
  // Tampering and source drift must stop, without silently remapping.
  await c.query(
    "UPDATE migration.legacy_records SET payload='{}' WHERE workspace_id=$1 AND source_type='metadata' AND source_id='groups.json'",
    [workspace],
  );
  await assert.rejects(migrate(c, source, workspace, "validate"), /mismatch/);
  evidence.checks.tampering_refused = true;
  await migrate(c, source, workspace, "rollback");
  assert.equal(
    (await c.query("SELECT count(*) n FROM migration.legacy_records")).rows[0]
      .n,
    "0",
  );
  assert.equal(
    await stat(join(source, "cloud-authority.json")).catch(() => null),
    null,
  );
  evidence.checks.rollback_target_empty_and_copy_writable = true;
  assert.match(mappedId("a", "b", "c"), /^[a-f0-9-]{14}5/);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, evidence.mode + "-rehearsal.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      mode: evidence.mode,
      count: second.count,
      quarantine: second.quarantine,
      digest: second.digest,
      checks: evidence.checks,
    }),
  );
} finally {
  await c?.end();
  if (server) {
    const stopped = new Promise((r) =>
      server.exitCode !== null ? r() : server.once("exit", r),
    );
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(root, { recursive: true, force: true });
  evidence.cleanup_verified = (await stat(root).catch(() => null)) === null;
  if (evidence.validation) {
    await writeFile(
      join(evidenceDir, evidence.mode + "-rehearsal.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
  }
}
