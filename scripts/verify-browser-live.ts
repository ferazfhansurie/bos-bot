import { compatEnv } from "../electron/branding-env.cjs";
// Actual browser + actual BrowserPanel, always in a disposable fixture HOME.
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";


const binaryPath = compatEnv.OMB_VERIFY_BROWSER_BINARY;
const executablePath = compatEnv.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");
const fixture = await launchVerificationServer(compatEnv, undefined, undefined, { binaryPath, executablePath });
let ui: MountedPreview | undefined;
try {
  await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
  const { bots } = await (await fetch(`${fixture.info.url}/api/bots`)).json() as any;
  await fetch(`${fixture.info.url}/api/config`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ features: { browser: true } }) });
  await fetch(`${fixture.info.url}/api/bots/${bots[0].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ browser: true }) });
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/browser-preview.tsx", route: "/__browser-preview.html", title: "Isolated Browser Preview",
    extraRoutes: [{
      path: "/__browser-test-page",
      handler(_req, res) {
        res.setHeader("content-type", "text/html");
        res.end(readFileSync(new URL("./testing/browser-test-page.html", import.meta.url), "utf8"));
      },
    }],
  });
  console.log(JSON.stringify({ ...fixture.info, botId: bots[0].id, previewUrl: ui.previewUrl, testPage: new URL("/__browser-test-page", ui.previewUrl).href }, null, 2));
  if (process.argv.includes("--recovery")) {
    const { verifyBrowserRecovery } = await import("./testing/browser-recovery-smoke.ts");
    await verifyBrowserRecovery({ binaryPath, executablePath, dataDir: fixture.info.dataDir,
      previewUrl: ui.previewUrl, testPage: new URL("/__browser-test-page", ui.previewUrl).href,
      screenshotPath: fixture.info.logPath.replace(/\.log$/, "-browser.png") });
  } else await parkUntilSignal();
} finally {
  await ui?.close();
  // close --all is scoped to this fixture's HOME, never the operator's.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: compatEnv.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
