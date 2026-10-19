import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RECEIPT_FILE, STATE_FILE, confirmDone, downloadArchive, provisioningDue, readProvisionFile, runEnterpriseProvisioning, validateProvision,
} from "./enterprise-provision.mjs";

const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const ARCHIVE = Buffer.concat([MAGIC, Buffer.from("encrypted workspace bytes")]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const provision = { version: 1, slug: "acme", label: "sénira", url: "https://bos.example/v1/abc", token: "TOKEN-SECRET-123", password: "PASSWORD-SECRET-456" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "bos-enterprise-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data"), tempRoot = join(root, "tmp");
  mkdirSync(dataDir);
  return { root, dataDir, tempRoot };
}

/** A fake local server whose restore applies only across restartServer(),
 * like the real one, plus the client endpoints. Knobs inject failures. */
function world({ archive = ARCHIVE, header = sha(ARCHIVE), fresh = true } = {}) {
  const w = { calls: [], fresh, pendingRestore: false, lastRestoreId: null, committed: null, restarts: 0, doneBodies: [], burned: false,
    failSetupOnce: false, failDoneOnce: false, crashAfterRestore: false, applied: 0 };
  w.localRequest = async (route, init = {}) => {
    w.calls.push(route);
    if (route === "/api/workspace-backup/status") return json({ busy: false, pendingRestore: w.pendingRestore, lastRestoreId: w.lastRestoreId });
    if (route === "/api/enterprise-provision/status") return json({ fresh: w.fresh, bots: 1, rooms: 0, messages: 1 });
    if (route === "/api/workspace-backup/upload") {
      const chunks = []; for await (const chunk of init.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), archive);
      return json({ id: "upload-1" });
    }
    const body = JSON.parse(init.body);
    if (route === "/api/workspace-backup/preview") {
      assert.equal(body.password, provision.password);
      return json({ id: "staged-1", summary: { bots: 2 } });
    }
    if (route === "/api/workspace-backup/restore") {
      assert.deepEqual(body, { id: "staged-1", confirmation: "REPLACE" });
      w.pendingRestore = true; w.committed = "staged-1";
      if (w.crashAfterRestore) { w.crashAfterRestore = false; throw new Error("app quit"); }
      return json({ restored: true, restartRequired: true, restoreId: "staged-1" });
    }
    if (route === "/api/enterprise-provision/apply") {
      assert.equal(body.setup.version, 1);
      w.applied++;
      return json({ applied: { instances: ["sol"], mcpServers: ["studio"], features: ["managedCodex"], bots: ["b1"] } });
    }
    throw new Error(`unexpected ${route}`);
  };
  w.restartServer = async () => {
    w.restarts++;
    if (w.pendingRestore) { w.pendingRestore = false; w.lastRestoreId = w.committed; w.fresh = false; }
  };
  w.fetchImpl = async (url, init = {}) => {
    assert.equal(init.headers.authorization, `Bearer ${provision.token}`);
    assert.equal(init.redirect, "error");
    const path = url.slice(provision.url.length);
    w.calls.push(`remote${path}`);
    if (w.burned) return json({ error: "gone" }, 410);
    if (path === "/archive") return new Response(archive, { headers: { "x-bos-sha256": header, "content-length": String(archive.length) } });
    if (path === "/setup") {
      if (w.failSetupOnce) { w.failSetupOnce = false; return json({ error: "busy" }, 503); }
      return json({ version: 1, features: { managedCodex: true } });
    }
    if (path === "/done") {
      if (w.failDoneOnce) { w.failDoneOnce = false; throw new Error("offline"); }
      w.doneBodies.push(JSON.parse(init.body)); w.burned = true;
      return json({ ok: true });
    }
    throw new Error(`unexpected ${path}`);
  };
  return w;
}

const run = (s, w) => runEnterpriseProvisioning({
  provision, dataDir: s.dataDir, tempRoot: s.tempRoot, localRequest: w.localRequest, restartServer: w.restartServer,
  fetchImpl: w.fetchImpl, appVersion: "2.0.4",
});

test("provisions end to end and writes a receipt that holds no secrets", async t => {
  const s = sandbox(t), w = world();
  assert.equal(provisioningDue({ provision, dataDir: s.dataDir }), true);
  const receipt = await run(s, w);
  assert.equal(receipt.done, true);
  assert.equal(receipt.restoreId, "staged-1");
  assert.equal(receipt.archiveSha256, sha(ARCHIVE));
  assert.deepEqual(receipt.applied.mcpServers, ["studio"]);
  assert.equal(w.restarts, 1);
  const onDisk = readFileSync(join(s.dataDir, RECEIPT_FILE), "utf8");
  for (const secret of [provision.token, provision.password]) {
    assert.equal(onDisk.includes(secret), false);
    assert.equal(JSON.stringify(w.doneBodies).includes(secret), false);
  }
  assert.equal(w.doneBodies[0].receipt.slug, "acme");
  assert.equal(existsSync(join(s.dataDir, STATE_FILE)), false);
  assert.deepEqual(readdirSync(s.tempRoot), [], "the downloaded archive is removed");
  assert.equal(provisioningDue({ provision, dataDir: s.dataDir }), false);
});

test("a checksum mismatch is rejected before anything is staged", async t => {
  const s = sandbox(t), w = world({ header: "0".repeat(64) });
  await assert.rejects(run(s, w), { code: "checksum_mismatch" });
  assert.equal(w.calls.includes("/api/workspace-backup/upload"), false);
  assert.equal(existsSync(join(s.dataDir, RECEIPT_FILE)), false);
  assert.deepEqual(readdirSync(s.tempRoot), []);
  // The next launch tries again from the start.
  assert.equal(provisioningDue({ provision, dataDir: s.dataDir }), true);
});

test("archives over the cap, without a checksum, or not a workspace are refused", async t => {
  const s = sandbox(t);
  const response = (bytes, headers) => new Response(bytes, { headers });
  await assert.rejects(downloadArchive(response(ARCHIVE, { "x-bos-sha256": sha(ARCHIVE) }), join(s.root, "a"), { maxBytes: 8 }), { code: "archive_too_large" });
  await assert.rejects(downloadArchive(response(ARCHIVE, {}), join(s.root, "b")), { code: "invalid_archive" });
  const plain = Buffer.from("not an archive at all, really");
  await assert.rejects(downloadArchive(response(plain, { "x-bos-sha256": sha(plain) }), join(s.root, "c")), { code: "invalid_archive" });
  for (const name of ["a", "b", "c"]) assert.equal(existsSync(join(s.root, name)), false);
});

test("never replaces a workspace that already holds data", async t => {
  const s = sandbox(t), w = world({ fresh: false });
  const receipt = await run(s, w);
  assert.equal(receipt.skipped, "not-fresh");
  assert.equal(w.calls.some(call => call.startsWith("remote")), false, "no download, no /done");
  assert.equal(w.calls.includes("/api/workspace-backup/restore"), false);
  assert.equal(provisioningDue({ provision, dataDir: s.dataDir }), false);
});

test("resumes after a quit between committing the restore and restarting", async t => {
  const s = sandbox(t), w = world();
  w.crashAfterRestore = true;
  await assert.rejects(run(s, w), /app quit/);
  assert.equal(JSON.parse(readFileSync(join(s.dataDir, STATE_FILE), "utf8")).stage, "restore-requested");
  // Next launch: the server boot applies the pending restore by itself.
  await w.restartServer();
  w.calls.length = 0;
  const receipt = await run(s, w);
  assert.equal(receipt.done, true);
  assert.equal(receipt.restoreId, "staged-1");
  assert.equal(w.calls.includes("remote/archive"), false, "the archive is not fetched twice");
  assert.equal(w.calls.includes("/api/enterprise-provision/status"), false, "the restored workspace is not mistaken for user data");
});

test("resumes after the setup step failed, without restoring again", async t => {
  const s = sandbox(t), w = world();
  w.failSetupOnce = true;
  await assert.rejects(run(s, w), { code: "setup_unavailable" });
  assert.equal(existsSync(join(s.dataDir, RECEIPT_FILE)), false);
  w.calls.length = 0;
  const receipt = await run(s, w);
  assert.equal(receipt.done, true);
  assert.deepEqual(w.calls.filter(call => call.startsWith("remote")), ["remote/setup", "remote/done"]);
  assert.equal(w.restarts, 1);
  assert.equal(w.applied, 1);
});

test("an owed /done is retried later and a 410 counts as already done", async t => {
  const s = sandbox(t), w = world();
  w.failDoneOnce = true;
  const receipt = await run(s, w);
  assert.equal(receipt.done, false);
  assert.equal(provisioningDue({ provision, dataDir: s.dataDir }), false, "the workspace is provisioned; only the confirmation is owed");
  assert.equal((await confirmDone({ provision, dataDir: s.dataDir, fetchImpl: w.fetchImpl })).done, true);
  // A second device-side retry after the token burned is harmless.
  writeFileSync(join(s.dataDir, RECEIPT_FILE), JSON.stringify({ ...receipt, done: false }));
  assert.equal((await confirmDone({ provision, dataDir: s.dataDir, fetchImpl: w.fetchImpl })).done, true);
});

test("the bundled provision file is validated", async t => {
  const s = sandbox(t);
  assert.equal(readProvisionFile(s.root), null);
  mkdirSync(join(s.root, "enterprise"));
  writeFileSync(join(s.root, "enterprise", "provision.json"), JSON.stringify(provision));
  assert.deepEqual(readProvisionFile(s.root), provision);
  for (const bad of [{ url: "http://bos.example/v1/abc" }, { url: "https://u:p@bos.example/x" }, { slug: "Acme!" }, { token: "" }, { version: 2 }]) {
    assert.throws(() => validateProvision({ ...provision, ...bad }), { code: "invalid_provision" });
  }
  assert.equal(validateProvision({ ...provision, url: "http://127.0.0.1:9/v1/x" }, { allowLoopbackForTests: true }).url, "http://127.0.0.1:9/v1/x");
});
