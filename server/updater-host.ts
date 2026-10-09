// The darwin side of the updater: launchd, lsof and ps, as the darwin
// executor needs them. Everything here is read-only except bootstrap/bootout
// of our own one-shot update jobs. `createSandboxUpdaterHost` is the
// test-only stand-in (OMB_UPDATE_SANDBOX=1): plists in a directory instead of
// launchd, a detached child instead of a bootstrapped job.
import { execFile, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LaunchdJobDetails, UpdaterHost } from "./updater.ts";

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

async function identityOf(pid: number): Promise<string | null> {
  const { stdout } = await run("/bin/ps", ["-ww", "-o", "lstart=,args=", "-p", String(pid)], [0, 1]);
  return processIdentity(stdout.trimEnd());
}

/** A plist as JSON, whatever its on-disk encoding. */
async function readPlist(path: string): Promise<Record<string, unknown>> {
  const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  const parsed = JSON.parse(stdout) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** KeepAlive is a bool or a dict of conditions; a dict means "come back"
 * unless it only says SuccessfulExit=false (restart on failure only). */
export function plistJobDetails(plist: Record<string, unknown>): LaunchdJobDetails {
  const keepAliveRaw = plist.KeepAlive;
  const keepAlive = keepAliveRaw && typeof keepAliveRaw === "object"
    ? ((keepAliveRaw as Record<string, unknown>).SuccessfulExit !== false || Object.keys(keepAliveRaw).length > 1)
    : Boolean(keepAliveRaw);
  const args = Array.isArray(plist.ProgramArguments) ? (plist.ProgramArguments as unknown[]).filter((arg): arg is string => typeof arg === "string") : [];
  const program = typeof plist.Program === "string" ? plist.Program : args.join(" ") || null;
  return { keepAlive, runAtLoad: Boolean(plist.RunAtLoad), program };
}

export function createDarwinUpdaterHost(options: { dataDir: string; port: number; extraPorts?: number[] }): UpdaterHost {
  return {
    async launchdList() {
      const { stdout } = await run("/bin/launchctl", ["list"]);
      return stdout;
    },
    async jobDetails(uid, label) {
      if (uid === null) return null;
      const { code, stdout } = await run("/bin/launchctl", ["print", `gui/${uid}/${label}`], [0, 113, 1]);
      if (code !== 0) return null;
      const path = /\n\tpath = (.+)/.exec(stdout)?.[1]?.trim();
      if (!path || !existsSync(path)) return null;
      try { return { ...plistJobDetails(await readPlist(path)), plist: path }; } catch { return null; }
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
      return { pid, identity: await identityOf(pid) };
    },
  };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Test-only. Jobs are `<jobsDir>/*.plist`; a job we started has a
 * `<label>.pid` next to it and shows a pid while that process lives. The
 * app is this process; relaunch is whoever supervises the test harness. */
export function createSandboxUpdaterHost(options: { jobsDir: string; port: number }): UpdaterHost {
  mkdirSync(options.jobsDir, { recursive: true });
  const jobs = async (): Promise<Array<{ label: string; path: string; plist: Record<string, unknown>; pid: number | null }>> => {
    const rows = [];
    for (const name of readdirSync(options.jobsDir).filter(entry => entry.endsWith(".plist")).sort()) {
      const path = join(options.jobsDir, name);
      let plist: Record<string, unknown> = {};
      try { plist = await readPlist(path); } catch { /* unreadable: still a loaded label */ }
      const label = typeof plist.Label === "string" && plist.Label ? plist.Label : basename(name, ".plist");
      let pid: number | null = null;
      try { const recorded = Number(readFileSync(join(options.jobsDir, `${label}.pid`), "utf8")); if (Number.isInteger(recorded) && alive(recorded)) pid = recorded; } catch { /* never started here */ }
      rows.push({ label, path, plist, pid });
    }
    return rows;
  };
  return {
    async launchdList() {
      return ["PID\tStatus\tLabel", ...(await jobs()).map(job => `${job.pid ?? "-"}\t0\t${job.label}`), ""].join("\n");
    },
    async jobDetails(_uid, label) {
      const job = (await jobs()).find(entry => entry.label === label);
      return job ? { ...plistJobDetails(job.plist), plist: job.path } : null;
    },
    async bootstrap(_uid, plistPath) {
      const plist = await readPlist(plistPath);
      const label = String(plist.Label ?? basename(plistPath, ".plist"));
      const args = (plist.ProgramArguments as string[] | undefined) ?? [];
      if (!args.length) throw new Error("plist has no ProgramArguments");
      const out = openSync(String(plist.StandardOutPath ?? "/dev/null"), "a");
      const errFd = openSync(String(plist.StandardErrorPath ?? "/dev/null"), "a");
      try {
        const child = spawn(args[0], args.slice(1), { detached: true, stdio: ["ignore", out, errFd] });
        child.unref();
        writeFileSync(join(options.jobsDir, `${label}.pid`), String(child.pid ?? ""));
        copyFileSync(plistPath, join(options.jobsDir, `${label}.plist`));
      } finally { closeSync(out); closeSync(errFd); }
    },
    async bootout(_uid, label) {
      for (const suffix of [".plist", ".pid"]) { try { unlinkSync(join(options.jobsDir, `${label}${suffix}`)); } catch { /* gone */ } }
    },
    async listeningPorts() { return [options.port]; },
    async appProcess() { return { pid: process.pid, identity: await identityOf(process.pid) }; },
  };
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
