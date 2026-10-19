import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_RELEASES_URL,
  claudePlatform,
  currentManagedClaude,
  installClaudeRelease,
  ManagedClaudeUpdater,
  managedClaudeBinDir,
  managedClaudeWanted,
  otherClaudeCandidates,
  parseClaudeManifest,
  parseClaudeVersion,
} from "./claude-managed.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const PLATFORM = "darwin-arm64";

function fakeClaude(version: string): Buffer {
  return Buffer.from(`#!/bin/sh\necho "${version} (Claude Code)"\n`);
}

function manifest(version: string, binary: Buffer, overrides: Record<string, unknown> = {}) {
  return {
    version,
    platforms: {
      [PLATFORM]: { binary: "claude", checksum: createHash("sha256").update(binary).digest("hex"), size: binary.length, ...overrides },
    },
  };
}

function fakeBucket(state: { version: string; binary: Buffer; tamper?: boolean }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === `${CLAUDE_RELEASES_URL}/stable`) return new Response(`${state.version}\n`);
    if (url === `${CLAUDE_RELEASES_URL}/${state.version}/manifest.json`) return Response.json(manifest(state.version, state.binary));
    if (url === `${CLAUDE_RELEASES_URL}/${state.version}/${PLATFORM}/claude`) {
      const body = state.tamper ? Buffer.from(state.binary.toString().replace("Claude", "Cl4ude")) : state.binary;
      return new Response(new Uint8Array(body));
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const scratches: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bos-claude-managed-"));
  scratches.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratches.splice(0)) await removeTempDir(dir);
});

describe("claude release manifest", () => {
  it("maps platforms and parses --version output", () => {
    expect(claudePlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(claudePlatform("darwin", "x64")).toBe("darwin-x64");
    expect(claudePlatform("win32", "x64")).toBeNull();
    expect(parseClaudeVersion("2.1.292 (Claude Code)")).toBe("2.1.292");
    expect(parseClaudeVersion("Claude Code")).toBeNull();
  });

  it("refuses a manifest without a checksum, for another version, or with a strange binary", () => {
    const binary = fakeClaude("2.1.0");
    expect(parseClaudeManifest(manifest("2.1.0", binary), "2.1.0", PLATFORM).url).toBe(`${CLAUDE_RELEASES_URL}/2.1.0/${PLATFORM}/claude`);
    expect(() => parseClaudeManifest(manifest("2.1.0", binary, { checksum: "" }), "2.1.0", PLATFORM)).toThrow(/no SHA-256/);
    expect(() => parseClaudeManifest(manifest("2.1.0", binary), "2.1.1", PLATFORM)).toThrow(/expected 2.1.1/);
    expect(() => parseClaudeManifest(manifest("2.1.0", binary, { binary: "../evil" }), "2.1.0", PLATFORM)).toThrow(/unexpected binary/);
    expect(() => parseClaudeManifest(manifest("2.1.0", binary), "2.1.0", "linux-x64")).toThrow(/no linux-x64 build/);
  });

  it("is wanted when asked for or when no other claude exists", () => {
    expect(managedClaudeWanted({ flag: true, otherClaudeOnPath: true, supported: true })).toBe(true);
    expect(managedClaudeWanted({ flag: undefined, otherClaudeOnPath: false, supported: true })).toBe(true);
    expect(managedClaudeWanted({ flag: undefined, otherClaudeOnPath: true, supported: true })).toBe(false);
    expect(managedClaudeWanted({ flag: true, otherClaudeOnPath: false, supported: false })).toBe(false);
    const base = "/data";
    expect(otherClaudeCandidates(["/data/tools/claude/current/claude", "/usr/local/bin/claude"], base)).toEqual(["/usr/local/bin/claude"]);
  });
});

describe("installing Claude Code", () => {
  it("rejects a download that fails its checksum and leaves nothing behind", async () => {
    const base = scratch();
    const state = { version: "2.1.0", binary: fakeClaude("2.1.0"), tamper: true };
    const bucket = fakeBucket(state);
    const release = parseClaudeManifest(manifest(state.version, state.binary), state.version, PLATFORM);
    await expect(installClaudeRelease(release, { baseDir: base, fetchImpl: bucket.fetchImpl })).rejects.toThrow(/SHA-256/);
    expect(readdirSync(join(base, "tools", "claude"))).toEqual([]);
  });

  it("installs, activates and updates through the shared updater", async () => {
    const base = scratch();
    const state = { version: "2.1.0", binary: fakeClaude("2.1.0") };
    const bucket = fakeBucket(state);
    const registered: string[] = [];
    const switched: string[] = [];
    const updater = new ManagedClaudeUpdater({
      baseDir: base, platform: PLATFORM, fetchImpl: bucket.fetchImpl,
      isActive: () => true, isBusy: () => false,
      registerBinDir: (dir) => registered.push(dir), onSwitch: (version) => switched.push(version), log: () => {},
    });
    await updater.installNow();
    expect(currentManagedClaude(base)?.version).toBe("2.1.0");
    expect(registered).toEqual([managedClaudeBinDir(base)]);
    expect(existsSync(join(managedClaudeBinDir(base), "claude"))).toBe(true);

    state.version = "2.2.0";
    state.binary = fakeClaude("2.2.0");
    await updater.check();
    expect(currentManagedClaude(base)?.version).toBe("2.2.0");
    expect(switched).toEqual(["2.1.0", "2.2.0"]);
    expect(updater.status()).toMatchObject({ active: true, version: "2.2.0", latest: "2.2.0", pending: null, lastError: null });
  });
});
