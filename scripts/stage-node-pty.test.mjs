import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stageNodePty } from "./stage-node-pty.mjs";

const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function binary(target) {
  const bytes = Buffer.alloc(128);
  if (target.startsWith("darwin")) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
  } else if (target.startsWith("linux")) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18);
  } else {
    bytes.set([0x4d, 0x5a]);
    bytes.writeUInt32LE(64, 0x3c);
    bytes.set([0x50, 0x45, 0, 0], 64);
    bytes.writeUInt16LE(target.endsWith("arm64") ? 0xaa64 : 0x8664, 68);
  }
  return bytes;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bos-pty-stage-"));
  directories.push(dir);
  const source = join(dir, "source");
  const destination = join(dir, "vendor");
  mkdirSync(join(source, "lib"), { recursive: true });
  writeFileSync(join(source, "package.json"), '{"main":"lib/index.js"}');
  writeFileSync(join(source, "LICENSE"), "fixture");
  writeFileSync(join(source, "lib", "index.js"), "module.exports = {};");
  writeFileSync(join(source, "lib", "index.test.js"), "test only");
  return { source, destination };
}

function runtime(source, relative, target) {
  const directory = join(source, relative);
  mkdirSync(directory, { recursive: true });
  const files = target.startsWith("win32")
    ? ["conpty.node", "conpty_console_list.node", "pty.node", "winpty.dll", "winpty-agent.exe", "conpty/OpenConsole.exe", "conpty/conpty.dll"]
    : ["pty.node", "spawn-helper"];
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), binary(target), { mode: 0o644 });
  }
  writeFileSync(join(directory, "ignored.o"), "intermediate");
}

it.each(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"])("falls back from stale release binaries to %s prebuilds", (target) => {
  const { source, destination } = fixture();
  const [platform, arch] = target.split("-");
  runtime(source, "build/Release", `${platform}-${arch === "arm64" ? "x64" : "arm64"}`);
  runtime(source, `prebuilds/${target}`, target);
  mkdirSync(join(destination, "build/Release"), { recursive: true });
  writeFileSync(join(destination, "build/Release", "pty.node"), "stale vendor");
  expect(stageNodePty(source, destination, { platform, arch })).toBe(`prebuilds/${target}`);
  expect(existsSync(join(destination, "build"))).toBe(false);
  expect(readFileSync(join(destination, `prebuilds/${target}`, platform === "win32" ? "conpty.node" : "pty.node"))).toEqual(binary(target));
  expect(existsSync(join(destination, `prebuilds/${target}`, "ignored.o"))).toBe(false);
  expect(existsSync(join(destination, "lib", "index.test.js"))).toBe(false);
  // Windows has no POSIX mode bits to check on the host either.
  if (platform !== "win32" && process.platform !== "win32") expect(statSync(join(destination, `prebuilds/${target}`, "spawn-helper")).mode & 0o777).toBe(0o755);
});

it("retains a compatible local release build when no prebuild exists", () => {
  const { source, destination } = fixture();
  runtime(source, "build/Release", "linux-x64");
  expect(stageNodePty(source, destination, { platform: "linux", arch: "x64" })).toBe("build/Release");
});

it("stages a linux source build that has no spawn-helper", () => {
  const { source, destination } = fixture();
  runtime(source, "build/Release", "linux-x64");
  rmSync(join(source, "build/Release", "spawn-helper"));
  expect(stageNodePty(source, destination, { platform: "linux", arch: "x64" })).toBe("build/Release");
  expect(existsSync(join(destination, "build/Release", "pty.node"))).toBe(true);
});

it.each(["wrong helper", "missing helper", "corrupt addon"])("skips a release build with %s", (failure) => {
  const { source, destination } = fixture();
  runtime(source, "build/Release", "darwin-arm64");
  runtime(source, "prebuilds/darwin-arm64", "darwin-arm64");
  const helper = join(source, "build/Release", "spawn-helper");
  if (failure === "wrong helper") writeFileSync(helper, binary("darwin-x64"));
  else if (failure === "missing helper") rmSync(helper);
  else writeFileSync(join(source, "build/Release", "pty.node"), "corrupt");
  expect(stageNodePty(source, destination, { platform: "darwin", arch: "arm64" })).toBe("prebuilds/darwin-arm64");
});

it("rejects mislabeled prebuilds and removes stale vendor output", () => {
  const { source, destination } = fixture();
  runtime(source, "build/Release", "darwin-x64");
  runtime(source, "prebuilds/darwin-arm64", "darwin-x64");
  mkdirSync(destination);
  writeFileSync(join(destination, "stale.node"), "stale");
  expect(() => stageNodePty(source, destination, { platform: "darwin", arch: "arm64" })).toThrow(/no native runtime for darwin-arm64.*architecture mismatch/);
  expect(existsSync(destination)).toBe(false);
});

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("stages the real arm64 npm prebuild despite a real x64 release addon", () => {
  const { source, destination } = fixture();
  const require = createRequire(import.meta.url);
  const upstream = dirname(require.resolve("node-pty/package.json"));
  cpSync(upstream, source, { recursive: true });
  cpSync(join(upstream, "prebuilds/darwin-x64"), join(source, "build/Release"), { recursive: true });
  expect(stageNodePty(source, destination, { platform: "darwin", arch: "arm64" })).toBe("prebuilds/darwin-arm64");
  expect(existsSync(join(destination, "build"))).toBe(false);
  expect(readFileSync(join(destination, "prebuilds/darwin-arm64/pty.node"))).toEqual(readFileSync(join(upstream, "prebuilds/darwin-arm64/pty.node")));
  const home = join(source, "empty-home");
  mkdirSync(home);
  const probe = spawnSync(process.execPath, ["-e", `
const pty = require(process.argv[1]);
const terminal = pty.spawn('/bin/sh', ['-c', 'printf "staged-pty-ok\\n"'], {
  cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
  cols: 80, rows: 24,
});
let output = '';
const timer = setTimeout(() => { terminal.kill(); process.exitCode = 1; }, 5000);
terminal.onData(data => { output += data; });
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes('staged-pty-ok')) process.exitCode = 1;
  else console.log('staged PTY loaded and spawned from isolated vendor');
});`, destination], {
    cwd: home, env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8", timeout: 10000,
  });
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout).toContain("staged PTY loaded and spawned");
});
