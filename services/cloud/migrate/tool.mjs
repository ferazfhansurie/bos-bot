import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  rename,
  realpath,
  rm,
  open,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import pg from "pg";
import { pathToFileURL } from "node:url";
import { scanInventory } from "./inventory.mjs";
import { servingAction, rollbackProjection } from "./serving.mjs";
const HASH = (v) => createHash("sha256").update(v).digest("hex");
const NS = Buffer.from("b6581fef740f55cd8f39549ab86cbb55", "hex");
export function mappedId(install, type, id) {
  const b = createHash("sha1")
    .update(NS)
    .update(JSON.stringify([install, type, id]))
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 80;
  b[8] = (b[8] & 63) | 128;
  const s = b.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error("invalid source JSON");
  }
}
export async function assertCopy(dir) {
  const p = await realpath(dir);
  if (
    p === (await realpath(join(homedir(), ".bos-bot"))) ||
    !(await json(join(p, ".bos-migration-copy.json"), null))
  )
    throw new Error("explicit rehearsal copy required; live source forbidden");
  return p;
}
export async function inventory(dir) {
  return scanInventory(await assertCopy(dir));
}
async function flag(dir, run, state) {
  const file = join(dir, "cloud-authority.json");
  await writeFile(
    file + ".tmp",
    JSON.stringify({
      workspace_id: run.workspace_id,
      epoch: String(run.epoch),
      state,
    }),
    { mode: 0o600 },
  );
  const handle = await open(file + ".tmp", "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(file + ".tmp", file);
  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function connect(url) {
  const u = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    !/^\/bos_migration_rehearsal_[a-z0-9_]+$/.test(u.pathname)
  )
    throw new Error("throwaway loopback rehearsal database required");
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const role = (
      await c.query(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    if (
      role.current_user === "cloud_app" ||
      (!role.rolsuper && !role.rolbypassrls)
    )
      throw new Error("separate RLS-bypassing migration owner required");
    await c.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
  } catch (e) {
    await c.end();
    throw e;
  }
  return c;
}
export async function migrate(c, dir, workspace, action, options = {}) {
  const { batch = 100, onBatch } = options;
  dir = await assertCopy(dir);
  if (
    typeof workspace !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(workspace)
  )
    throw new Error("invalid workspace id");
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000)
    throw new Error("invalid batch size");
  await c.query("SELECT pg_advisory_lock(hashtext($1))", [workspace]);
  try {
    let run = (
      await c.query(
        "SELECT * FROM migration.migration_runs WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0];
    if (action === "rollback") {
      if (!run) {
        const f = await json(join(dir, "cloud-authority.json"), null);
        if (!f) return { state: "rolled_back" };
        if (f.workspace_id !== workspace)
          throw new Error("authority flag mismatch");
        if (["cloud_active", "legacy_archived"].includes(f.state))
          throw new Error("forward repair only");
        const schema = (
          await c.query("SELECT to_regclass('cloud.workspaces') AS name")
        ).rows[0].name;
        if (
          schema &&
          (
            await c.query(
              "SELECT 1 FROM cloud.workspaces WHERE workspace_id=$1",
              [workspace],
            )
          ).rowCount
        )
          throw new Error("forward repair only");
        await rm(join(dir, "cloud-authority.json"), { force: true });
        return { state: "rolled_back" };
      }
      if (["cloud_active", "legacy_archived"].includes(run.state))
        throw new Error("forward repair only");
      const f = await json(join(dir, "cloud-authority.json"), null);
      if (
        f &&
        (f.workspace_id !== workspace || String(f.epoch) !== String(run.epoch))
      )
        throw new Error("authority flag mismatch");
      await rollbackProjection(c, workspace);
      await c.query(
        "DELETE FROM migration.migration_runs WHERE workspace_id=$1",
        [workspace],
      );
      await rm(join(dir, "cloud-authority.json"), { force: true });
      return { state: "rolled_back" };
    }
    const inv = await inventory(dir);
    if (!run) {
      if (action !== "inventory") throw new Error("inventory first");
      await c.query(
        "INSERT INTO migration.migration_runs(workspace_id,source_install_id,source_digest,state) VALUES($1,$2,$3,$4)",
        [workspace, inv.source_install_id, inv.digest, "inventoried"],
      );
      return {
        state: "inventoried",
        count: inv.records.length,
        digest: inv.digest,
      };
    }
    if (
      run.source_install_id !== inv.source_install_id ||
      run.source_digest !== inv.digest
    )
      throw new Error("source changed; hold and reinventory");
    if (
      ["project", "verify-projection", "cutover", "archive"].includes(action)
    ) {
      return servingAction(c, dir, run, inv, action, options, flag);
    }
    if (action === "inventory")
      return {
        state: run.state,
        count: inv.records.length,
        digest: inv.digest,
      };
    if (action === "freeze") {
      if (run.state !== "inventoried" && run.state !== "frozen")
        throw new Error("cannot freeze this state");
      await flag(dir, run, "frozen");
      await c.query(
        "UPDATE migration.migration_runs SET state='frozen' WHERE workspace_id=$1",
        [workspace],
      );
      return { state: "frozen" };
    }
    if (action === "import") {
      if (!["frozen", "imported", "validated"].includes(run.state))
        throw new Error("freeze first");
      const f = await json(join(dir, "cloud-authority.json"), null);
      if (
        f?.workspace_id !== workspace ||
        String(f.epoch) !== String(run.epoch) ||
        !["frozen", "imported", "validated"].includes(f.state)
      )
        throw new Error("freeze flag mismatch");
      for (
        let start = Number(run.checkpoint);
        start < inv.records.length;
        start += batch
      ) {
        await c.query("BEGIN");
        try {
          for (const r of inv.records.slice(start, start + batch)) {
            const id = mappedId(inv.source_install_id, r.type, r.id);
            await c.query(
              "INSERT INTO migration.migration_mappings VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
              [workspace, inv.source_install_id, r.type, r.id, id, r.digest],
            );
            const old = (
              await c.query(
                "SELECT digest FROM migration.migration_mappings WHERE workspace_id=$1 AND source_type=$2 AND source_id=$3",
                [workspace, r.type, r.id],
              )
            ).rows[0];
            if (old?.digest !== r.digest) throw new Error("mapping conflict");
            await c.query(
              "INSERT INTO migration.legacy_records VALUES($1,$2,$3,$4::json,$5::jsonb,'none') ON CONFLICT DO NOTHING",
              [
                workspace,
                r.type,
                r.id,
                r.encoded,
                JSON.stringify({
                  source: inv.source_install_id,
                  source_id: r.id,
                  imported_at: run.created_at,
                }),
              ],
            );
            if (
              !["metadata", "transcript_file", "shared_room_journal"].includes(
                r.type,
              )
            )
              await c.query(
                "INSERT INTO migration.migration_quarantine VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
                [
                  workspace,
                  r.type,
                  r.id,
                  r.type === "message"
                    ? "author_and_grant_projection_required"
                    : "inert_source_requires_review",
                ],
              );
          }
          await c.query(
            "UPDATE migration.migration_runs SET checkpoint=$2 WHERE workspace_id=$1",
            [workspace, Math.min(start + batch, inv.records.length)],
          );
          await c.query("COMMIT");
          await onBatch?.(Math.min(start + batch, inv.records.length));
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      }
      await c.query(
        "UPDATE migration.migration_runs SET state='imported' WHERE workspace_id=$1",
        [workspace],
      );
      await flag(dir, run, "imported");
      return { state: "imported", count: inv.records.length };
    }
    if (action === "validate") {
      if (!["imported", "validated"].includes(run.state))
        throw new Error("import first");
      const rows = (
        await c.query(
          "SELECT source_type,source_id,payload::text AS encoded FROM migration.legacy_records WHERE workspace_id=$1 ORDER BY source_type,source_id",
          [workspace],
        )
      ).rows;
      const actual = rows
        .map((r) => [r.source_type, r.source_id, HASH(r.encoded)])
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      const orders = new Map(
        inv.records.map((r) => [JSON.stringify([r.type, r.id]), r.order]),
      );
      const digest = HASH(
        JSON.stringify(
          actual.map(([type, id, digest]) => [
            type,
            id,
            digest,
            orders.get(JSON.stringify([type, id])) ?? null,
          ]),
        ),
      );
      if (digest !== inv.digest || rows.length !== inv.records.length)
        throw new Error("count/hash mismatch");
      const mappings = (
        await c.query(
          "SELECT source_type,source_id,cloud_id,digest FROM migration.migration_mappings WHERE workspace_id=$1",
          [workspace],
        )
      ).rows;
      if (mappings.length !== inv.records.length)
        throw new Error("mapping count mismatch");
      const expected = new Map(
        inv.records.map((r) => [JSON.stringify([r.type, r.id]), r]),
      );
      for (const m of mappings) {
        const r = expected.get(JSON.stringify([m.source_type, m.source_id]));
        if (
          !r ||
          m.digest !== r.digest ||
          m.cloud_id !== mappedId(inv.source_install_id, r.type, r.id)
        )
          throw new Error("mapping integrity mismatch");
      }
      const quarantine = Number(
        (
          await c.query(
            "SELECT count(*) AS n FROM migration.migration_quarantine WHERE workspace_id=$1",
            [workspace],
          )
        ).rows[0].n,
      );
      await c.query(
        "UPDATE migration.migration_runs SET state='validated' WHERE workspace_id=$1",
        [workspace],
      );
      await flag(dir, run, "validated");
      return {
        state: "validated",
        count: rows.length,
        digest,
        quarantine,
        serving_projection: false,
      };
    }
    throw new Error("unknown action");
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext($1))", [workspace]);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, dir, workspace] = process.argv.slice(2);
  let c;
  try {
    c = await connect(process.env.BOS_MIGRATION_URL);
    const options = {};
    if (process.env.BOS_MIGRATION_PLAN)
      options.plan = JSON.parse(
        await readFile(process.env.BOS_MIGRATION_PLAN, "utf8"),
      );
    if (process.env.BOS_MIGRATION_ACCEPTANCE)
      options.acceptance = JSON.parse(
        await readFile(process.env.BOS_MIGRATION_ACCEPTANCE, "utf8"),
      );
    console.log(
      JSON.stringify(await migrate(c, dir, workspace, action, options)),
    );
  } catch (e) {
    console.error("migration refused or failed: " + e.message);
    process.exitCode = 1;
  } finally {
    await c?.end();
  }
}
