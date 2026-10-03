// The darwin side of the updater: launchd, lsof and ps, as the coordinator
// needs them. Everything here is read-only except bootstrap/bootout of our
// own one-shot update jobs.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdaterHost } from "./updater.ts";

function run(file: string, args: string[], okCodes: number[] = [0]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      if (error && !okCodes.includes(code)) return reject(new Error(`${file} ${args.join(" ")} failed (${code}): ${String(stderr).trim().slice(0, 300)}`));
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function listeners(port: number): Promise<number[]> {
  // lsof exits 1 with no output when nothing listens.
  const { stdout } = await run("/usr/sbin/lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], [0, 1]);
  return stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

/** Same shape the detached script computes: `lstart` tokens, then args. */
export function processIdentity(psLine: string): string | null {
  const match = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(psLine);
  return match ? `${match.slice(1, 6).join(" ")} ${match[6]}` : null;
}

export function createDarwinUpdaterHost(options: { dataDir: string; port: number; extraPorts?: number[] }): UpdaterHost {
  return {
    async launchdList() {
      const { stdout } = await run("/bin/launchctl", ["list"]);
      return stdout;
    },
    async bootstrap(uid, plistPath) {
      if (uid === null) throw new Error("no uid for launchctl bootstrap");
      await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    },
    async bootout(uid, label) {
      if (uid === null) throw new Error("no uid for launchctl bootout");
      await run("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], [0, 3, 113]);
    },
    async listeningPorts() {
      const ports = [options.port];
      for (const port of options.extraPorts ?? []) if ((await listeners(port)).length) ports.push(port);
      return ports;
    },
    async appProcess() {
      let pid: number | null = null;
      try {
        const lifecycle = JSON.parse(readFileSync(join(options.dataDir, "desktop-lifecycle.json"), "utf8")) as { pid?: unknown };
        if (Number.isSafeInteger(lifecycle.pid) && (lifecycle.pid as number) > 0) pid = lifecycle.pid as number;
      } catch { /* not desktop managed */ }
      pid ??= process.ppid > 1 ? process.ppid : null;
      if (pid === null) return { pid: null, identity: null };
      const { stdout } = await run("/bin/ps", ["-ww", "-o", "lstart=,args=", "-p", String(pid)], [0, 1]);
      return { pid, identity: processIdentity(stdout.trimEnd()) };
    },
  };
}
