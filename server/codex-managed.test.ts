import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexTarget,
  CODEX_HOST_BINARY,
  compareCodexVersions,
  hasCodexHostSync,
  currentManagedCodex,
  extractCodexBinary,
  installCodexRelease,
  ManagedCodexUpdater,
  managedCodexBinDir,
  managedCodexRoot,
  managedCodexWanted,
  otherCodexCandidates,
  parseCodexVersion,
  parseLatestRelease,
  parseSha256Digest,
  switchManagedCodex,
  type CodexRelease,
} from "./codex-managed.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const TARGET = "aarch64-apple-darwin";
const DOWNLOAD = (version: string) => `https://github.com/openai/codex/releases/download/rust-v${version}/codex-${TARGET}.tar.gz`;

// A minimal ustar writer, so the archive under test is byte-for-byte known
// (a system tar adds platform metadata entries).
function tarHeader(name: string, size: number, type: string, mode = 0o755): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(type, 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function tarEntry(name: string, data: Buffer, type = "0"): Buffer {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, type), data, padding]);
}

function paxEntry(records: Record<string, string>): Buffer {
  const body = Object.entries(records).map(([key, value]) => {
    const text = ` ${key}=${value}\n`;
    let length = text.length + 1;
    while (`${length}${text}`.length !== length) length += 1;
    return `${length}${text}`;
  }).join("");
  return tarEntry("PaxHeader", Buffer.from(body), "x");
}

function tarGz(...entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function fakeCodex(version: string): Buffer {
  return Buffer.from(`#!/bin/sh\necho "codex-cli ${version}"\n`);
}

function releaseFor(version: string, archive: Buffer, overrides: Partial<CodexRelease["asset"]> = {}): CodexRelease {
  return {
    version,
    asset: {
      name: `codex-${TARGET}.tar.gz`,
      url: DOWNLOAD(version),
      bytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
      ...overrides,
    },
  };
}

function releaseJson(version: string, archive: Buffer, extra: Record<string, unknown> = {}) {
  return {
    tag_name: `rust-v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: "codex-x86_64-apple-darwin.tar.gz", size: 1, digest: `sha256:${"0".repeat(64)}`, browser_download_url: DOWNLOAD(version).replace(TARGET, "x86_64-apple-darwin") },
      {
        name: `codex-${TARGET}.tar.gz`,
        size: archive.length,
        digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
        browser_download_url: DOWNLOAD(version),
        ...extra,
      },
    ],
  };
}

/** Serves the GitHub API answer and the asset bytes; nothing reaches the network. */
function fakeGithub(state: { version: string; archive: Buffer; fail?: boolean }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (state.fail) throw new Error("network down");
    if (url.startsWith("https://api.github.com/")) return Response.json(releaseJson(state.version, state.archive));
    if (url === DOWNLOAD(state.version)) return new Response(new Uint8Array(state.archive));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const scratches: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bos-codex-managed-"));
  scratches.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of scratches.splice(0)) await removeTempDir(dir);
});

describe("versions and digests", () => {
  it("parses release tags and --version output", () => {
    expect(parseCodexVersion("rust-v0.163.0")).toBe("0.163.0");
    expect(parseCodexVersion("codex-cli 0.163.0")).toBe("0.163.0");
    expect(parseCodexVersion("codex-cli 0.163.0\n")).toBe("0.163.0");
    expect(parseCodexVersion("0.9.12")).toBe("0.9.12");
    expect(parseCodexVersion("rust-v0.163.0-alpha.1")).toBeNull();
    expect(parseCodexVersion("nonsense")).toBeNull();
  });

  it("compares numerically, not as text", () => {
    expect(compareCodexVersions("0.163.0", "0.99.9")).toBe(1);
    expect(compareCodexVersions("0.99.9", "0.163.0")).toBe(-1);
    expect(compareCodexVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareCodexVersions("0.163.1", "0.163.0")).toBe(1);
    expect(compareCodexVersions("2.0.0", "10.0.0")).toBe(-1);
    // an unparseable version never wins
    expect(compareCodexVersions("garbage", "0.1.0")).toBe(-1);
    expect(compareCodexVersions("0.1.0", "garbage")).toBe(1);
  });

  it("accepts only sha256:<64 hex>", () => {
    expect(parseSha256Digest(`sha256:${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    expect(parseSha256Digest(`sha512:${"a".repeat(64)}`)).toBeNull();
    expect(parseSha256Digest(`sha256:${"a".repeat(63)}`)).toBeNull();
    expect(parseSha256Digest(undefined)).toBeNull();
  });

  it("maps platforms to the official targets", () => {
    expect(codexTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(codexTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(codexTarget("linux", "arm64")).toBe("aarch64-unknown-linux-musl");
    expect(codexTarget("linux", "x64")).toBe("x86_64-unknown-linux-musl");
    expect(codexTarget("win32", "x64")).toBeNull();
    expect(codexTarget("darwin", "ia32")).toBeNull();
  });
});

describe("parseLatestRelease", () => {
  const archive = Buffer.from("archive");

  it("picks this machine's asset", () => {
    expect(parseLatestRelease(releaseJson("0.163.0", archive), TARGET)).toEqual(releaseFor("0.163.0", archive));
  });

  it("picks the code-mode host when the release ships one", () => {
    const body = releaseJson("0.163.0", archive);
    const hostUrl = DOWNLOAD("0.163.0").replace(`codex-${TARGET}`, `${CODEX_HOST_BINARY}-${TARGET}`);
    body.assets.push({ name: `${CODEX_HOST_BINARY}-${TARGET}.tar.gz`, size: 7, digest: `sha256:${"a".repeat(64)}`, browser_download_url: hostUrl });
    expect(parseLatestRelease(body, TARGET).host).toEqual({ name: `${CODEX_HOST_BINARY}-${TARGET}.tar.gz`, url: hostUrl, bytes: 7, sha256: "a".repeat(64) });
  });

  it("refuses a release without a digest, a pre-release, or a foreign download address", () => {
    expect(() => parseLatestRelease(releaseJson("0.163.0", archive, { digest: null }), TARGET)).toThrow(/no SHA-256 digest/);
    expect(() => parseLatestRelease({ ...releaseJson("0.163.0", archive), prerelease: true }, TARGET)).toThrow(/pre-release/);
    expect(() => parseLatestRelease(releaseJson("0.163.0", archive, { browser_download_url: "https://evil.test/codex.tar.gz" }), TARGET)).toThrow(/unexpected download/);
    expect(() => parseLatestRelease(releaseJson("0.163.0", archive), "riscv64-unknown-linux-musl")).toThrow(/has no codex-riscv64/);
  });
});

describe("activation rule", () => {
  it("is on when asked for, or when no other codex exists", () => {
    expect(managedCodexWanted({ flag: true, otherCodexOnPath: true, supported: true })).toBe(true);
    expect(managedCodexWanted({ flag: undefined, otherCodexOnPath: false, supported: true })).toBe(true);
    expect(managedCodexWanted({ flag: false, otherCodexOnPath: false, supported: true })).toBe(true);
    expect(managedCodexWanted({ flag: undefined, otherCodexOnPath: true, supported: true })).toBe(false);
    expect(managedCodexWanted({ flag: "true", otherCodexOnPath: true, supported: true })).toBe(false);
    expect(managedCodexWanted({ flag: true, otherCodexOnPath: false, supported: false })).toBe(false);
  });

  it("does not count the managed copy as another codex", () => {
    const base = "/data";
    expect(otherCodexCandidates([join(managedCodexBinDir(base), "codex"), "/opt/homebrew/bin/codex"], base)).toEqual(["/opt/homebrew/bin/codex"]);
    expect(otherCodexCandidates([join(managedCodexRoot(base), "0.1.0", "codex")], base)).toEqual([]);
  });
});

describe("install", () => {
  it("rejects a download whose SHA-256 does not match and installs nothing", async () => {
    const base = scratch();
    const archive = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0")));
    const { fetchImpl } = fakeGithub({ version: "1.0.0", archive });
    const validate = vi.fn(async () => {});
    const release = releaseFor("1.0.0", archive, { sha256: "f".repeat(64) });
    await expect(installCodexRelease(release, { baseDir: base, target: TARGET, fetchImpl, validate })).rejects.toThrow(/SHA-256 check/);
    expect(validate).not.toHaveBeenCalled();
    expect(readdirSync(managedCodexRoot(base))).toEqual([]);
    expect(currentManagedCodex(base)).toBeNull();
  });

  it("rejects a download of the wrong size", async () => {
    const base = scratch();
    const archive = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0")));
    const { fetchImpl } = fakeGithub({ version: "1.0.0", archive });
    await expect(installCodexRelease(releaseFor("1.0.0", archive, { bytes: archive.length + 1 }), { baseDir: base, target: TARGET, fetchImpl })).rejects.toThrow(/truncated/);
    await expect(installCodexRelease(releaseFor("1.0.0", archive, { bytes: archive.length - 1 }), { baseDir: base, target: TARGET, fetchImpl })).rejects.toThrow(/larger than/);
    expect(readdirSync(managedCodexRoot(base))).toEqual([]);
  });

  it("installs a verified binary that answers --version, then switches atomically keeping the previous one", async () => {
    const base = scratch();
    const first = tarGz(tarEntry(`./codex-${TARGET}`, fakeCodex("1.0.0")));
    const github = fakeGithub({ version: "1.0.0", archive: first });
    const installed = await installCodexRelease(releaseFor("1.0.0", first), { baseDir: base, target: TARGET, fetchImpl: github.fetchImpl });
    expect(installed).toEqual({ version: "1.0.0", dir: join(managedCodexRoot(base), "1.0.0"), binary: join(managedCodexRoot(base), "1.0.0", "codex") });
    expect(currentManagedCodex(base)).toBeNull();
    await switchManagedCodex(base, "1.0.0");
    expect(currentManagedCodex(base)?.version).toBe("1.0.0");
    expect(readlinkSync(managedCodexBinDir(base))).toBe("1.0.0");

    for (const version of ["1.1.0", "1.2.0"]) {
      // pax path override exercises the extended-header route GNU/bsd tar emit
      const archive = tarGz(paxEntry({ path: `codex-${TARGET}` }), tarEntry("ignored-name", fakeCodex(version)));
      const next = fakeGithub({ version, archive });
      await installCodexRelease(releaseFor(version, archive), { baseDir: base, target: TARGET, fetchImpl: next.fetchImpl });
      await switchManagedCodex(base, version);
    }
    expect(currentManagedCodex(base)?.version).toBe("1.2.0");
    // the version it replaced stays; anything older is pruned
    expect(readdirSync(managedCodexRoot(base)).sort()).toEqual(["1.1.0", "1.2.0", "current"]);
  });

  it("installs the code-mode host beside codex, and adds it to an install made before the split", async () => {
    const base = scratch();
    const archive = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0")));
    const hostArchive = tarGz(tarEntry(`${CODEX_HOST_BINARY}-${TARGET}`, Buffer.from("#!/bin/sh\n")));
    const hostUrl = DOWNLOAD("1.0.0").replace(`codex-${TARGET}`, `${CODEX_HOST_BINARY}-${TARGET}`);
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === DOWNLOAD("1.0.0")) return new Response(new Uint8Array(archive));
      if (url === hostUrl) return new Response(new Uint8Array(hostArchive));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const host = { name: `${CODEX_HOST_BINARY}-${TARGET}.tar.gz`, url: hostUrl, bytes: hostArchive.length, sha256: createHash("sha256").update(hostArchive).digest("hex") };

    // a 0.162-style install: codex only
    const old = await installCodexRelease(releaseFor("1.0.0", archive), { baseDir: base, target: TARGET, fetchImpl });
    await switchManagedCodex(base, "1.0.0");
    expect(hasCodexHostSync(old.dir)).toBe(false);

    // the same version again, now that the release ships a host: repaired in place
    await installCodexRelease({ ...releaseFor("1.0.0", archive), host }, { baseDir: base, target: TARGET, fetchImpl });
    expect(hasCodexHostSync(old.dir)).toBe(true);
    expect(existsSync(join(managedCodexBinDir(base), CODEX_HOST_BINARY))).toBe(true);
    expect(calls.filter((url) => url === DOWNLOAD("1.0.0"))).toHaveLength(1);

    // a fresh install gets both
    const fresh = scratch();
    const installed = await installCodexRelease({ ...releaseFor("1.0.0", archive), host }, { baseDir: fresh, target: TARGET, fetchImpl });
    expect(hasCodexHostSync(installed.dir)).toBe(true);

    // a host that fails its digest leaves the working install untouched
    const other = scratch();
    await installCodexRelease(releaseFor("1.0.0", archive), { baseDir: other, target: TARGET, fetchImpl });
    await switchManagedCodex(other, "1.0.0");
    const otherDir = join(managedCodexRoot(other), "1.0.0");
    const recordBefore = readFileSync(join(otherDir, ".install-complete.json"), "utf8");
    await expect(installCodexRelease({ ...releaseFor("1.0.0", archive), host: { ...host, sha256: "f".repeat(64) } }, { baseDir: other, target: TARGET, fetchImpl })).rejects.toThrow(/SHA-256 check/);
    expect(currentManagedCodex(other)?.version).toBe("1.0.0");
    expect(readFileSync(join(otherDir, ".install-complete.json"), "utf8")).toBe(recordBefore);
    expect(existsSync(join(otherDir, CODEX_HOST_BINARY))).toBe(false);

    // re-pointing current at the same version keeps the rollback copy
    const rollback = join(managedCodexRoot(base), "0.9.0");
    mkdirSync(rollback);
    await switchManagedCodex(base, "1.0.0");
    expect(existsSync(rollback)).toBe(true);
  });

  it("refuses a binary that reports another version", async () => {
    const base = scratch();
    const archive = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("0.0.1")));
    const { fetchImpl } = fakeGithub({ version: "1.0.0", archive });
    await expect(installCodexRelease(releaseFor("1.0.0", archive), { baseDir: base, target: TARGET, fetchImpl })).rejects.toThrow(/reported "codex-cli 0.0.1", expected 1.0.0/);
    expect(readdirSync(managedCodexRoot(base))).toEqual([]);
  });

  it("rejects archives with extra files or links", async () => {
    const dir = scratch();
    const extra = join(dir, "extra.tar.gz");
    writeFileSync(extra, tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0")), tarEntry("evil.sh", Buffer.from("x"))));
    await expect(extractCodexBinary(extra, `codex-${TARGET}`, join(dir, "out-1"))).rejects.toThrow(/unexpected file/);
    const link = join(dir, "link.tar.gz");
    writeFileSync(link, tarGz(tarEntry(`codex-${TARGET}`, Buffer.alloc(0), "2")));
    await expect(extractCodexBinary(link, `codex-${TARGET}`, join(dir, "out-2"))).rejects.toThrow(/unsupported entry/);
    const missing = join(dir, "missing.tar.gz");
    writeFileSync(missing, tarGz(tarEntry("README.md", Buffer.from("x"))));
    await expect(extractCodexBinary(missing, `codex-${TARGET}`, join(dir, "out-3"))).rejects.toThrow(/unexpected file/);
  });
});

describe("ManagedCodexUpdater", () => {
  function updater(base: string, github: ReturnType<typeof fakeGithub>, overrides: Partial<ConstructorParameters<typeof ManagedCodexUpdater>[0]> = {}) {
    const logs: string[] = [];
    const registered: string[] = [];
    const switched: string[] = [];
    const instance = new ManagedCodexUpdater({
      baseDir: base,
      target: TARGET,
      isActive: () => true,
      isBusy: () => false,
      registerBinDir: (dir) => registered.push(dir),
      onSwitch: (version) => switched.push(version),
      fetchImpl: github.fetchImpl,
      log: (line) => logs.push(line),
      idleRetryMs: 1_000,
      ...overrides,
    });
    return { instance, logs, registered, switched };
  }

  it("never switches while a Codex turn runs, and switches once idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const base = scratch();
    const v1 = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0")));
    const state = { version: "1.0.0", archive: v1 };
    const github = fakeGithub(state);
    let busy = false;
    const { instance, registered, switched } = updater(base, github, { isBusy: () => busy });
    await instance.check();
    expect(currentManagedCodex(base)?.version).toBe("1.0.0");
    expect(registered).toEqual([managedCodexBinDir(base)]);

    state.version = "1.1.0";
    state.archive = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.1.0")));
    busy = true;
    await instance.check();
    expect(instance.status()).toMatchObject({ version: "1.0.0", latest: "1.1.0", pending: "1.1.0" });
    expect(currentManagedCodex(base)?.version).toBe("1.0.0");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(currentManagedCodex(base)?.version).toBe("1.0.0");

    busy = false;
    await vi.advanceTimersByTimeAsync(1_000);
    // the switch itself is real filesystem work started by that timer
    await vi.waitFor(() => expect(currentManagedCodex(base)?.version).toBe("1.1.0"));
    expect(instance.status()).toMatchObject({ version: "1.1.0", pending: null });
    expect(switched).toEqual(["1.0.0", "1.1.0"]);
    instance.stop();
  });

  it("does nothing when inactive, and installs on request anyway", async () => {
    const base = scratch();
    const archive = tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0")));
    const github = fakeGithub({ version: "1.0.0", archive });
    const { instance, registered } = updater(base, github, { isActive: () => false });
    await instance.check();
    expect(github.calls).toEqual([]);
    expect(existsSync(managedCodexRoot(base))).toBe(false);
    await instance.installNow();
    expect(currentManagedCodex(base)?.version).toBe("1.0.0");
    expect(registered).toEqual([managedCodexBinDir(base)]);
    expect(instance.status().active).toBe(true);
  });

  it("logs failures without throwing and keeps the installed version", async () => {
    const base = scratch();
    const state = { version: "1.0.0", archive: tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0"))), fail: false };
    const github = fakeGithub(state);
    const { instance, logs } = updater(base, github);
    await instance.check();
    state.fail = true;
    await expect(instance.check()).resolves.toBeUndefined();
    expect(instance.status()).toMatchObject({ version: "1.0.0", lastError: "network down" });
    expect(logs.at(-1)).toMatch(/retry next cycle: network down/);
    await expect(instance.installNow()).rejects.toThrow("network down");
    expect(currentManagedCodex(base)?.version).toBe("1.0.0");
  });

  it("skips the download when already current", async () => {
    const base = scratch();
    const github = fakeGithub({ version: "1.0.0", archive: tarGz(tarEntry(`codex-${TARGET}`, fakeCodex("1.0.0"))) });
    const { instance } = updater(base, github);
    await instance.check();
    await instance.check();
    expect(github.calls.filter((url) => url.startsWith("https://github.com/"))).toHaveLength(1);
  });
});
