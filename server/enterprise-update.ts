// Enterprise updates for a headless BOS server (no Electron, no git checkout):
// the client's machine pulls a signed server+ui bundle from our feed, and the
// supervising launcher (standalone/launch.mjs) swaps it in after this process
// exits, health-checks it and rolls back on its own. We trigger it on demand
// through POST /api/update/apply; the client's update button does the same.
//
// Feed layout (<feed>/ is OMB_ENTERPRISE_FEED, e.g. https://bos.aihlete.com/updates/enterprise):
//   manifest.json  {schema:1, channel, version, commit, publishedAt, bundle:{file, sha256, size}}
//   manifest.sig   base64 ed25519 signature over the exact manifest.json bytes
//   <bundle.file>  tgz of server/ ui/ skills/ build-commit.json
// Only a manifest signed by FEED_PUBLIC_KEY is believed. The private key never
// leaves our side (scripts/enterprise-publish.mjs signs).
import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeFileAtomic } from "./atomic.ts";
import type { BuildRef, ExecutorCandidate, ExecutorPlan, UpdateBuilder, UpdateCheck, UpdateExecutor, UpdateMode } from "./updater.ts";

/** spki der, base64. Private half: bos workspace secrets/enterprise-feed-ed25519.pem. */
export const FEED_PUBLIC_KEY = "MCowBQYDK2VwAyEAKlFogYmSfCiW2yWEnvV3jUZsqIFz5RnS2EZMFxD+BTg=";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;

export interface FeedManifest {
  schema: 1; channel: string; version: string; commit: string; publishedAt: string;
  bundle: { file: string; sha256: string; size: number };
}
/** What the swap job needs, written next to the staged tree. */
export interface StagedManifest extends ExecutorCandidate { publishedAt: string; channel: string }
/** Written by the launcher once a swap is live; the replay floor for the next check. */
interface FeedState { publishedAt?: string; commit?: string }

const err = (message: string, status: number) => Object.assign(new Error(message), { status });

export function feedKey(spkiBase64 = FEED_PUBLIC_KEY): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
}

/** Parse and verify. Throws on anything but a well-formed manifest our key signed. */
export function verifyManifest(body: Buffer, signature: string, key: KeyObject = feedKey()): FeedManifest {
  if (body.length > MAX_MANIFEST_BYTES) throw err("manifest too large", 502);
  const sig = Buffer.from(signature.trim(), "base64");
  if (sig.length !== 64 || !verifySignature(null, body, key, sig)) throw err("manifest signature does not verify", 502);
  const m = JSON.parse(body.toString("utf8")) as Partial<FeedManifest>;
  const b = m.bundle;
  if (m.schema !== 1 || typeof m.channel !== "string" || typeof m.version !== "string" || !/^[0-9a-f]{40}$/.test(m.commit ?? "")
    || typeof m.publishedAt !== "string" || Number.isNaN(Date.parse(m.publishedAt))
    || !b || typeof b.file !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/.test(b.file) || !/^[0-9a-f]{64}$/.test(b.sha256 ?? "")
    || typeof b.size !== "number" || b.size <= 0 || b.size > MAX_BUNDLE_BYTES) throw err("manifest is malformed", 502);
  return m as FeedManifest;
}

/** -1, 0, 1 on the numeric x.y.z core; a prerelease (2.1.0-beta) sorts
 * below its release, and build metadata (+abc) is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split(/[-+]/)[0] ?? "").split(".").map(n => Number.parseInt(n, 10) || 0);
  const pre = (v: string) => /^[^+]*-/.test(v);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return pre(a) === pre(b) ? 0 : pre(a) ? -1 : 1;
}

export interface EnterpriseUpdaterOptions {
  feed: string;
  /** The only channel this install takes (default "enterprise"); a signed manifest for another is refused. */
  channel?: string;
  /** The standalone install dir: resources/ and config.json live here; updates/ is ours. */
  standaloneDir: string;
  current: () => BuildRef;
  key?: KeyObject;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Extract a tgz into a directory. Default: the system tar (bsdtar ships with Windows 10+). */
  extract?: (archive: string, into: string) => Promise<void>;
}

export const enterpriseDirs = (standaloneDir: string) => {
  const updates = join(standaloneDir, "updates");
  return { updates, staged: join(updates, "staged"), request: join(updates, "request.json"), feedState: join(updates, "feed-state.json") };
};

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

/** Right after tar writes thousands of files, Defender or the indexer is
 * scanning them and Windows refuses the rename for a moment. */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

function systemTar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Git/MSYS GNU tar earlier on PATH reads C:\\... as a remote host; use the bsdtar Windows ships.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const child = spawn(tar, ["-xzf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 400)}`)));
  });
}

export function createEnterpriseBuilder(options: EnterpriseUpdaterOptions): UpdateBuilder {
  const http = options.fetch ?? fetch;
  const key = options.key ?? feedKey();
  const now = options.now ?? (() => new Date());
  const feed = options.feed.replace(/\/+$/, "");
  const dirs = enterpriseDirs(options.standaloneDir);

  async function get(path: string, limit: number): Promise<Buffer> {
    const response = await http(`${feed}/${path}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) throw err(`feed ${path}: http ${response.status}`, 502);
    if (Number(response.headers.get("content-length") ?? 0) > limit) throw err(`feed ${path} too large`, 502);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > limit) throw err(`feed ${path} too large`, 502);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async function manifest(): Promise<FeedManifest> {
    const [body, sig] = await Promise.all([get("manifest.json", MAX_MANIFEST_BYTES), get("manifest.sig", 1024)]);
    return verifyManifest(body, sig.toString("utf8"), key);
  }
  /** Why `m` must not be installed over the running build, or null. */
  function refusal(m: FeedManifest, current: BuildRef): string | null {
    const channel = options.channel ?? "enterprise";
    if (m.channel !== channel) return `feed manifest is for the ${m.channel} channel, this install takes ${channel}`;
    if (compareVersions(m.version, current.version) < 0) return `feed offers ${m.version}, older than the running ${current.version}`;
    // A signed manifest stays valid forever, so an old one replayed by a
    // tampered mirror must not walk the client back: publishedAt only moves forward.
    const floor = readJson<FeedState>(dirs.feedState)?.publishedAt;
    if (floor && Date.parse(m.publishedAt) < Date.parse(floor)) return `feed manifest from ${m.publishedAt} is older than the installed one (${floor})`;
    return null;
  }

  return {
    async check(): Promise<UpdateCheck> {
      const current = options.current();
      const at = now().toISOString();
      const m = await manifest();
      const wrongChannel = m.channel !== (options.channel ?? "enterprise");
      if (m.commit === current.sha && !wrongChannel) return { at, current, upToDate: true, reason: `up to date with the ${m.channel} channel` };
      const refused = refusal(m, current);
      if (refused) return { at, current, reason: refused };
      return { at, current, candidate: { version: m.version, sha: m.commit, branch: m.channel, subject: `published ${m.publishedAt}` } };
    },
    async build(target, log) {
      const m = await manifest();
      if (m.commit !== target.sha) throw err(`the feed moved to ${m.commit.slice(0, 8)} since the check found ${target.sha.slice(0, 8)}; check again`, 409);
      const refused = refusal(m, options.current());
      if (refused) throw err(refused, 409);
      mkdirSync(dirs.updates, { recursive: true });
      const work = join(dirs.updates, `incoming-${m.commit.slice(0, 8)}`);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(join(work, "tree"), { recursive: true });
      try {
      const archive = join(work, m.bundle.file);
      log(`downloading ${m.bundle.file} (${Math.round(m.bundle.size / 1e6)} MB)`);
      const response = await http(`${feed}/${m.bundle.file}`, { cache: "no-store", signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw err(`feed ${m.bundle.file}: http ${response.status}`, 502);
      const hash = createHash("sha256");
      let size = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length; hash.update(chunk);
          done(size > m.bundle.size ? err("bundle is larger than the manifest says", 502) : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), meter, createWriteStream(archive));
      const digest = hash.digest("hex");
      if (size !== m.bundle.size || digest !== m.bundle.sha256) throw err(`bundle does not match the signed manifest (sha256 ${digest.slice(0, 12)}, ${size} bytes)`, 502);
      log("bundle verified against the signed manifest; extracting");
      await (options.extract ?? systemTar)(archive, join(work, "tree"));
      for (const required of [join("server", "index.js"), join("ui", "index.html"), "build-commit.json"]) {
        if (!existsSync(join(work, "tree", required))) throw err(`bundle is missing ${required}`, 502);
      }
      const stamp = readJson<{ commit?: string }>(join(work, "tree", "build-commit.json"));
      if (stamp?.commit !== m.commit) throw err(`bundle build-commit.json says ${String(stamp?.commit).slice(0, 8)}, manifest says ${m.commit.slice(0, 8)}`, 502);
      const staged: StagedManifest = { version: m.version, sha: m.commit, stagedAt: now().toISOString(), publishedAt: m.publishedAt, channel: m.channel };
      writeFileAtomic(join(work, "tree", "staged.json"), JSON.stringify(staged, null, 2));
      rmSync(dirs.staged, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      await renameRetry(join(work, "tree"), dirs.staged);
      log(`staged ${m.version} (${m.commit.slice(0, 8)})`);
      } finally {
        // an extracted tree is ~1 GB; never leave a failed one behind
        rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
}

export interface StandaloneExecutorOptions {
  standaloneDir: string;
  port: number;
  /** True only when standalone/launch.mjs is our parent and will act on request.json after we exit. */
  supervised: boolean;
  /** Exit this process cleanly (the server's graceful shutdown). */
  quit: () => void;
  log?: (line: string) => void;
}

export function readStaged(standaloneDir: string): StagedManifest | null {
  const { staged } = enterpriseDirs(standaloneDir);
  const m = readJson<StagedManifest>(join(staged, "staged.json"));
  if (!m || typeof m.version !== "string" || typeof m.sha !== "string" || typeof m.stagedAt !== "string") return null;
  return existsSync(join(staged, "server", "index.js")) ? m : null;
}

/** The handoff is a file: request.json names the plan, then this process
 * exits. The launcher sees the request when we are gone, swaps (or just
 * restarts), health-checks, rolls back on failure and writes result.json. */
export function createStandaloneExecutor(options: StandaloneExecutorOptions): UpdateExecutor {
  const dirs = enterpriseDirs(options.standaloneDir);
  return {
    candidate: async () => {
      const m = readStaged(options.standaloneDir);
      return m ? { version: m.version, sha: m.sha, stagedAt: m.stagedAt } : null;
    },
    admit: async (mode: UpdateMode) => {
      if (!options.supervised) throw err("this server was not started by the BOS launcher, so it cannot restart itself", 409);
      if (mode === "update" && !readStaged(options.standaloneDir)) throw err("no staged update to apply", 409);
      return [];
    },
    ports: async () => [options.port],
    execute: async (plan: ExecutorPlan, dir: string) => {
      mkdirSync(dirs.updates, { recursive: true });
      writeFileAtomic(dirs.request, JSON.stringify({ plan: join(dir, "plan.json"), updateId: plan.updateId, mode: plan.mode, at: new Date().toISOString() }, null, 2));
      options.log?.(`update ${plan.updateId}: handing ${plan.mode} to the launcher`);
      // Let the 202 for /api/update/apply leave before the listener closes.
      setTimeout(options.quit, 750).unref?.();
    },
  };
}
