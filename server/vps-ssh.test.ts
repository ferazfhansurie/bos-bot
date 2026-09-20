import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareVpsSsh, vpsSshConfigText } from "./vps-ssh.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "omb-vps-ssh-")); dirs.push(dir); return dir; };

describe("VPS SSH connection sharing supplied by the app", () => {
  it("does nothing on Windows, where OpenSSH has no connection sharing", () => {
    const data = scratch();
    expect(prepareVpsSsh(data, "C:\\Windows\\System32", "win32")).toEqual({ configPath: null, path: "C:\\Windows\\System32" });
    expect(existsSync(join(data, "ssh"))).toBe(false);
  });
});

// The sharing itself is POSIX: forward-slash control paths, colon-separated
// PATH, file modes. Windows never installs it, so these do not run there.
describe.skipIf(process.platform === "win32")("VPS SSH connection sharing on POSIX", () => {
  it("writes a config that includes the person's own file first and fills in sharing and timeouts", () => {
    const home = scratch();
    const userConfig = join(home, "config"); writeFileSync(userConfig, "Host my-vps\n  ControlMaster no\n");
    const text = vpsSshConfigText("/data/ssh", userConfig, join(home, "missing-system-config"));
    const lines = text.split("\n");
    // theirs first, so ssh's first-value-wins rule keeps their choices
    expect(lines.findIndex((line) => line === `Include ${userConfig}`)).toBeLessThan(lines.indexOf("Host *"));
    expect(text).toContain("  ControlMaster auto");
    expect(text).toContain("  ControlPath /data/ssh/cm-%C");
    expect(text).toContain("  ControlPersist 10m");
    expect(text).toContain("  ServerAliveInterval 15");
    expect(text).toContain("  ConnectTimeout 10");
    expect(text).not.toContain("missing-system-config");
    // no user file: no dangling Include
    expect(vpsSshConfigText("/data/ssh", join(home, "absent"), join(home, "absent2"))).not.toContain("Include");
  });

  it("installs a shim docker finds ahead of the real ssh, pointing at that config, with private modes", () => {
    const data = scratch(), fakeBin = scratch();
    const realSsh = join(fakeBin, "ssh"); writeFileSync(realSsh, "#!/bin/sh\nexit 0\n"); chmodSync(realSsh, 0o755);
    const setup = prepareVpsSsh(data, `${fakeBin}:/usr/bin`, "darwin");
    expect(setup.configPath).toBe(join(data, "ssh", "config"));
    expect(setup.path.split(":")[0]).toBe(join(data, "ssh", "bin"));
    const shim = readFileSync(join(data, "ssh", "bin", "ssh"), "utf8");
    expect(shim).toContain(`exec ${JSON.stringify(realSsh)} -F ${JSON.stringify(setup.configPath)} "$@"`);
    expect(statSync(join(data, "ssh", "bin", "ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(setup.configPath!).mode & 0o777).toBe(0o600);
    expect(statSync(join(data, "ssh")).mode & 0o777).toBe(0o700);
    // idempotent: a second call leaves the same files
    expect(prepareVpsSsh(data, `${fakeBin}:/usr/bin`, "darwin")).toEqual(setup);
  });

  it("never picks its own shim as the real ssh, and leaves PATH alone when no ssh exists", () => {
    const data = scratch();
    mkdirSync(join(data, "ssh", "bin"), { recursive: true });
    writeFileSync(join(data, "ssh", "bin", "ssh"), "#!/bin/sh\n"); chmodSync(join(data, "ssh", "bin", "ssh"), 0o700);
    const setup = prepareVpsSsh(data, `${join(data, "ssh", "bin")}:${scratch()}`, "linux");
    expect(setup.path.startsWith(join(data, "ssh", "bin"))).toBe(true); // the caller's own PATH, unchanged
    expect(setup.path.split(":").filter((entry) => entry === join(data, "ssh", "bin"))).toHaveLength(1);
    expect(existsSync(setup.configPath!)).toBe(true);
  });

});
