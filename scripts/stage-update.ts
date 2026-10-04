#!/usr/bin/env -S node --experimental-strip-types
// Stage a built BOS Bot.app as the update candidate the in-app Update button
// applies. The no-downgrade guard judges the bundle FIRST, with the same
// `check` the updater runs at admission and again inside apply.py: an
// unstamped, older, sibling, off-release or non-prod bundle is refused (exit
// 2) and nothing is written. --rollback is the only exception and admits only
// the bundle byte-identical to the ledger's previously-live build. Then the
// bundle is copied into <dataDir>/updates/candidate and the hash manifest is
// written. Never touches the live app.
//
//   node --experimental-strip-types scripts/stage-update.ts <path/to/BOS Bot.app> --version 0.1.86 --sha <git sha>
//        [--data-dir ~/.bos-bot] [--live "/Applications/BOS Bot.app"] [--rollback]
//        [--guard electron/resources/updater/no-downgrade.py] [--repo DIR] [--release-branch NAME] [--prod-branch NAME]
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCandidateManifest } from "../server/updater.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const source = args.find(a => !a.startsWith("--") && a.endsWith(".app"));
if (!source || !existsSync(join(source, "Contents"))) { console.error("usage: stage-update.ts <BOS Bot.app> --version X --sha Y [--data-dir DIR] [--live APP] [--rollback]"); process.exit(2); }
const dataDir = resolve(flag("data-dir") ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".bos-bot"));
const version = flag("version") ?? (() => {
  const plist = readFileSync(join(source, "Contents", "Info.plist"), "utf8");
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
})();
const sha = flag("sha") ?? (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return undefined; } })();
if (!version || !sha) { console.error("need --version and --sha (or an Info.plist version and a git checkout)"); process.exit(2); }

// 1. the guard. The repo's copy of the script, not the candidate's: a bundle
// must not get to bring its own judge.
const here = dirname(fileURLToPath(import.meta.url));
const guardScript = flag("guard") ?? join(here, "..", "electron", "resources", "updater", "no-downgrade.py");
if (!existsSync(guardScript)) { console.error(`no-downgrade guard missing at ${guardScript}; refusing to stage`); process.exit(1); }
const live = flag("live") ?? process.env.OMB_UPDATER_LIVE_APP ?? "/Applications/BOS Bot.app";
const rollback = args.includes("--rollback");
const guardArgs = [guardScript, "check", "--candidate", resolve(source), "--live", live, "--ledger", join(dataDir, "updates", "live-build.json")];
if (rollback) guardArgs.push("--rollback");
for (const name of ["repo", "release-branch", "prod-branch"]) { const value = flag(name); if (value !== undefined) guardArgs.push(`--${name}`, value); }
const run = spawnSync(flag("python") ?? "/usr/bin/python3", guardArgs, { encoding: "utf8" });
let verdict: { ok?: boolean; reason?: string; candidate?: { commit?: string | null } } = {};
try { verdict = JSON.parse(run.stdout) as typeof verdict; } catch { verdict = {}; }
const reason = verdict.reason ?? (run.stderr.trim().slice(0, 300) || "no output");
if (run.status === 2) { console.error(`REFUSED: ${reason}`); process.exit(2); }
if (run.status !== 0 || verdict.ok !== true) { console.error(`no-downgrade guard failed (exit ${run.status ?? "signal"}): ${reason}`); process.exit(1); }
const judged = verdict.candidate?.commit;
if (judged && !judged.startsWith(sha)) { console.error(`REFUSED: --sha ${sha} contradicts the bundle's commit ${judged} (${rollback ? "ledger history" : "its stamp"})`); process.exit(2); }
console.error(`ok: ${reason}`);

// 2. stage.
const dir = join(dataDir, "updates", "candidate");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const target = join(dir, basename(source));
if (process.platform === "darwin") execFileSync("/usr/bin/ditto", [source, target], { stdio: "inherit" }); // keeps signatures and symlinks
else cpSync(source, target, { recursive: true, verbatimSymlinks: true });
const manifest = writeCandidateManifest(dir, { version, sha, app: basename(source) });
console.log(JSON.stringify({ staged: target, ...manifest }, null, 2));
