// SSH connection sharing for the VPS computer, supplied by the app.
//
// Every VPS action is `docker -H ssh://alias …`, and the live desktop is an
// SSH port forward. Docker's SSH transport runs whatever `ssh` it finds on
// PATH with the user's own ~/.ssh/config, so without ControlMaster in that
// alias every command pays a full handshake — several hundred milliseconds
// each, on every preview frame and every click. The guide asks people to add
// the block; nothing checked, and the ones who missed it saw a computer that
// "connected but was slow". This module makes the alias irrelevant: a config
// that includes theirs first (so anything they set still wins) and fills in
// connection sharing and fail-fast timeouts, plus an `ssh` shim docker finds
// ahead of the real one that points at that config.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const VPS_SSH_DIR = "ssh";

function findExecutable(name: string, pathValue: string, exclude: string): string | null {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || dir === exclude) continue;
    const candidate = join(dir, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function writeIfChanged(path: string, content: string, mode: number): void {
  try { if (readFileSync(path, "utf8") === content) { chmodSync(path, mode); return; } } catch { /* absent or unreadable: rewrite */ }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

/** The ssh_config the app hands to every VPS SSH connection. The person's own
 * file is included first: ssh keeps the first value it sees for an option, so
 * an alias that already sets ControlMaster or a timeout keeps its settings and
 * these lines only fill what it leaves unset. `-F` also skips the system file,
 * so that is included last for the same reason. */
export function vpsSshConfigText(sshDir: string, userConfig = join(homedir(), ".ssh", "config"), systemConfig = "/etc/ssh/ssh_config"): string {
  return [
    "# Written by OpenMausBot for its VPS computer connections. Do not edit;",
    "# it is regenerated. Your own ~/.ssh/config is included first and wins.",
    ...(existsSync(userConfig) ? [`Include ${userConfig}`] : []),
    "Host *",
    "  ControlMaster auto",
    `  ControlPath ${join(sshDir, "cm-%C")}`,
    "  ControlPersist 10m",
    "  ServerAliveInterval 15",
    "  ServerAliveCountMax 3",
    "  ConnectTimeout 10",
    ...(existsSync(systemConfig) ? [`Include ${systemConfig}`] : []),
    "",
  ].join("\n");
}

export interface VpsSshSetup {
  /** ssh_config to pass with -F, or null when the platform has no sharing. */
  configPath: string | null;
  /** PATH for a docker child: the shim directory first, when installed. */
  path: string;
}

/** Prepare the shared-connection config and the `ssh` shim under the data
 * directory, and return the PATH a docker or ssh child should run with.
 * Windows OpenSSH has no ControlMaster, so there everything stays as it was. */
export function prepareVpsSsh(dataDir: string, pathValue: string, platform: NodeJS.Platform = process.platform): VpsSshSetup {
  if (platform === "win32") return { configPath: null, path: pathValue };
  const sshDir = join(dataDir, VPS_SSH_DIR);
  const binDir = join(sshDir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  chmodSync(sshDir, 0o700);
  const configPath = join(sshDir, "config");
  writeIfChanged(configPath, vpsSshConfigText(sshDir), 0o600);
  const realSsh = findExecutable("ssh", pathValue, binDir);
  if (!realSsh) return { configPath, path: pathValue };
  const shim = [
    "#!/bin/sh",
    "# Written by OpenMausBot. docker's SSH transport finds this ssh first, so",
    "# every VPS command shares one connection whether or not the alias says so.",
    `exec ${JSON.stringify(realSsh)} -F ${JSON.stringify(configPath)} "$@"`,
    "",
  ].join("\n");
  writeIfChanged(join(binDir, "ssh"), shim, 0o700);
  return { configPath, path: `${binDir}${delimiter}${pathValue}` };
}
