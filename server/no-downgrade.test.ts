// electron/resources/updater/no-downgrade.py: the install guard the darwin
// executor runs on a staged bundle. Driven here as the shipped script, with a
// throwaway git repo (A → B → C on release, S a child of B beside C, T a
// child of A beside B) and fake bundles.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDigests } from "./updater.ts";

const PYTHON = "/usr/bin/python3";
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "electron", "resources", "updater", "no-downgrade.py");
const hasPython = existsSync(PYTHON) && spawnSync(PYTHON, ["--version"]).status === 0;

interface Verdict { ok: boolean; reason: string; running?: { commit: string; source: string }; candidate?: { commit: string | null; source: string | null }; live?: { commit: string }; previous?: { commit: string } | null }

function run(...args: string[]): { code: number; out: Verdict; err: string } {
  const r = spawnSync(PYTHON, [SCRIPT, ...args], { encoding: "utf8" });
  let out: Verdict;
  try { out = JSON.parse(r.stdout) as Verdict; } catch { throw new Error(`guard printed no json (exit ${r.status}): ${r.stdout}\n${r.stderr}`); }
  return { code: r.status ?? -1, out, err: r.stderr };
}

function fakeApp(root: string, name: string, stamp: string): string {
  const app = join(root, name);
  mkdirSync(join(app, "Contents", "Resources", "server", "nested"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources", "ui", "assets"), { recursive: true });
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "Resources", "server", "index.js"), `// ${stamp}\n`);
  writeFileSync(join(app, "Contents", "Resources", "server", "nested", "a.js"), `// ${stamp} nested\n`);
  // a-b sorts before a/b as strings but after it as path parts: the digest order must be the string one
  writeFileSync(join(app, "Contents", "Resources", "server", "nested-x.js"), `// ${stamp} sibling\n`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "index.html"), `<html>${stamp}</html>`);
  writeFileSync(join(app, "Contents", "Resources", "ui", "assets", "app.js"), `console.log(${JSON.stringify(stamp)})`);
  writeFileSync(join(app, "Contents", "MacOS", "BOS Bot"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return app;
}

interface Repo { dir: string; a: string; b: string; c: string; s: string; t: string }

function makeRepo(root: string): Repo {
  const dir = join(root, "repo");
  mkdirSync(dir);
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
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

describe.skipIf(!hasPython)("no-downgrade guard", () => {
  let root: string; let repo: Repo; let live: string; let ledger: string;
  const common = () => ["--ledger", ledger, "--repo", repo.dir, "--release-branch", "release/bos-1.0"];
  const check = (candidate: string, ...extra: string[]) => run("check", "--candidate", candidate, "--live", live, ...common(), ...extra);
  const stamp = (app: string, commit: string) => run("stamp", "--app", app, "--commit", commit);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-no-downgrade-"));
    repo = makeRepo(root);
    live = fakeApp(join(root, "Applications"), "BOS Bot.app", "live-B");
    ledger = join(root, "data", "updates", "live-build.json");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("hashes the server and ui trees exactly like the TypeScript updater", () => {
    const app = fakeApp(root, "Digest.app", "digest");
    const r = stamp(app, repo.a);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(app, "Contents", "Resources", "build-commit.json"), "utf8")) as { server_sha256: string; ui_sha256: string; commit: string };
    const ts = appDigests(app);
    expect(written).toMatchObject({ commit: repo.a, server_sha256: ts.server, ui_sha256: ts.ui });
  });

  it("refuses everything until the running build is recorded, then records an unstamped live bundle only with its commit", () => {
    const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
    const first = check(cand);
    expect(first.code).toBe(2);
    expect(first.out.reason).toMatch(/running build unknown.*unstamped.*record the running build first/);
    const bare = run("record", "--live", live, ...common());
    expect(bare.code).toBe(2); expect(bare.out.reason).toMatch(/pass --commit/);
    const seeded = run("record", "--live", live, "--commit", repo.b, ...common());
    expect(seeded.code).toBe(0); expect(seeded.out.live?.commit).toBe(repo.b); expect(seeded.out.previous).toBeNull();
    // the ledger now carries repo/branch: later calls need neither
    const again = run("check", "--candidate", cand, "--live", live, "--ledger", ledger);
    expect(again.code).toBe(0); expect(again.out.reason).toMatch(/allowed: candidate .{8} descends from running .{8}, is on release\/bos-1.0 and is the prod head/);
    expect(again.out.running).toMatchObject({ commit: repo.b, source: "ledger" });
  });

  describe("with the running build recorded as B", () => {
    beforeEach(() => { expect(run("record", "--live", live, "--commit", repo.b, ...common()).code).toBe(0); });

    it("refuses an unstamped candidate", () => {
      const cand = fakeApp(root, "Cand.app", "cand-C");
      const r = check(cand);
      expect(r.code).toBe(2); expect(r.out.reason).toMatch(/candidate refused: .* is unstamped; only a build stamped with its source commit/);
    });

    it("refuses a stamp whose trees were swapped after stamping", () => {
      const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
      writeFileSync(join(cand, "Contents", "Resources", "server", "index.js"), "// something else\n");
      const r = check(cand);
      expect(r.code).toBe(2); expect(r.out.reason).toMatch(/stamped .{8} but its server\/ui trees were changed after stamping/);
    });

    it("refuses an older build (the running commit's ancestor) and names both commits", () => {
      const cand = fakeApp(root, "Cand.app", "cand-A"); stamp(cand, repo.a);
      const r = check(cand);
      expect(r.code).toBe(2);
      expect(r.out.reason).toBe(`downgrade refused: running ${repo.b.slice(0, 8)} is not an ancestor of candidate ${repo.a.slice(0, 8)} (older build, or a sibling branch). only a descendant of the running build may be installed.`);
    });

    it("refuses a sibling of the running build even when it is newer in time", () => {
      const cand = fakeApp(root, "Cand.app", "cand-T"); stamp(cand, repo.t);
      const r = check(cand);
      expect(r.code).toBe(2); expect(r.out.reason).toMatch(/^downgrade refused/);
    });

    it("refuses a newer release commit that prod has not been moved to", () => {
      execFileSync("git", ["-C", repo.dir, "branch", "-f", "prod", repo.b]);
      const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
      const r = check(cand);
      expect(r.code).toBe(2);
      expect(r.out.reason).toBe(`candidate refused: ${repo.c.slice(0, 8)} is not what prod points at (${repo.b.slice(0, 8)}); only the accepted prod build goes live (running ${repo.b.slice(0, 8)})`);
      // the prod check is the policy; "" turns it off, a missing prod branch fails closed
      expect(check(cand, "--prod-branch", "").code).toBe(0);
      execFileSync("git", ["-C", repo.dir, "branch", "-D", "prod"]);
      const gone = check(cand);
      expect(gone.code).toBe(2); expect(gone.out.reason).toMatch(/prod branch prod not found/);
    });

    it("allows a prod ancestor when every later prod commit only touched ios/, and refuses it once one did not", () => {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const g = (...args: string[]) => execFileSync("git", ["-C", repo.dir, ...args], { encoding: "utf8", env }).trim();
      const touch = (file: string) => { mkdirSync(dirname(join(repo.dir, file)), { recursive: true }); writeFileSync(join(repo.dir, file), file); g("add", file); g("commit", "-q", "-m", file); const head = g("rev-parse", "HEAD"); g("branch", "-f", "prod", head); return head; };
      const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
      touch("ios/App/Mascot.swift");
      expect(check(cand).code).toBe(0);
      const d = touch("server/index.ts");
      const r = check(cand);
      expect(r.code).toBe(2);
      expect(r.out.reason).toMatch(`is not what prod points at (${d.slice(0, 8)})`);
    });

    it("refuses a commit that is on prod but not on the release branch", () => {
      execFileSync("git", ["-C", repo.dir, "branch", "-f", "prod", repo.s]);
      // S descends from the running B, so the ancestor check passes; the release check is what refuses it
      const cand = fakeApp(root, "Cand.app", "cand-S"); stamp(cand, repo.s);
      const r = check(cand);
      expect(r.code).toBe(2); expect(r.out.reason).toMatch(/is not reachable from release\/bos-1.0/);
    });

    it("allows the prod head when it descends from the running build and is on release, and records it afterwards", () => {
      const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
      const r = check(cand);
      expect(r.code).toBe(0);
      expect(r.out).toMatchObject({ ok: true, running: { commit: repo.b, source: "ledger" }, candidate: { commit: repo.c, source: "stamp" } });
      // the swap happened: the candidate is live now, stamped, so record needs no --commit
      const rec = run("record", "--live", cand, "--ledger", ledger);
      expect(rec.code).toBe(0);
      const body = JSON.parse(readFileSync(ledger, "utf8")) as { live: { commit: string; source: string }; history: Array<{ commit: string }> };
      expect(body.live).toMatchObject({ commit: repo.c, source: "stamp" });
      expect(body.history.map(h => h.commit)).toEqual([repo.b]);
      // now the old bundle is a downgrade
      const back = run("check", "--candidate", live, "--live", cand, "--ledger", ledger);
      expect(back.code).toBe(2); expect(back.out.reason).toMatch(/is unstamped/);
    });

    it("allows the running commit rebuilt (not a downgrade), and refuses a stamp the repo does not know", () => {
      const same = fakeApp(root, "Same.app", "rebuilt-B"); stamp(same, repo.b);
      execFileSync("git", ["-C", repo.dir, "branch", "-f", "prod", repo.b]);
      const r = check(same);
      expect(r.code).toBe(0); expect(r.out.reason).toMatch(/is the running commit rebuilt/);
      const alien = fakeApp(root, "Alien.app", "alien"); stamp(alien, "f".repeat(40));
      const bad = check(alien);
      expect(bad.code).toBe(2); expect(bad.out.reason).toMatch(/is not in .*fetch it first/);
    });

    it("rollback: only the byte-identical previously-live build may come back", () => {
      const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
      expect(run("record", "--live", cand, "--ledger", ledger).code).toBe(0);
      // a backup copy of the old live bundle has the same trees
      const backup = fakeApp(root, "Backup.app", "live-B");
      const ok = run("check", "--candidate", backup, "--live", cand, "--ledger", ledger, "--rollback");
      expect(ok.code).toBe(0); expect(ok.out.reason).toMatch(/rollback allowed: candidate is the previously-live build/);
      expect(ok.out.candidate).toMatchObject({ commit: repo.b, source: "ledger-history" });
      // an even older build is not "previous"; neither is a tampered backup
      const older = fakeApp(root, "Older.app", "live-A");
      const no = run("check", "--candidate", older, "--live", cand, "--ledger", ledger, "--rollback");
      expect(no.code).toBe(2); expect(no.out.reason).toMatch(/rollback refused: .* is not the previously-live build/);
      // and without --rollback the backup is just an unstamped downgrade
      expect(run("check", "--candidate", backup, "--live", cand, "--ledger", ledger).code).toBe(2);
    });

    it("record refuses a --commit that contradicts the bundle's own stamp, and a commit the repo lacks", () => {
      const cand = fakeApp(root, "Cand.app", "cand-C"); stamp(cand, repo.c);
      const lie = run("record", "--live", cand, "--commit", repo.a, "--ledger", ledger);
      expect(lie.code).toBe(2); expect(lie.out.reason).toMatch(/contradicts the bundle's own stamp/);
      const unknown = run("record", "--live", live, "--commit", "e".repeat(40), "--ledger", ledger);
      expect(unknown.code).toBe(2); expect(unknown.out.reason).toMatch(/is not in/);
    });
  });

  it("preview answers the update check without a bundle: up to date, newer prod head allowed, older / sibling / non-prod refused", () => {
    const preview = (...extra: string[]) => run("preview", "--live", live, ...common(), ...extra);
    // Nothing recorded yet: the running build is unknown, so nothing is accepted.
    expect(preview("--commit", repo.c)).toMatchObject({ code: 2, out: { ok: false, reason: expect.stringMatching(/running build|record/i) } });
    expect(run("record", "--live", live, "--commit", repo.b, ...common()).code).toBe(0);
    // Running B, prod C: C is the candidate.
    const ahead = preview();
    expect(ahead.code).toBe(0);
    expect(ahead.out).toMatchObject({ ok: true, mode: "preview", up_to_date: false, running: { commit: repo.b, source: "ledger" }, candidate: { commit: repo.c, source: "commit" } });
    expect(preview("--commit", "prod").out).toMatchObject({ ok: true, candidate: { commit: repo.c } });
    // Older (A), sibling (S), the branch head when prod is behind it: refused like check would.
    expect(preview("--commit", repo.a)).toMatchObject({ code: 2, out: { ok: false, reason: expect.stringMatching(/older|ancestor|behind/i) } });
    expect(preview("--commit", repo.s)).toMatchObject({ code: 2, out: { ok: false } });
    expect(preview("--commit", repo.t)).toMatchObject({ code: 2, out: { ok: false } });
    expect(preview("--commit", "no-such-ref")).toMatchObject({ code: 2, out: { ok: false, reason: /not a commit/ } });
    // Running C (= prod head): up to date, still ok.
    expect(run("record", "--live", live, "--commit", repo.c, ...common()).code).toBe(0);
    const same = preview();
    expect(same.code).toBe(0);
    expect(same.out).toMatchObject({ ok: true, up_to_date: true, reason: expect.stringMatching(/up to date/) });
    // Prod check off: a commit must be named; the release head then counts.
    expect(preview("--prod-branch", "")).toMatchObject({ code: 2, out: { ok: false, reason: /needs --commit/ } });
    expect(preview("--prod-branch", "", "--commit", repo.c).out).toMatchObject({ ok: true, up_to_date: true });
    // A prod branch that does not exist accepts nothing.
    expect(preview("--prod-branch", "nope")).toMatchObject({ code: 2, out: { ok: false, reason: /prod branch nope not found/ } });
    // read-only: the live bundle and ledger are untouched by preview
    const ledgerBefore = readFileSync(ledger, "utf8");
    preview("--commit", repo.a);
    expect(readFileSync(ledger, "utf8")).toBe(ledgerBefore);
    expect(existsSync(join(live, "Contents", "Resources", "build-commit.json"))).toBe(false);
  });

  it("never touches the bundles it checks: check is read-only, exit 1 on a bad invocation", () => {
    const before = appDigests(live);
    const r = spawnSync(PYTHON, [SCRIPT, "check", "--candidate", join(root, "nope.app"), "--live", live, ...common()], { encoding: "utf8" });
    expect(r.status).toBe(2); expect(r.stdout).toMatch(/not an app bundle/);
    expect(appDigests(live)).toEqual(before);
    expect(spawnSync(PYTHON, [SCRIPT, "check"], { encoding: "utf8" }).status).toBe(2); // argparse usage error
  });
});
