import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WINDOWS_SUPERVISED_MODE,
  decodeWindowsSupervisedDescriptor,
  gatedLocalComputer,
  readCuaConnection,
} from "./local-computer.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
// @ts-expect-error untyped fixture module
import { createFixture } from "../electron/fixtures/windows-cua-host-fixture.mjs";
// @ts-expect-error untyped host module
import { WINDOWS_CUA_ATTESTATION, WINDOWS_CUA_MODE, installWindowsCuaAttestation } from "../electron/windows-cua-host.mjs";

const PIPE = "\\\\.\\pipe\\cua-driver-embedded-7000";
const DRIVER = "C:\\Users\\owner\\AppData\\Local\\BOSServerStandalone\\resources\\cua-driver.exe";
const HASH = "a".repeat(64);

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mode: WINDOWS_SUPERVISED_MODE,
    platform: "win32",
    environmentId: "partner-server-01",
    instanceNonce: "3f0c6c1c-2c0b-4b9f-8f5e-3d1f6f0d9a10",
    generation: "generation-7000",
    owner: { pid: 4100, startTimeMs: 1000, sid: "S-1-5-21-1-2-3-1001", sessionId: 2 },
    daemon: { pid: 7000, startTimeMs: 9000, socketPath: PIPE, driverVersion: "0.28.2", contractVersion: "1.0.0", mcpProtocolVersion: "2025-06-18" },
    driver: { path: DRIVER, version: "0.28.2", sha256: HASH, sdkSha256: HASH },
    mcp: {
      command: DRIVER,
      args: ["mcp", "--embedded", "--socket", PIPE],
      env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app" },
    },
    ...overrides,
  };
}

const roots: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-local-computer-win-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("supervised Windows descriptor", () => {
  it("keeps the mode string in sync with the host module", () => {
    expect(WINDOWS_SUPERVISED_MODE).toBe(WINDOWS_CUA_MODE);
  });

  it("decodes only the exact embedded-driver shape", () => {
    expect(decodeWindowsSupervisedDescriptor(descriptor())).toEqual({
      command: DRIVER,
      args: ["mcp", "--embedded", "--socket", PIPE],
      env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0", CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: "com.openmausbot.app" },
      platform: "win32",
      generation: "generation-7000",
      scope: "local-computer",
    });
  });

  it.each([
    ["an extra top-level key", { extra: true }],
    ["the legacy mode", { mode: "embedded" }],
    ["session 0", { owner: { pid: 4100, startTimeMs: 1000, sid: "S-1-5-21-1-2-3-1001", sessionId: 0 } }],
    ["a TCP socket", { daemon: { ...descriptor().daemon, socketPath: "127.0.0.1:9000" } }],
    ["a different command", { mcp: { ...descriptor().mcp, command: "C:\\Windows\\System32\\cmd.exe" } }],
    ["a non-driver executable", { driver: { ...descriptor().driver, path: "C:\\evil.exe" } }],
    ["a relative driver", { driver: { ...descriptor().driver, path: "cua-driver.exe" } }],
    ["extra argv", { mcp: { ...descriptor().mcp, args: ["mcp", "--embedded", "--socket", PIPE, "--x"] } }],
    ["a mismatched pipe argv", { mcp: { ...descriptor().mcp, args: ["mcp", "--embedded", "--socket", "\\\\.\\pipe\\other"] } }],
    ["extra env", { mcp: { ...descriptor().mcp, env: { ...descriptor().mcp.env, NODE_OPTIONS: "--require x" } } }],
    ["telemetry on", { mcp: { ...descriptor().mcp, env: { ...descriptor().mcp.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "1" } } }],
    ["a bad hash", { driver: { ...descriptor().driver, sha256: "nothex" } }],
    ["a version mismatch", { driver: { ...descriptor().driver, version: "0.28.1" } }],
  ])("rejects %s", (_name, overrides) => {
    expect(decodeWindowsSupervisedDescriptor(descriptor(overrides))).toBeNull();
  });

  it("never falls back to the legacy descriptor in supervised mode", () => {
    const userData = tempDir();
    writeFileSync(join(userData, "cua-connection.json"), JSON.stringify({ mode: "embedded", mcpCommand: "C:\\cua-driver.exe", mcpArgs: ["mcp"], mcpEnv: {} }));
    expect(readCuaConnection({ platform: "win32", userData, windowsSupervised: true, windowsDescriptor: undefined, windowsAttestation: { attest: () => true } })).toBeNull();
    expect(readCuaConnection({ platform: "win32", userData, windowsSupervised: false, windowsAttestation: null })).not.toBeNull();
  });

  it("requires the in-process attestation to accept the exact file and content", () => {
    const dir = tempDir();
    const file = join(dir, "cua-connection.json");
    writeFileSync(file, JSON.stringify(descriptor()));
    const seen: unknown[] = [];
    const read = (attest: (f: string, raw: unknown) => boolean) =>
      readCuaConnection({ platform: "win32", windowsSupervised: true, windowsDescriptor: file, windowsAttestation: { attest } });
    expect(read(() => false)).toBeNull();
    expect(readCuaConnection({ platform: "win32", windowsSupervised: true, windowsDescriptor: file, windowsAttestation: null })).toBeNull();
    expect(read((f, raw) => { seen.push([f, raw]); return true; })?.command).toBe(DRIVER);
    expect(seen).toEqual([[file, descriptor()]]);
    // A malformed file is refused before attestation is asked.
    writeFileSync(file, JSON.stringify(descriptor({ extra: 1 })));
    expect(read(() => true)).toBeNull();
    writeFileSync(file, "{");
    expect(read(() => true)).toBeNull();
  });

  it("refuses a symlinked descriptor", () => {
    const dir = tempDir();
    const real = join(dir, "real.json");
    const link = join(dir, "cua-connection.json");
    writeFileSync(real, JSON.stringify(descriptor()));
    symlinkSync(real, link);
    expect(readCuaConnection({ platform: "win32", windowsSupervised: true, windowsDescriptor: link, windowsAttestation: { attest: () => true } })).toBeNull();
  });

  it("is ignored off Windows", () => {
    const userData = tempDir();
    mkdirSync(userData, { recursive: true });
    expect(readCuaConnection({ platform: "linux", userData, windowsSupervised: true, windowsDescriptor: "/x", windowsAttestation: { attest: () => true } })).toBeNull();
  });
});

describe("owned host to per-turn proxy gate", () => {
  it("serves the host's descriptor only through the proxy gate and only while attested", async () => {
    const fx = createFixture();
    try {
      const host = fx.make();
      expect((await host.start()).state).toBe("ready");
      const target: Record<symbol, { attest(file: string, raw: unknown): boolean }> = {};
      installWindowsCuaAttestation(host, target);
      const attestation = target[WINDOWS_CUA_ATTESTATION as symbol];
      const read = () => readCuaConnection({ platform: "win32", windowsSupervised: true, windowsDescriptor: fx.descriptorPath, windowsAttestation: attestation });

      const connection = read();
      expect(connection).not.toBeNull();
      const pipe = fx.readDescriptor().daemon.socketPath;
      const gated = gatedLocalComputer(connection!, { url: "http://127.0.0.1:1/control", token: "fixture-token" });
      expect(gated.command).toBe(process.execPath);
      expect(gated.args).toEqual(["--experimental-strip-types", SPAWNED_PROXIES.localComputer]);
      expect(gated.env.OMB_CUA_COMMAND).toBe(fx.binary);
      expect(JSON.parse(gated.env.OMB_CUA_ARGS)).toEqual(["mcp", "--embedded", "--socket", pipe]);
      expect(gated.env.CUA_DRIVER_EMBEDDED).toBe("1");

      // Lock: descriptor revoked, the server stops handing it out.
      fx.state.session.inputDesktop = "Winlogon";
      await fx.runTimers();
      expect(read()).toBeNull();
      fx.state.session.inputDesktop = "Default";
      await fx.runTimers();
      expect(read()).not.toBeNull();

      // A same-content rewrite by anyone else is not the host's file any more.
      const raw = readFileSync(fx.descriptorPath, "utf8");
      writeFileSync(fx.descriptorPath, raw);
      expect(read()).toBeNull();

      await host.stop();
      expect(read()).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; native-helper-id: existing OS permission identity of the native control and speech helpers stays the same; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
