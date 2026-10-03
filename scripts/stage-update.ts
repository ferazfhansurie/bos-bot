#!/usr/bin/env -S node --experimental-strip-types
// Stage a built BOS Bot.app as the update candidate the in-app Update button
// applies. Copies the bundle into <dataDir>/updates/candidate and writes the
// hash manifest. Does not touch the live app.
//
//   node --experimental-strip-types scripts/stage-update.ts <path/to/BOS Bot.app> --version 0.1.86 --sha <git sha> [--data-dir ~/.bos-bot]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { writeCandidateManifest } from "../server/updater.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const source = args.find(a => !a.startsWith("--") && a.endsWith(".app"));
if (!source || !existsSync(join(source, "Contents"))) { console.error("usage: stage-update.ts <BOS Bot.app> --version X --sha Y [--data-dir DIR]"); process.exit(2); }
const dataDir = resolve(flag("data-dir") ?? process.env.OMB_DATA_DIR ?? join(homedir(), ".bos-bot"));
const version = flag("version") ?? (() => {
  const plist = readFileSync(join(source, "Contents", "Info.plist"), "utf8");
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
})();
const sha = flag("sha") ?? (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return undefined; } })();
if (!version || !sha) { console.error("need --version and --sha (or an Info.plist version and a git checkout)"); process.exit(2); }

const dir = join(dataDir, "updates", "candidate");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const target = join(dir, basename(source));
if (process.platform === "darwin") execFileSync("/usr/bin/ditto", [source, target], { stdio: "inherit" }); // keeps signatures and symlinks
else cpSync(source, target, { recursive: true, verbatimSymlinks: true });
const manifest = writeCandidateManifest(dir, { version, sha, app: basename(source) });
console.log(JSON.stringify({ staged: target, ...manifest }, null, 2));
