// A Codex CLI the app installs and keeps current by itself, for machines
// with no Node.js/npm (a client mac set up by provisioning). The official
// standalone binary comes from the openai/codex GitHub releases, is checked
// against the SHA-256 digest GitHub publishes for that asset, must answer
// `codex --version` before it is used, and is switched in by replacing one
// `current` symlink. The previous version stays until a newer one passes.
//
// Opt-in: it runs when `features.managedCodex` is true, or when this machine
// has no other codex executable at all. An owner's own npm Codex is never
// shadowed unless they asked for it.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { createGunzip } from "node:zlib";

const LATEST_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const DOWNLOAD_PREFIX = "https://github.com/openai/codex/releases/download/";
// github.com answers with a redirect to its release CDN.
const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);
export const CODEX_UPDATE_INTERVAL_MS = 6 * 60 * 60_000;
const IDLE_RETRY_MS = 60_000;
const BOOT_DELAY_MS = 20_000;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_BINARY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TAR_META_BYTES = 1024 * 1024;
/** Shown on the install button before the first release lookup. */
const ESTIMATED_DOWNLOAD_BYTES = 110 * 1024 * 1024;
const RECORD = ".install-complete.json";
/** Since 0.163 Codex runs tool calls through a separate code-mode host that
 * ships as its own release asset; without it every tool call fails with
 * "failed to spawn code-mode host ... No such file or directory". */
export const CODEX_HOST_BINARY = "codex-code-mode-host";
const VERSION = /^\d+\.\d+\.\d+$/;

export interface CodexAsset { name: string; url: string; bytes: number; sha256: string }

export interface CodexRelease {
  version: string;
  asset: CodexAsset;
  /** The code-mode host, when this release publishes one. */
  host?: CodexAsset;
}

export interface ManagedCodexInstall {
  version: string;
  dir: string;
  binary: string;
}

/** Rust target triple of the official standalone binary, or null when the
 * project publishes none this module installs (Windows ships zips/.exe). */
export function codexTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "linux") return `${cpu}-unknown-linux-musl`;
  return null;
}

export function codexAssetName(target: string): string {
  return `codex-${target}.tar.gz`;
}

export function codexHostAssetName(target: string): string {
  return `${CODEX_HOST_BINARY}-${target}.tar.gz`;
}

/** GitHub's `digest` field ("sha256:<hex>") as lowercase hex, else null. */
export function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** `rust-v0.163.0`, `v0.163.0`, `0.163.0` or `codex-cli 0.163.0` → `0.163.0`. */
export function parseCodexVersion(text: string): string | null {
  const match = /(?:^|rust-v|codex-cli\s+v?|^v)(\d+\.\d+\.\d+)(?=\s|$)/i.exec(text.trim());
  return match ? match[1]! : null;
}

/** Numeric x.y.z order; anything unparseable sorts first so it never wins. */
export function compareCodexVersions(a: string, b: string): number {
  const parse = (value: string) => (VERSION.test(value) ? value.split(".").map(Number) : null);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

/** Pick this machine's asset out of a GitHub `releases/latest` answer. A
 * release without a published digest is refused rather than trusted. */
export function parseLatestRelease(body: unknown, target: string): CodexRelease {
  if (!body || typeof body !== "object") throw new Error("GitHub returned an unreadable Codex release.");
  const release = body as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (release.draft === true || release.prerelease === true) throw new Error("The latest Codex release is a pre-release.");
  const version = typeof release.tag_name === "string" ? parseCodexVersion(release.tag_name) : null;
  if (!version) throw new Error(`Unrecognised Codex release tag ${JSON.stringify(release.tag_name)}.`);
  const assets = Array.isArray(release.assets) ? (release.assets as Array<Record<string, unknown>>) : [];
  const pick = (name: string): CodexAsset | undefined => {
    const asset = assets.find((candidate) => candidate?.name === name);
    if (!asset) return undefined;
    const sha256 = parseSha256Digest(asset.digest);
    if (!sha256) throw new Error(`Codex ${version} publishes no SHA-256 digest for ${name}; refusing to install it.`);
    const url = asset.browser_download_url;
    if (typeof url !== "string" || !url.startsWith(DOWNLOAD_PREFIX)) throw new Error(`Codex ${version} has an unexpected download address.`);
    const bytes = asset.size;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARCHIVE_BYTES) {
      throw new Error(`Codex ${version} reports an implausible download size.`);
    }
    return { name, url, bytes, sha256 };
  };
  const name = codexAssetName(target);
  const asset = pick(name);
  if (!asset) throw new Error(`Codex ${version} has no ${name} download.`);
  const host = pick(codexHostAssetName(target));
  return host ? { version, asset, host } : { version, asset };
}

export async function fetchLatestCodexRelease(target: string, fetchImpl: typeof fetch = fetch): Promise<CodexRelease> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "BOS-Bot", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
  return parseLatestRelease(await response.json(), target);
}

export function managedCodexRoot(baseDir: string): string {
  return join(baseDir, "tools", "codex");
}

/** The directory on the engines' PATH: a symlink to the active version. */
export function managedCodexBinDir(baseDir: string): string {
  return join(managedCodexRoot(baseDir), "current");
}

/** Every codex on PATH that is not this app's managed copy. */
export function otherCodexCandidates(candidates: readonly string[], baseDir: string): string[] {
  const root = managedCodexRoot(baseDir) + sep;
  return candidates.filter((path) => !path.startsWith(root));
}

/** The activation rule: asked for explicitly, or there is no other codex. */
export function managedCodexWanted(input: { flag: unknown; otherCodexOnPath: boolean; supported: boolean }): boolean {
  return input.supported && (input.flag === true || !input.otherCodexOnPath);
}

interface InstallRecord { version: string; sha256: string; bytes: number; host?: { sha256: string; bytes: number } }

/** A version directory holding a complete install of `binaryName`, else null.
 * Shared with server/claude-managed.ts, which keeps the same layout. */
export function completedInstallSync(dir: string, version?: string, binaryName = "codex"): ManagedCodexInstall | null {
  try {
    const record = JSON.parse(readFileSync(join(dir, RECORD), "utf8")) as InstallRecord;
    if (!VERSION.test(record.version) || (version !== undefined && record.version !== version)) return null;
    const binary = join(dir, binaryName);
    const info = statSync(binary);
    if (!info.isFile() || info.size !== record.bytes || (info.mode & 0o111) === 0) return null;
    return { version: record.version, dir, binary };
  } catch {
    return null;
  }
}

/** True when the install in `dir` has the code-mode host its record names. */
export function hasCodexHostSync(dir: string): boolean {
  try {
    const record = JSON.parse(readFileSync(join(dir, RECORD), "utf8")) as InstallRecord;
    const info = statSync(join(dir, CODEX_HOST_BINARY));
    return Boolean(record.host) && info.isFile() && info.size === record.host!.bytes && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The version `current` points at, when it is a complete install. */
export function currentManagedCodex(baseDir: string): ManagedCodexInstall | null {
  const root = managedCodexRoot(baseDir);
  try {
    const target = readlinkSync(join(root, "current"));
    if (!VERSION.test(target)) return null;
    return completedInstallSync(join(root, target), target);
  } catch {
    return null;
  }
}

/** Run `<binary> --version` and require it to report `version`. */
export function validateCodexBinary(binary: string, version: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/", NO_COLOR: "1" } }, (error, stdout) => {
      const output = String(stdout ?? "").trim();
      if (error) return rejectRun(new Error(`The downloaded Codex ${version} did not run (${error.message.split("\n")[0]}).`));
      if (parseCodexVersion(output) !== version) return rejectRun(new Error(`The downloaded Codex reported ${JSON.stringify(output.slice(0, 80))}, expected ${version}.`));
      resolveRun(output);
    });
  });
}

async function downloadVerified(asset: CodexAsset, archivePath: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(asset.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`The Codex download failed (${response.status}).`);
  const finalUrl = new URL(response.url || asset.url);
  if (finalUrl.protocol !== "https:" || !DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
    throw new Error("The Codex download redirected outside GitHub.");
  }
  const handle = await open(archivePath, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > asset.bytes) throw new Error("The Codex download is larger than GitHub reported; refusing it.");
      await handle.write(chunk);
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  if (bytes !== asset.bytes) throw new Error("The Codex download was truncated.");
  const actual = hash.digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(`The Codex download failed its SHA-256 check (expected ${asset.sha256}, got ${actual}). Nothing was installed.`);
  }
}

function tarString(block: Buffer, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}

function tarNumber(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  if (field[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i]!;
    return value;
  }
  const text = field.toString("latin1").replace(/[\0 ]+$/u, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function tarChecksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === tarNumber(block, 148, 8);
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(cursor, space).toString("latin1"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > data.length) throw new Error("The Codex archive has a malformed header.");
    const record = data.subarray(space + 1, cursor + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    cursor += length;
  }
  return records;
}

/** Stream a gzipped tar and write out its one expected executable. Only that
 * regular file (plus metadata/directory entries) is accepted; links, other
 * files or a second copy reject the whole archive. */
export async function extractCodexBinary(archivePath: string, memberName: string, outputPath: string): Promise<number> {
  type TarState = "header" | "body" | "pad" | "done";
  let buffer: Buffer = Buffer.alloc(0);
  let state = "header" as TarState;
  let remaining = 0;
  let padding = 0;
  let body: "file" | "pax" | "longname" | "skip" = "skip";
  let meta: Buffer[] = [];
  let nextPath: string | null = null;
  let nextSize: number | null = null;
  let out: FileHandle | null = null;
  let fileBytes = 0;
  let written = 0;
  let found = false;
  try {
    for await (const chunk of createReadStream(archivePath).pipe(createGunzip())) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);
      while ((state as TarState) !== "done") {
        if (state === "header") {
          if (buffer.length < 512) break;
          const block = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          if (block.every((byte) => byte === 0)) { state = "done"; break; }
          if (!tarChecksumOk(block)) throw new Error("The Codex archive has a corrupt header.");
          const type = String.fromCharCode(block[156]!);
          const prefix = block.subarray(257, 262).toString("latin1") === "ustar" ? tarString(block, 345, 155) : "";
          const headerName = prefix ? `${prefix}/${tarString(block, 0, 100)}` : tarString(block, 0, 100);
          const name = (nextPath ?? headerName).replace(/^(\.\/)+/u, "");
          const size = nextSize ?? tarNumber(block, 124, 12);
          if (type !== "x" && type !== "L") { nextPath = null; nextSize = null; }
          if (!Number.isSafeInteger(size) || size < 0) throw new Error("The Codex archive has an invalid size.");
          remaining = size;
          padding = (512 - (size % 512)) % 512;
          if (type === "0" || type === "\0" || type === "7") {
            if (name !== memberName || found) throw new Error(`The Codex archive contains an unexpected file (${name.slice(0, 120)}).`);
            if (size > MAX_BINARY_BYTES) throw new Error("The Codex binary is implausibly large.");
            found = true;
            fileBytes = size;
            out = await open(outputPath, "wx", 0o700);
            body = "file";
          } else if (type === "x" || type === "L") {
            if (size > MAX_TAR_META_BYTES) throw new Error("The Codex archive has an oversized header.");
            body = type === "x" ? "pax" : "longname";
            meta = [];
          } else if (type === "g" || type === "5") {
            body = "skip";
          } else {
            throw new Error(`The Codex archive contains an unsupported entry (${name.slice(0, 120)}).`);
          }
          state = "body";
        }
        if (state === "body") {
          const take = Math.min(remaining, buffer.length);
          const slice = buffer.subarray(0, take);
          buffer = buffer.subarray(take);
          remaining -= take;
          if (body === "file" && take > 0) { await out!.write(slice); written += take; }
          else if ((body === "pax" || body === "longname") && take > 0) meta.push(Buffer.from(slice));
          if (remaining > 0) break;
          if (body === "file") { await out!.close(); out = null; }
          if (body === "pax") {
            const records = paxRecords(Buffer.concat(meta));
            if (records.has("path")) nextPath = records.get("path")!;
            if (records.has("size")) nextSize = Number(records.get("size"));
          }
          if (body === "longname") nextPath = tarString(Buffer.concat(meta), 0, Number.MAX_SAFE_INTEGER);
          state = "pad";
        }
        if (state === "pad") {
          const take = Math.min(padding, buffer.length);
          buffer = buffer.subarray(take);
          padding -= take;
          if (padding > 0) break;
          state = "header";
        }
      }
      if (state === "done") break;
    }
  } finally {
    await out?.close();
  }
  if (!found) throw new Error(`The Codex archive does not contain ${memberName}.`);
  if (state !== "done" && state !== "header") throw new Error("The Codex archive is truncated.");
  if (written !== fileBytes) throw new Error("The Codex binary in the archive is truncated.");
  return written;
}

export interface InstallCodexOptions {
  baseDir: string;
  target: string;
  fetchImpl?: typeof fetch;
  validate?: (binary: string, version: string) => Promise<unknown>;
}

const installs = new Map<string, Promise<ManagedCodexInstall>>();

/** Download, verify and validate one release into `<root>/<version>/`.
 * Does not switch `current`. Concurrent calls for one root share a run. */
export function installCodexRelease(release: CodexRelease, options: InstallCodexOptions): Promise<ManagedCodexInstall> {
  const key = `${managedCodexRoot(options.baseDir)} ${release.version}`;
  const existing = installs.get(key);
  if (existing) return existing;
  const run = installOnce(release, options).finally(() => installs.delete(key));
  installs.set(key, run);
  return run;
}

async function installOnce(release: CodexRelease, options: InstallCodexOptions): Promise<ManagedCodexInstall> {
  if (!VERSION.test(release.version)) throw new Error(`Refusing unexpected Codex version ${JSON.stringify(release.version)}.`);
  const validate = options.validate ?? validateCodexBinary;
  const root = managedCodexRoot(options.baseDir);
  const destination = join(root, release.version);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const done = completedInstallSync(destination, release.version);
  if (done && (!release.host || hasCodexHostSync(destination))) {
    await validate(done.binary, release.version);
    return done;
  }
  if (done && release.host) {
    // An install from before the host was split out: add the host beside the
    // working binary in place, so `current` never points at a missing folder.
    await validate(done.binary, release.version);
    await addCodexHost(release, release.host, destination, root, options);
    return done;
  }
  const staging = await mkdtemp(join(root, ".install-"));
  try {
    const archive = join(staging, "download.tar.gz");
    await downloadVerified(release.asset, archive, options.fetchImpl ?? fetch);
    const runtime = join(staging, "runtime");
    await mkdir(runtime, { mode: 0o755 });
    const binary = join(runtime, "codex");
    const bytes = await extractCodexBinary(archive, `codex-${options.target}`, binary);
    await chmod(binary, 0o755);
    await validate(binary, release.version);
    let host: InstallRecord["host"];
    if (release.host) {
      const hostArchive = join(staging, "host.tar.gz");
      await downloadVerified(release.host, hostArchive, options.fetchImpl ?? fetch);
      const hostBinary = join(runtime, CODEX_HOST_BINARY);
      host = { sha256: release.host.sha256, bytes: await extractCodexBinary(hostArchive, `${CODEX_HOST_BINARY}-${options.target}`, hostBinary) };
      await chmod(hostBinary, 0o755);
    }
    const record: InstallRecord = { version: release.version, sha256: release.asset.sha256, bytes, ...(host ? { host } : {}) };
    await writeFile(join(runtime, RECORD), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o644 });
    // A leftover, incomplete folder of the same version must not block the move.
    if (existsSync(destination) && !completedInstallSync(destination, release.version)) await rm(destination, { recursive: true, force: true });
    try {
      await rename(runtime, destination);
    } catch (error) {
      if (!completedInstallSync(destination, release.version)) throw error;
    }
    const installed = completedInstallSync(destination, release.version);
    if (!installed) throw new Error("The installed Codex runtime is incomplete.");
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Download the code-mode host into an existing install: the binary and then
 * the record each move in with one rename. */
async function addCodexHost(release: CodexRelease, asset: CodexAsset, destination: string, root: string, options: InstallCodexOptions): Promise<void> {
  const staging = await mkdtemp(join(root, ".install-"));
  try {
    const archive = join(staging, "host.tar.gz");
    await downloadVerified(asset, archive, options.fetchImpl ?? fetch);
    const hostBinary = join(staging, CODEX_HOST_BINARY);
    const bytes = await extractCodexBinary(archive, `${CODEX_HOST_BINARY}-${options.target}`, hostBinary);
    await chmod(hostBinary, 0o755);
    const record = JSON.parse(await readFile(join(destination, RECORD), "utf8")) as InstallRecord;
    if (record.version !== release.version) throw new Error(`Codex ${release.version} changed while its host was installing.`);
    await writeFile(join(staging, RECORD), `${JSON.stringify({ ...record, host: { sha256: asset.sha256, bytes } })}\n`, { flag: "wx", mode: 0o644 });
    await rename(hostBinary, join(destination, CODEX_HOST_BINARY));
    await rename(join(staging, RECORD), join(destination, RECORD));
    if (!hasCodexHostSync(destination)) throw new Error("The Codex code-mode host did not install.");
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Point `current` at an installed version in one rename, then drop every
 * version except the new one and the one it replaced. */
export function switchManagedCodex(baseDir: string, version: string): Promise<void> {
  return switchManagedRuntime(managedCodexRoot(baseDir), version, "codex", "Codex");
}

/** `switchManagedCodex` for any runtime kept as `<root>/<version>/<binary>`. */
export async function switchManagedRuntime(root: string, version: string, binaryName: string, label: string): Promise<void> {
  if (!completedInstallSync(join(root, version), version, binaryName)) throw new Error(`${label} ${version} is not installed.`);
  const link = join(root, "current");
  let previous: string | null = null;
  try {
    const info = await lstat(link);
    if (!info.isSymbolicLink()) throw new Error(`${link} is not a symlink; leaving it alone.`);
    previous = await readlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(root, `.current-${randomUUID()}`);
  await symlink(version, temporary);
  try {
    await rename(temporary, link);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  // re-pointing at the same version (an in-place repair) keeps the rollback copy
  if (previous === version) return;
  for (const entry of await readdir(root)) {
    if (entry === version || entry === previous) continue;
    if (VERSION.test(entry) || entry.startsWith(".current-")) await rm(join(root, entry), { recursive: true, force: true }).catch(() => {});
  }
}

export interface ManagedCodexStatus {
  /** The managed copy is on the engines' PATH. */
  active: boolean;
  version: string | null;
  latest: string | null;
  /** Installed and verified, waiting for turns of this engine to finish. */
  pending: string | null;
  installing: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** What one app-managed CLI provides to ManagedRuntimeUpdater. */
export interface ManagedRuntimeSource {
  /** Shown in logs and errors: "Codex", "Claude Code". */
  name: string;
  /** False when this platform has no managed build. */
  supported: boolean;
  /** The directory put on the engines' PATH (a `current` symlink). */
  binDir: string;
  current(): { version: string } | null;
  latest(): Promise<{ version: string; bytes: number }>;
  /** Download, verify and validate a release returned by latest(). */
  install(release: { version: string; bytes: number }): Promise<unknown>;
  switchTo(version: string): Promise<void>;
  estimatedBytes: number;
}

export interface ManagedRuntimeUpdaterOptions {
  isActive: () => boolean;
  /** True while any turn of this engine runs: versions never switch under it. */
  isBusy: () => boolean;
  /** Put the managed directory on the engines' PATH. */
  registerBinDir: (dir: string) => void;
  /** Called after `current` moves so cached PATH lookups refresh. */
  onSwitch?: (version: string) => void;
  log?: (message: string) => void;
  intervalMs?: number;
  idleRetryMs?: number;
  bootDelayMs?: number;
}

export interface ManagedCodexUpdaterOptions extends ManagedRuntimeUpdaterOptions {
  baseDir: string;
  /** Rust target; null when this platform has no managed build. */
  target?: string | null;
  fetchImpl?: typeof fetch;
  validate?: (binary: string, version: string) => Promise<unknown>;
}

/** Keeps one app-managed CLI installed and current: a periodic release
 * check, a verified install beside the active version, and a switch that
 * waits until no turn of that engine is running. */
export class ManagedRuntimeUpdater {
  private readonly options: ManagedRuntimeUpdaterOptions;
  protected readonly source: ManagedRuntimeSource;
  private active = false;
  private version: string | null = null;
  private latest: string | null = null;
  private latestBytes: number | null = null;
  private pending: string | null = null;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private running: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(source: ManagedRuntimeSource, options: ManagedRuntimeUpdaterOptions) {
    this.source = source;
    this.options = options;
    this.version = source.supported ? source.current()?.version ?? null : null;
  }

  get supported(): boolean {
    return this.source.supported;
  }

  /** Register the PATH entry now (so the first turn already uses it) and
   * schedule the boot check and the periodic one. */
  start(): void {
    if (!this.source.supported) return;
    if (this.safeIsActive()) this.activate();
    const boot = setTimeout(() => void this.check(), this.options.bootDelayMs ?? BOOT_DELAY_MS);
    const every = setInterval(() => void this.check(), this.options.intervalMs ?? CODEX_UPDATE_INTERVAL_MS);
    boot.unref?.();
    every.unref?.();
    this.timers.push(boot, every);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  status(): ManagedCodexStatus {
    return {
      active: this.active,
      version: this.version,
      latest: this.latest,
      pending: this.pending,
      installing: this.running !== null,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  /** Approximate download size for the install button. */
  downloadBytes(): number {
    return this.latestBytes ?? this.source.estimatedBytes;
  }

  /** One scheduled cycle. Never throws: failures are logged and retried on
   * the next cycle. */
  check(): Promise<void> {
    return this.cycle(false).catch(() => {});
  }

  /** Settings' install button: install even when the activation rule would
   * not, and surface the failure to the caller. */
  installNow(): Promise<void> {
    if (!this.source.supported) return Promise.reject(new Error(`There is no managed ${this.source.name} build for this platform.`));
    return this.cycle(true);
  }

  private safeIsActive(): boolean {
    try {
      return this.options.isActive();
    } catch (error) {
      this.log(`activation check failed: ${message(error)}`);
      return false;
    }
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    this.options.registerBinDir(this.source.binDir);
  }

  private cycle(explicit: boolean): Promise<void> {
    if (this.running) return this.running;
    const run = this.runCycle(explicit).finally(() => { this.running = null; });
    this.running = run;
    return run;
  }

  private async runCycle(explicit: boolean): Promise<void> {
    if (!this.source.supported) return;
    if (!explicit && !this.active && !this.safeIsActive()) return;
    this.activate();
    const name = this.source.name;
    try {
      const release = await this.source.latest();
      this.lastCheckedAt = new Date().toISOString();
      this.latest = release.version;
      this.latestBytes = release.bytes;
      const current = this.source.current();
      this.version = current?.version ?? null;
      if (current && compareCodexVersions(current.version, release.version) >= 0) {
        this.pending = null;
        this.lastError = null;
        return;
      }
      this.log(`installing ${name} ${release.version}${current ? ` (replacing ${current.version})` : ""}`);
      await this.source.install(release);
      this.pending = release.version;
      this.lastError = null;
      await this.trySwitch();
    } catch (error) {
      this.lastError = message(error);
      this.log(`update failed, will retry next cycle: ${this.lastError}`);
      if (explicit) throw error;
    }
  }

  /** Switch to the pending version now, or retry once the engine is idle. */
  async trySwitch(): Promise<boolean> {
    const version = this.pending;
    if (!version) return false;
    const name = this.source.name;
    let busy = true;
    try {
      busy = this.options.isBusy();
    } catch (error) {
      this.log(`busy check failed: ${message(error)}`);
    }
    if (busy) {
      if (!this.idleTimer) {
        this.log(`${name} ${version} is ready; switching once no ${name} turn is running`);
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          void this.trySwitch().catch((error) => {
            this.lastError = message(error);
            this.log(`switch failed: ${this.lastError}`);
          });
        }, this.options.idleRetryMs ?? IDLE_RETRY_MS);
        this.idleTimer.unref?.();
      }
      return false;
    }
    await this.source.switchTo(version);
    this.version = version;
    if (this.pending === version) this.pending = null;
    this.log(`now using ${name} ${version}`);
    this.options.onSwitch?.(version);
    return true;
  }

  private log(text: string): void {
    (this.options.log ?? ((line: string) => console.log(`[managed-${this.source.name.toLowerCase().replace(/\s+/g, "-")}] ${line}`)))(text);
  }
}

export class ManagedCodexUpdater extends ManagedRuntimeUpdater {
  constructor(options: ManagedCodexUpdaterOptions) {
    const target = options.target === undefined ? codexTarget() : options.target;
    const releases = new Map<string, CodexRelease>();
    super({
      name: "Codex",
      supported: target !== null,
      binDir: managedCodexBinDir(options.baseDir),
      current: () => {
        const current = currentManagedCodex(options.baseDir);
        if (current && releases.get(current.version)?.host && !hasCodexHostSync(current.dir)) return null;
        return current;
      },
      latest: async () => {
        const release = await fetchLatestCodexRelease(target!, options.fetchImpl);
        releases.set(release.version, release);
        return { version: release.version, bytes: release.asset.bytes };
      },
      install: (found) => {
        const release = releases.get(found.version);
        if (!release) throw new Error(`Codex ${found.version} was not looked up first.`);
        return installCodexRelease(release, { baseDir: options.baseDir, target: target!, fetchImpl: options.fetchImpl, validate: options.validate });
      },
      switchTo: (version) => switchManagedCodex(options.baseDir, version),
      estimatedBytes: ESTIMATED_DOWNLOAD_BYTES,
    }, options);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the install record of a version directory (tests, diagnostics). */
export async function readInstallRecord(dir: string): Promise<InstallRecord | null> {
  try {
    return JSON.parse(await readFile(join(dir, RECORD), "utf8")) as InstallRecord;
  } catch {
    return null;
  }
}
