import { compatEnv } from "./branding-env.cjs";
// First dependency of main: isolate paths before imports capture Electron state.
import { app } from "electron";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { STAGING } from "./release-channel.mjs";
if (STAGING) {
  const home = app.getPath("home");
  const data = path.join(home, ".bos-bot-staging");
  const userData = path.join(app.getPath("appData"), "BOS Staging");
  for (const target of [data, userData]) {
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error("Staging data path must not be a symbolic link");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  app.setName("BOS Staging");
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  app.setAppLogsPath(path.join(userData, "logs"));
  compatEnv.OMB_DATA_DIR = data;
  compatEnv.OMB_COMPANION_DIR = path.join(data, "companion");
  compatEnv.OMB_COMPANION_NAME = "BOS Staging";
  compatEnv.OMB_DISABLE_LEGACY_MIGRATION = "1";
  // Explicitly override inherited routing variables from a live shell.
  delete compatEnv.OMB_WEBHOOK_PORT;
  delete compatEnv.OGB_PORT;
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
