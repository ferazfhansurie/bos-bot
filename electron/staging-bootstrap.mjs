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
  process.env.OMB_DATA_DIR = data;
  process.env.OMB_COMPANION_DIR = path.join(data, "companion");
  process.env.OMB_COMPANION_NAME = "BOS Staging";
  process.env.OMB_DISABLE_LEGACY_MIGRATION = "1";
  // Explicitly override inherited routing variables from a live shell.
  delete process.env.OMB_WEBHOOK_PORT;
  delete process.env.OGB_PORT;
}
