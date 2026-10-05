// Run after build:server. Relocate the runtime away from node_modules, give it
// an empty home/cwd, and prove the native addon can spawn and resize a real PTY.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") throw new Error("This PTY shell/resize smoke requires a Unix release builder");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "omb-terminal-pty-"));
try {
  const server = join(fixture, "server");
  mkdirSync(server);
  cpSync(join(root, "dist-server", "terminal-pty.js"), join(server, "terminal-pty.js"));
  cpSync(join(root, "dist-server", "vendor"), join(server, "vendor"), { recursive: true });
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
  const cwd = join(fixture, "workspace");
  const home = join(fixture, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  writeFileSync(join(fixture, "probe.mjs"), `
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { spawnTerminalPty } from "./server/terminal-pty.js";
const cwd = process.env.FIXTURE_CWD;
const pty = spawnTerminalPty(cwd);
const timer = setTimeout(() => { pty.kill(); throw new Error("PTY timed out"); }, 10000);
let output = "";
pty.onData((data) => { output += data; });
pty.onExit(({ exitCode }) => {
  clearTimeout(timer);
  try {
    assert.equal(exitCode, 0);
    const lines = output.split(/\\r?\\n/).map((line) => line.trim());
    assert(lines.includes("pty-ok"), output);
    assert(lines.includes(cwd) || lines.includes(realpathSync(cwd)), output);
    assert(lines.some((line) => /^31\\s+93$/.test(line)), output);
    console.log("packaged PTY: cwd, interactive output, resize and clean exit passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
pty.resize(93, 31);
pty.write("printf 'pty-ok\\\\n'; pwd; stty size; exit\\n");
`);
  const child = spawn(process.execPath, [join(fixture, "probe.mjs")], {
    cwd: fixture,
    env: { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", HOME: home, FIXTURE_CWD: cwd },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, output);
    assert(output.includes("packaged PTY: cwd"), output);
    process.stdout.write(output);
  } finally {
    clearTimeout(timer);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
