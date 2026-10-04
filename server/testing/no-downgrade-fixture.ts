// Shared by the suites that drive the shipped no-downgrade guard: a
// throwaway git repo (A → B → C on release/bos-1.0, prod at C, S a child of B
// beside C, T a child of A beside B), fake app bundles with server/ui trees,
// and a runner for electron/resources/updater/no-downgrade.py.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PYTHON = "/usr/bin/python3";
export const GUARD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "electron", "resources", "updater", "no-downgrade.py");
export const hasPython = existsSync(PYTHON) && spawnSync(PYTHON, ["--version"]).status === 0;

export interface GuardRepo { dir: string; a: string; b: string; c: string; s: string; t: string }

export function makeGuardRepo(root: string): GuardRepo {
  const dir = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env }).trim();
  g("init", "-q", "-b", "release/bos-1.0");
  const commit = (msg: string) => { writeFileSync(join(dir, "f.txt"), msg); g("add", "f.txt"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
  const a = commit("A"); const b = commit("B"); const c = commit("C");
  g("checkout", "-q", "-b", "sibling", b);
  const s = commit("S");
  g("checkout", "-q", "-b", "older-sibling", a);
  const t = commit("T");
  g("checkout", "-q", "release/bos-1.0");
  g("branch", "prod", c);
  return { dir, a, b, c, s, t };
}

/** A bundle with server and ui trees whose bytes follow `stamp`, and a
 * Contents/MacOS binary (a no-op shell script unless given). */
export function fakeBundle(root: string, name: string, stamp: string, binary = "#!/bin/sh\nexit 0\n"): string {
  const app = join(root, name);
  mkdirSync(join(app, "Contents", "Resources", "server"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "ui"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "server", "index.js"), `// ${stamp}\n`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "index.html"), `<html>${stamp}</html>`);
  writeFileSync(join(app, "Contents", "MacOS", "BOS Bot"), binary, { mode: 0o755 });
  writeFileSync(join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>0.1.86</string></dict></plist>\n`);
  return app;
}

export interface GuardVerdict { ok: boolean; reason: string; running?: { commit: string; source: string }; candidate?: { commit: string | null; source: string | null }; live?: { commit: string } }

/** Run the shipped guard. Throws when it prints no json (a crash, not a verdict). */
export function guard(...args: string[]): { code: number; out: GuardVerdict; err: string } {
  const r = spawnSync(PYTHON, [GUARD_SCRIPT, ...args], { encoding: "utf8" });
  let out: GuardVerdict;
  try { out = JSON.parse(r.stdout) as GuardVerdict; } catch { throw new Error(`guard printed no json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); }
  return { code: r.status ?? -1, out, err: r.stderr };
}

/** Seed the ledger: `live` is the running build of `commit`, judged against `repo`. */
export function recordRunning(live: string, commit: string, ledger: string, repo: GuardRepo): void {
  const r = guard("record", "--live", live, "--commit", commit, "--ledger", ledger, "--repo", repo.dir, "--release-branch", "release/bos-1.0");
  if (r.code !== 0) throw new Error(`record failed: ${r.out.reason}`);
}
