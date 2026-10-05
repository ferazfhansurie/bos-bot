// Local package-to-updater adapter; no installation or app control.
// node --experimental-strip-types server/stage-full-update.ts DATA_DIR PACKAGE_APP LIVE_APP
import { join, resolve } from "node:path";
import { readUpdateSource, resolveUpdateTarget, stageFullCandidate } from "./updater-build.ts";

const [dataArg, packageArg, liveArg, ...extra] = process.argv.slice(2);
if (!dataArg || !packageArg || !liveArg || extra.length) throw new Error("usage: stage-full-update.ts DATA_DIR PACKAGE_APP LIVE_APP");
const dataDir = resolve(dataArg);
const appPath = resolve(packageArg);
const liveApp = resolve(liveArg);
if (appPath === liveApp) throw new Error("stage a separately packaged candidate, not the installed app");
const source = readUpdateSource(dataDir);
const target = await resolveUpdateTarget(source);
const manifest = await stageFullCandidate({ dataDir, appPath, liveApp, source, target,
  script: join(liveApp, "Contents", "Resources", "updater", "no-downgrade.py"),
  ledger: join(dataDir, "updates", "live-build.json"), current: { version: "unknown", sha: "unknown" } });
console.log(JSON.stringify({ staged: manifest, installed: false }));
