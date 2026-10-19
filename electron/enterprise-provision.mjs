// Enterprise first-launch provisioning, desktop half.
//
// A per-client build (bin/enterprise-client-build.sh) carries
// <resources>/enterprise/provision.json. On a launch where that file exists,
// the data folder holds no receipt, and the workspace is still fresh, the
// desktop:
//   1. streams the client's archive to a private temp file (size-capped,
//      sha256 checked against x-bos-sha256),
//   2. stages, previews and commits it through the ordinary local
//      workspace-backup routes with the bundled password,
//   3. restarts the server so the pending restore applies at boot,
//   4. fetches /setup and applies it through /api/enterprise-provision/apply,
//   5. writes the receipt (no secrets) and POSTs /done, which burns the token.
// Every step is resumable: progress lives in enterprise-provision-state.json,
// which the restore itself preserves, so a crash or quit mid-way resumes at
// the step that did not finish. Any failure leaves the workspace as it was
// (the restore is atomic, and a fresh workspace is the only one replaced) and
// is retried on the next launch.
//
// Pure and injected: no electron import, so tests drive it under plain node.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const RECEIPT_FILE = "enterprise-provision.json";
export const STATE_FILE = "enterprise-provision-state.json";
export const MAX_ARCHIVE_BYTES = 10 * 1024 ** 3;
const MAX_JSON_BYTES = 1024 * 1024;
const MAGIC = Buffer.from("OMB-WORKSPACE-1\n");
const BACKUP = "/api/workspace-backup";
const PROVISION = "/api/enterprise-provision";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class EnterpriseProvisionError extends Error {
  constructor(code, message) { super(message); this.name = "EnterpriseProvisionError"; this.code = code; }
}
const fail = (code, message) => { throw new EnterpriseProvisionError(code, message); };

export const setupMessages = {
  running: label => `Setting up ${label}…`,
  failed: "Setup couldn't finish — it will retry next time you open BOS",
};

/** Read and validate the bundled provision file, or null when this build has
 * none. A present but malformed file is an error, never silently skipped. */
export function readProvisionFile(resourcesPath, { allowLoopbackForTests = false } = {}) {
  const file = join(resourcesPath, "enterprise", "provision.json");
  if (!existsSync(file)) return null;
  let value;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { fail("invalid_provision", "The bundled provision file is not valid JSON."); }
  return validateProvision(value, { allowLoopbackForTests });
}

export function validateProvision(value, { allowLoopbackForTests = false } = {}) {
  if (!value || typeof value !== "object" || value.version !== 1) fail("invalid_provision", "The bundled provision file has an unsupported version.");
  for (const key of ["slug", "label", "url", "token", "password"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) fail("invalid_provision", `The bundled provision file is missing ${key}.`);
  }
  if (!SLUG.test(value.slug)) fail("invalid_provision", "The bundled provision slug is invalid.");
  let url;
  try { url = new URL(value.url); } catch { fail("invalid_provision", "The bundled provision URL is invalid."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (allowLoopbackForTests && loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    fail("invalid_provision", "The bundled provision URL must be a plain https address.");
  }
  return { version: 1, slug: value.slug, label: value.label.trim().slice(0, 80), url: value.url.replace(/\/+$/, ""), token: value.token, password: value.password };
}

export function readReceipt(dataDir) {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, RECEIPT_FILE), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

/** Provisioning is due when the build carries a provision file and this data
 * folder has never finished one. Freshness is checked later, against the
 * running server, because only it can see the workspace. */
export function provisioningDue({ provision, dataDir }) {
  return Boolean(provision) && !existsSync(join(dataDir, RECEIPT_FILE));
}

function readState(dataDir, slug) {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8"));
    return value && typeof value === "object" && value.slug === slug ? value : { slug };
  } catch { return { slug }; }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

async function discard(response) { try { await response.body?.cancel(); } catch { /* already closed */ } }

async function readJson(response, what) {
  if (!response.body) fail("invalid_response", `${what} returned an empty response.`);
  const chunks = []; let bytes = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) fail("invalid_response", `${what} returned too much data.`);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("invalid_response", `${what} returned invalid JSON.`); }
}

/** Stream one archive response to `file`, refusing anything over the cap, not
 * an .ombbackup, or not matching the server's own sha256. Returns the hash. */
export async function downloadArchive(response, file, { maxBytes = MAX_ARCHIVE_BYTES, signal } = {}) {
  if (response.status !== 200 || !response.body) { await discard(response); fail("archive_unavailable", `The archive request failed (HTTP ${response.status}).`); }
  const expected = (response.headers.get("x-bos-sha256") ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) { await discard(response); fail("invalid_archive", "The archive response carried no valid checksum."); }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { await discard(response); fail("archive_too_large", "The archive is larger than this computer accepts."); }
  const hash = createHash("sha256"), prefix = Buffer.alloc(MAGIC.length);
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), async function* (source) {
      for await (const chunk of source) {
        if (bytes + chunk.length > maxBytes) fail("archive_too_large", "The archive is larger than this computer accepts.");
        if (bytes < MAGIC.length) chunk.copy(prefix, bytes, 0, Math.min(chunk.length, MAGIC.length - bytes));
        bytes += chunk.length; hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(file, { flags: "wx", mode: 0o600 }), ...(signal ? [{ signal }] : []));
  } catch (error) { rmSync(file, { force: true }); throw error; }
  if (declared !== null && bytes !== Number(declared)) { rmSync(file, { force: true }); fail("invalid_archive", "The archive download was incomplete."); }
  if (!prefix.equals(MAGIC)) { rmSync(file, { force: true }); fail("invalid_archive", "The download is not a workspace archive."); }
  const actual = hash.digest("hex");
  if (actual !== expected) { rmSync(file, { force: true }); fail("checksum_mismatch", "The archive checksum did not match. Nothing was restored."); }
  return { sha256: actual, bytes };
}

/**
 * Run (or resume) provisioning. Resolves with the receipt; a receipt with
 * `skipped: "not-fresh"` means the workspace already held real data.
 *
 * - localRequest(route, init): authenticated fetch to the running local server.
 * - restartServer(): stop the server and resolve once a replacement is ready.
 * - fetchImpl: network fetch for the client endpoints (tests inject a fixture).
 */
export async function runEnterpriseProvisioning({
  provision, dataDir, localRequest, restartServer, fetchImpl = fetch, tempRoot,
  appVersion = null, log = () => {}, now = () => new Date(), maxBytes = MAX_ARCHIVE_BYTES,
  archiveTimeoutMs = 30 * 60_000,
}) {
  if (!provision || !isAbsolute(dataDir) || typeof localRequest !== "function" || typeof restartServer !== "function") {
    throw new Error("Enterprise provisioning needs a provision file, a data folder and a local server.");
  }
  const remote = (path, init = {}) => fetchImpl(`${provision.url}${path}`, {
    ...init, redirect: "error", credentials: "omit",
    headers: { ...init.headers, authorization: `Bearer ${provision.token}` },
  });
  const local = async (route, init = {}, what = "The local workspace") => {
    const response = await localRequest(route, init);
    if (!response.ok) {
      let detail = "";
      try { detail = String((await readJson(response, what))?.error ?? ""); } catch { /* keep the status */ }
      fail("local_failed", `${what} refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`);
    }
    return readJson(response, what);
  };
  const post = (route, body, what) => local(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, what);
  const saveState = patch => { state = { ...state, ...patch, slug: provision.slug, updatedAt: now().toISOString() }; writeJsonAtomic(join(dataDir, STATE_FILE), state); };
  let state = readState(dataDir, provision.slug);

  // A restore committed by an earlier run that never restarted applies now.
  let status = await local(`${BACKUP}/status`, {}, "Backup status");
  if (status.pendingRestore) {
    log("enterprise: applying a pending restore");
    await restartServer();
    status = await local(`${BACKUP}/status`, {}, "Backup status");
  }
  const restored = state.restoreId
    ? status.lastRestoreId === state.restoreId
    : state.stage === "restore-requested" && Boolean(status.lastRestoreId) && status.lastRestoreId !== (state.previousRestoreId ?? null);
  if (restored && state.stage !== "restored" && state.stage !== "setup-applied") saveState({ stage: "restored", restoreId: status.lastRestoreId });

  if (!restored) {
    const workspace = await local(`${PROVISION}/status`, {}, "Workspace status");
    if (workspace.fresh !== true) {
      // Someone's real workspace: never replaced. Record the decision so later
      // launches open straight into it; the token stays unburned.
      log("enterprise: workspace already holds data; provisioning skipped");
      const skipped = { version: 1, slug: provision.slug, label: provision.label, skipped: "not-fresh", decidedAt: now().toISOString(), appVersion, done: true };
      writeJsonAtomic(join(dataDir, RECEIPT_FILE), skipped);
      rmSync(join(dataDir, STATE_FILE), { force: true });
      return skipped;
    }
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(tempRoot, "enterprise-"));
    try {
      log("enterprise: downloading archive");
      const response = await remote("/archive", { signal: AbortSignal.timeout(archiveTimeoutMs) });
      if (response.status === 401 || response.status === 403 || response.status === 410) {
        await discard(response);
        fail("token_rejected", `The provisioning link was refused (HTTP ${response.status}).`);
      }
      const file = join(directory, "workspace.ombbackup");
      const archive = await downloadArchive(response, file, { maxBytes });
      saveState({ stage: "downloaded", archiveSha256: archive.sha256 });
      const stream = createReadStream(file, { highWaterMark: 256 * 1024 });
      let uploaded;
      try {
        uploaded = await localRequest(`${BACKUP}/upload`, {
          method: "POST", body: stream, duplex: "half",
          headers: { "content-type": "application/octet-stream", "content-length": String(statSync(file).size) },
        });
      } finally { stream.destroy(); }
      if (!uploaded.ok) { await discard(uploaded); fail("local_failed", `The archive could not be staged (HTTP ${uploaded.status}).`); }
      const receipt = await readJson(uploaded, "The archive upload");
      const preview = await post(`${BACKUP}/preview`, { id: receipt.id, password: provision.password }, "The archive preview");
      if (typeof preview.id !== "string") fail("invalid_response", "The archive preview returned no restore id.");
      saveState({ stage: "restore-requested", previousRestoreId: status.lastRestoreId ?? null, restoreId: undefined });
      const committed = await post(`${BACKUP}/restore`, { id: preview.id, confirmation: "REPLACE" }, "The restore");
      saveState({ stage: "restore-committed", restoreId: committed.restoreId ?? preview.id });
    } finally { rmSync(directory, { recursive: true, force: true }); }
    log("enterprise: restarting to apply the restore");
    await restartServer();
    const after = await local(`${BACKUP}/status`, {}, "Backup status");
    if (after.pendingRestore || after.lastRestoreId !== state.restoreId) fail("restore_failed", "The restored workspace did not come up; the previous workspace was kept.");
    saveState({ stage: "restored" });
  }

  let applied = state.applied;
  if (state.stage !== "setup-applied") {
    log("enterprise: applying setup");
    const response = await remote("/setup", { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) { await discard(response); fail(response.status === 410 ? "token_rejected" : "setup_unavailable", `The setup request failed (HTTP ${response.status}).`); }
    const setup = await readJson(response, "The setup document");
    applied = (await post(`${PROVISION}/apply`, { setup }, "Applying setup")).applied;
    saveState({ stage: "setup-applied", applied });
  }

  const receipt = {
    version: 1,
    slug: provision.slug,
    label: provision.label,
    provisionedAt: now().toISOString(),
    restoreId: state.restoreId ?? null,
    archiveSha256: state.archiveSha256 ?? null,
    appVersion,
    applied: applied ?? null,
    done: false,
  };
  writeJsonAtomic(join(dataDir, RECEIPT_FILE), receipt);
  rmSync(join(dataDir, STATE_FILE), { force: true });
  return confirmDone({ provision, dataDir, fetchImpl, log });
}

/** POST /done once; a 410 means an earlier attempt already burned the token.
 * Failure is not fatal — the receipt stays `done: false` and the next launch
 * tries again. Never sends the password, and the token only as the bearer. */
export async function confirmDone({ provision, dataDir, fetchImpl = fetch, log = () => {} }) {
  const receipt = readReceipt(dataDir);
  if (!receipt || receipt.done === true || receipt.slug !== provision.slug) return receipt;
  const { done: _done, doneAt: _doneAt, ...body } = receipt;
  try {
    const response = await fetchImpl(`${provision.url}/done`, {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${provision.token}` },
      body: JSON.stringify({ receipt: body }),
    });
    await discard(response);
    if (!response.ok && response.status !== 410) { log(`enterprise: /done answered HTTP ${response.status}; will retry next launch`); return receipt; }
  } catch (error) {
    log(`enterprise: /done failed (${error?.message ?? error}); will retry next launch`);
    return receipt;
  }
  const done = { ...receipt, done: true, doneAt: new Date().toISOString() };
  writeJsonAtomic(join(dataDir, RECEIPT_FILE), done);
  return done;
}

/** The plain full-window page shown while provisioning runs or after it
 * failed. No buttons: the user's only action is to reopen BOS. */
export function setupPage(text) {
  const escaped = String(text).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  return "data:text/html;charset=utf-8," + encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:380px"><h2 style="font-weight:600;margin:0">${escaped}</h2></div></body>`,
  );
}
