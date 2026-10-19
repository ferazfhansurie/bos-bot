// A Claude Code CLI the app installs and keeps current by itself, for
// machines with no Node.js/npm (a client mac set up by provisioning). It is
// Anthropic's own standalone binary — the one claude.ai/install.sh fetches —
// from the release bucket, checked against the size and SHA-256 that the
// version's manifest.json publishes, and it must answer `claude --version`
// before `current` is switched to it. Layout and the update loop are shared
// with the managed Codex (server/codex-managed.ts).
//
// Opt-in: it runs when `features.managedClaude` is true, or when this machine
// has no other claude executable at all. An owner's own Claude Code is never
// shadowed unless they asked for it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  completedInstallSync,
  ManagedRuntimeUpdater,
  switchManagedRuntime,
  type ManagedCodexInstall,
  type ManagedRuntimeUpdaterOptions,
} from "./codex-managed.ts";

export const CLAUDE_RELEASES_URL = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";
const DOWNLOAD_HOST = "storage.googleapis.com";
/** The installer's conservative channel; `latest` moves several times a week. */
const CHANNEL = "stable";
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const MAX_BINARY_BYTES = 1024 * 1024 * 1024;
const ESTIMATED_DOWNLOAD_BYTES = 270 * 1024 * 1024;
const RECORD = ".install-complete.json";
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface ClaudeRelease {
  version: string;
  bytes: number;
  sha256: string;
  url: string;
}

/** The manifest's platform key, or null when this module installs none
 * (Windows ships claude.exe through a different installer). */
export function claudePlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `darwin-${cpu}`;
  if (platform === "linux") return `linux-${cpu}`;
  return null;
}

/** `2.1.292` or `2.1.292 (Claude Code)` → `2.1.292`. */
export function parseClaudeVersion(text: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+)(?=\s|$)/.exec(text.trim());
  return match ? match[1]! : null;
}

/** Pick this machine's binary out of a version's manifest.json. */
export function parseClaudeManifest(body: unknown, version: string, platform: string): ClaudeRelease {
  if (!VERSION.test(version)) throw new Error(`Unrecognised Claude Code version ${JSON.stringify(version)}.`);
  const manifest = body as { version?: unknown; platforms?: Record<string, { binary?: unknown; checksum?: unknown; size?: unknown }> } | null;
  if (!manifest || typeof manifest !== "object") throw new Error("The Claude Code release manifest is unreadable.");
  if (manifest.version !== version) throw new Error(`The Claude Code manifest is for ${JSON.stringify(manifest.version)}, expected ${version}.`);
  const entry = manifest.platforms?.[platform];
  if (!entry) throw new Error(`Claude Code ${version} has no ${platform} build.`);
  if (entry.binary !== "claude") throw new Error(`Claude Code ${version} names an unexpected binary for ${platform}.`);
  const sha256 = typeof entry.checksum === "string" ? entry.checksum.toLowerCase() : "";
  if (!SHA256.test(sha256)) throw new Error(`Claude Code ${version} publishes no SHA-256 for ${platform}; refusing to install it.`);
  const bytes = entry.size;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_BINARY_BYTES) {
    throw new Error(`Claude Code ${version} reports an implausible download size.`);
  }
  return { version, bytes, sha256, url: `${CLAUDE_RELEASES_URL}/${version}/${platform}/claude` };
}

export async function fetchLatestClaudeRelease(platform: string, fetchImpl: typeof fetch = fetch): Promise<ClaudeRelease> {
  const pointer = await fetchImpl(`${CLAUDE_RELEASES_URL}/${CHANNEL}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!pointer.ok) throw new Error(`Claude Code release lookup failed (${pointer.status}).`);
  const version = (await pointer.text()).trim();
  if (!VERSION.test(version)) throw new Error(`Unrecognised Claude Code version ${JSON.stringify(version.slice(0, 40))}.`);
  const manifest = await fetchImpl(`${CLAUDE_RELEASES_URL}/${version}/manifest.json`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!manifest.ok) throw new Error(`Claude Code manifest lookup failed (${manifest.status}).`);
  return parseClaudeManifest(await manifest.json(), version, platform);
}

export function managedClaudeRoot(baseDir: string): string {
  return join(baseDir, "tools", "claude");
}

/** The directory on the engines' PATH: a symlink to the active version. */
export function managedClaudeBinDir(baseDir: string): string {
  return join(managedClaudeRoot(baseDir), "current");
}

/** Every claude on PATH that is not this app's managed copy. */
export function otherClaudeCandidates(candidates: readonly string[], baseDir: string): string[] {
  const root = managedClaudeRoot(baseDir) + sep;
  return candidates.filter((path) => !path.startsWith(root));
}

/** The version `current` points at, when it is a complete install. */
export function currentManagedClaude(baseDir: string): ManagedCodexInstall | null {
  const root = managedClaudeRoot(baseDir);
  try {
    const target = readlinkSync(join(root, "current"));
    if (!VERSION.test(target)) return null;
    return completedInstallSync(join(root, target), target, "claude");
  } catch {
    return null;
  }
}

/** Run `<binary> --version` and require it to report `version`. */
export function validateClaudeBinary(binary: string, version: string): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/", NO_COLOR: "1", DISABLE_AUTOUPDATER: "1" };
    execFile(binary, ["--version"], { timeout: VERSION_TIMEOUT_MS, env }, (error, stdout) => {
      const output = String(stdout ?? "").trim();
      if (error) return rejectRun(new Error(`The downloaded Claude Code ${version} did not run (${error.message.split("\n")[0]}).`));
      if (parseClaudeVersion(output) !== version) return rejectRun(new Error(`The downloaded Claude Code reported ${JSON.stringify(output.slice(0, 80))}, expected ${version}.`));
      resolveRun(output);
    });
  });
}

async function downloadVerified(release: ClaudeRelease, path: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(release.url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`The Claude Code download failed (${response.status}).`);
  const finalUrl = new URL(response.url || release.url);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== DOWNLOAD_HOST) {
    throw new Error("The Claude Code download redirected outside Anthropic's release bucket.");
  }
  const handle = await open(path, "wx", 0o700);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const raw of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > release.bytes) throw new Error("The Claude Code download is larger than its manifest says; refusing it.");
      await handle.write(chunk);
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  if (bytes !== release.bytes) throw new Error("The Claude Code download was truncated.");
  const actual = hash.digest("hex");
  if (actual !== release.sha256) {
    throw new Error(`The Claude Code download failed its SHA-256 check (expected ${release.sha256}, got ${actual}). Nothing was installed.`);
  }
}

export interface InstallClaudeOptions {
  baseDir: string;
  fetchImpl?: typeof fetch;
  validate?: (binary: string, version: string) => Promise<unknown>;
}

const installs = new Map<string, Promise<ManagedCodexInstall>>();

/** Download, verify and validate one release into `<root>/<version>/`.
 * Does not switch `current`. Concurrent calls for one root share a run. */
export function installClaudeRelease(release: ClaudeRelease, options: InstallClaudeOptions): Promise<ManagedCodexInstall> {
  const key = `${managedClaudeRoot(options.baseDir)} ${release.version}`;
  const existing = installs.get(key);
  if (existing) return existing;
  const run = installOnce(release, options).finally(() => installs.delete(key));
  installs.set(key, run);
  return run;
}

async function installOnce(release: ClaudeRelease, options: InstallClaudeOptions): Promise<ManagedCodexInstall> {
  if (!VERSION.test(release.version)) throw new Error(`Refusing unexpected Claude Code version ${JSON.stringify(release.version)}.`);
  const validate = options.validate ?? validateClaudeBinary;
  const root = managedClaudeRoot(options.baseDir);
  const destination = join(root, release.version);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const done = completedInstallSync(destination, release.version, "claude");
  if (done) {
    await validate(done.binary, release.version);
    return done;
  }
  const staging = await mkdtemp(join(root, ".install-"));
  try {
    const runtime = join(staging, "runtime");
    await mkdir(runtime, { mode: 0o755 });
    const binary = join(runtime, "claude");
    await downloadVerified(release, binary, options.fetchImpl ?? fetch);
    await chmod(binary, 0o755);
    await validate(binary, release.version);
    const record = { version: release.version, sha256: release.sha256, bytes: release.bytes };
    await writeFile(join(runtime, RECORD), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o644 });
    if (existsSync(destination) && !completedInstallSync(destination, release.version, "claude")) await rm(destination, { recursive: true, force: true });
    try {
      await rename(runtime, destination);
    } catch (error) {
      if (!completedInstallSync(destination, release.version, "claude")) throw error;
    }
    const installed = completedInstallSync(destination, release.version, "claude");
    if (!installed) throw new Error("The installed Claude Code runtime is incomplete.");
    return installed;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** The activation rule: asked for explicitly, or there is no other claude. */
export function managedClaudeWanted(input: { flag: unknown; otherClaudeOnPath: boolean; supported: boolean }): boolean {
  return input.supported && (input.flag === true || !input.otherClaudeOnPath);
}

export interface ManagedClaudeUpdaterOptions extends ManagedRuntimeUpdaterOptions {
  baseDir: string;
  /** Manifest platform key; null when this platform has no managed build. */
  platform?: string | null;
  fetchImpl?: typeof fetch;
  validate?: (binary: string, version: string) => Promise<unknown>;
}

export class ManagedClaudeUpdater extends ManagedRuntimeUpdater {
  constructor(options: ManagedClaudeUpdaterOptions) {
    const platform = options.platform === undefined ? claudePlatform() : options.platform;
    const releases = new Map<string, ClaudeRelease>();
    super({
      name: "Claude Code",
      supported: platform !== null,
      binDir: managedClaudeBinDir(options.baseDir),
      current: () => currentManagedClaude(options.baseDir),
      latest: async () => {
        const release = await fetchLatestClaudeRelease(platform!, options.fetchImpl);
        releases.set(release.version, release);
        return release;
      },
      install: (found) => {
        const release = releases.get(found.version);
        if (!release) throw new Error(`Claude Code ${found.version} was not looked up first.`);
        return installClaudeRelease(release, { baseDir: options.baseDir, fetchImpl: options.fetchImpl, validate: options.validate });
      },
      switchTo: (version) => switchManagedRuntime(managedClaudeRoot(options.baseDir), version, "claude", "Claude Code"),
      estimatedBytes: ESTIMATED_DOWNLOAD_BYTES,
    }, options);
  }
}
