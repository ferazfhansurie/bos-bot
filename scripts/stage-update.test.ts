// scripts/stage-update.ts: the hand-run staging door. The shipped
// no-downgrade guard judges the bundle before anything is copied; a refusal
// writes nothing. Driven as a child process, the way an operator runs it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appDigests } from "../server/updater.ts";
import { fakeBundle, guard, hasPython, makeGuardRepo, recordRunning, type GuardRepo } from "../server/testing/no-downgrade-fixture.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "stage-update.ts");

describe.skipIf(!hasPython)("stage-update runs the no-downgrade guard before staging", () => {
  let root: string; let repo: GuardRepo; let live: string; let dataDir: string;
  const candidateDir = () => join(dataDir, "updates", "candidate");
  const stage = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, "--data-dir", dataDir, "--live", live, "--repo", repo.dir, "--release-branch", "release/bos-1.0"], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bos-stage-update-"));
    repo = makeGuardRepo(root);
    live = fakeBundle(join(root, "Applications"), "BOS Bot.app", "live-B");
    dataDir = join(root, "data");
    recordRunning(live, repo.b, join(dataDir, "updates", "live-build.json"), repo);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function untouched(source: string) {
    expect(existsSync(candidateDir())).toBe(false);
    expect(existsSync(source)).toBe(true);
    expect(appDigests(live)).toEqual(appDigests(fakeBundle(join(root, "ref"), "BOS Bot.app", "live-B")));
  }

  it("refuses an unstamped bundle and writes nothing", () => {
    const source = fakeBundle(join(root, "built"), "BOS Bot.app", "cand");
    const r = stage(source, "--version", "0.1.86", "--sha", repo.c);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED: candidate refused: .* is unstamped; only a build stamped with its source commit/);
    expect(r.stdout).toBe("");
    untouched(source);
  });

  it("refuses an older build (an ancestor of the running commit) and names both commits", () => {
    const source = fakeBundle(join(root, "built"), "BOS Bot.app", "cand-A");
    expect(guard("stamp", "--app", source, "--commit", repo.a).code).toBe(0);
    const r = stage(source, "--version", "0.1.80", "--sha", repo.a);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`REFUSED: downgrade refused: running ${repo.b.slice(0, 8)} is not an ancestor of candidate ${repo.a.slice(0, 8)}`));
    untouched(source);
  });

  it("refuses a --sha that contradicts the bundle's stamp, even for the prod head", () => {
    const source = fakeBundle(join(root, "built"), "BOS Bot.app", "cand-C");
    expect(guard("stamp", "--app", source, "--commit", repo.c).code).toBe(0);
    const r = stage(source, "--version", "0.1.86", "--sha", repo.a);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`REFUSED: --sha ${repo.a} contradicts the bundle's commit ${repo.c} \\(its stamp\\)`));
    untouched(source);
  });

  it("stages the prod head when it is stamped and descends from the running build", () => {
    const source = fakeBundle(join(root, "built"), "BOS Bot.app", "cand-C");
    expect(guard("stamp", "--app", source, "--commit", repo.c).code).toBe(0);
    const r = stage(source, "--version", "0.1.86", "--sha", repo.c.slice(0, 12));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(new RegExp(`ok: allowed: candidate ${repo.c.slice(0, 8)} descends from running ${repo.b.slice(0, 8)}, is on release/bos-1.0 and is the prod head`));
    const out = JSON.parse(r.stdout) as { staged: string; version: string; sha: string; serverSha256: string };
    expect(out).toMatchObject({ staged: join(candidateDir(), "BOS Bot.app"), version: "0.1.86", sha: repo.c.slice(0, 12), serverSha256: appDigests(source).server });
    expect(appDigests(out.staged)).toEqual(appDigests(source));
    expect(JSON.parse(readFileSync(join(candidateDir(), "manifest.json"), "utf8"))).toMatchObject({ version: "0.1.86", app: "BOS Bot.app" });
    expect(existsSync(source)).toBe(true); // copied, not moved
  });

  it("--rollback admits only the byte-identical previously-live build; without the flag the same bundle is an unstamped downgrade", () => {
    // C went live after B: the ledger now has C live and B in history
    const liveC = fakeBundle(join(root, "Applications2"), "BOS Bot.app", "live-C");
    expect(guard("stamp", "--app", liveC, "--commit", repo.c).code).toBe(0);
    expect(guard("record", "--live", liveC, "--ledger", join(dataDir, "updates", "live-build.json")).code).toBe(0);
    live = liveC;
    const backup = fakeBundle(join(root, "backup"), "BOS Bot.app", "live-B"); // same trees as the old live bundle
    const no = stage(backup, "--version", "0.1.85", "--sha", repo.b);
    expect(no.status).toBe(2); expect(no.stderr).toMatch(/REFUSED: candidate refused: .* is unstamped/);
    expect(existsSync(candidateDir())).toBe(false);
    const ok = stage(backup, "--version", "0.1.85", "--sha", repo.b, "--rollback");
    expect(ok.status).toBe(0);
    expect(ok.stderr).toMatch(/ok: rollback allowed: candidate is the previously-live build/);
    expect(appDigests(join(candidateDir(), "BOS Bot.app"))).toEqual(appDigests(backup));
    // an even older build is not "previous"
    const older = fakeBundle(join(root, "older"), "BOS Bot.app", "live-A");
    const far = stage(older, "--version", "0.1.84", "--sha", repo.a, "--rollback");
    expect(far.status).toBe(2); expect(far.stderr).toMatch(/REFUSED: rollback refused: .* is not the previously-live build/);
  });

  it("a missing guard script refuses to stage at all", () => {
    const source = fakeBundle(join(root, "built"), "BOS Bot.app", "cand-C");
    expect(guard("stamp", "--app", source, "--commit", repo.c).code).toBe(0);
    const r = stage(source, "--version", "0.1.86", "--sha", repo.c, "--guard", join(root, "nope.py"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no-downgrade guard missing at .*nope\.py; refusing to stage/);
    untouched(source);
  });
});
