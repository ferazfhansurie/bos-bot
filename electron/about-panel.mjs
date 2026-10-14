import fs from "node:fs";
import path from "node:path";

export function aboutPanelOptions(version, commit) {
  return {
    applicationName: "BOS Bot",
    applicationVersion: version,
    version: /^[0-9a-f]{40}$/.test(commit ?? "") ? commit.slice(0, 8) : "development",
    copyright: "Copyright © 2026 BOS Bot",
    credits: "BOS Bot\nBased on OpenMausBot by Milind Soni and contributors.\nApache License 2.0. Full third-party notices are included with the app.",
    authors: ["BOS Bot"],
    website: "https://bos.aihlete.com",
  };
}

export function configureAboutPanel(app, resourcesPath) {
  let commit;
  try { commit = JSON.parse(fs.readFileSync(path.join(resourcesPath, "build-commit.json"), "utf8")).commit; } catch {}
  const options = aboutPanelOptions(app.getVersion(), commit);
  app.setAboutPanelOptions(options);
  return options;
}
