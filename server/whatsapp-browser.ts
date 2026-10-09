import { compatEnv, compatEnvironment } from "../electron/branding-env.cjs";
// Which Chrome/Chromium the native WhatsApp client drives.
//
// puppeteer's own downloaded Chromium usually does not exist: the packaged
// app ships no node_modules and installs skip puppeteer's postinstall. So:
//   1. OMB_WHATSAPP_CHROME_PATH (explicit override)
//   2. an installed Google Chrome (then Chromium)
//   3. the desktop app's bundled chrome-headless-shell (Resources/browser-engine)
//   4. a Chrome for Testing that puppeteer downloaded into its cache
// and null — reported on the tile — when none exists.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { browserBundlePaths } from "./browser-bundle-release.ts";

export type BrowserSource = "env" | "google-chrome" | "chromium" | "bundled-headless-shell" | "puppeteer";

export interface BrowserResolution {
  path: string;
  source: BrowserSource;
}

export interface BrowserLookup {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

function installedCandidates(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): Array<[string, BrowserSource]> {
  if (platform === "darwin") {
    return [
      ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome"],
      [join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), "google-chrome"],
      ["/Applications/Chromium.app/Contents/MacOS/Chromium", "chromium"],
      [join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"), "chromium"],
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
    return roots.map((root) => [join(root, "Google", "Chrome", "Application", "chrome.exe"), "google-chrome"] as [string, BrowserSource]);
  }
  return [
    ["/usr/bin/google-chrome", "google-chrome"],
    ["/usr/bin/google-chrome-stable", "google-chrome"],
    ["/usr/bin/chromium", "chromium"],
    ["/usr/bin/chromium-browser", "chromium"],
  ];
}

const PUPPETEER_EXECUTABLES: Record<string, string[]> = {
  darwin: [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  linux: ["chrome-linux64/chrome"],
  win32: ["chrome-win64/chrome.exe"],
};

export function resolveWhatsAppBrowser(lookup: BrowserLookup = {}): BrowserResolution | null {
  const env = compatEnvironment(lookup.env ?? compatEnv);
  const platform = lookup.platform ?? process.platform;
  const arch = lookup.arch ?? process.arch;
  const home = lookup.home ?? homedir();
  const exists = lookup.exists ?? existsSync;
  const listDir = lookup.listDir ?? ((path: string) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  });

  const override = env.OMB_WHATSAPP_CHROME_PATH?.trim();
  // An override that points nowhere is reported, not silently replaced: the
  // person set it for a reason and should see why it did not take.
  if (override) return exists(override) ? { path: override, source: "env" } : null;

  for (const [path, source] of installedCandidates(platform, home, env)) {
    if (exists(path)) return { path, source };
  }

  if (env.OMB_RESOURCES_PATH) {
    try {
      const bundle = browserBundlePaths(join(resolve(env.OMB_RESOURCES_PATH), "browser-engine"), `${platform}-${arch}`);
      if (exists(bundle.chrome)) return { path: bundle.chrome, source: "bundled-headless-shell" };
    } catch {
      // no desktop bundle for this platform/architecture
    }
  }

  const cache = env.PUPPETEER_CACHE_DIR?.trim() || join(home, ".cache", "puppeteer");
  const chromeDir = join(cache, "chrome");
  for (const version of listDir(chromeDir).sort().reverse()) {
    for (const relative of PUPPETEER_EXECUTABLES[platform] ?? []) {
      const path = join(chromeDir, version, relative);
      if (exists(path)) return { path, source: "puppeteer" };
    }
  }
  return null;
}

export function noBrowserReason(env: NodeJS.ProcessEnv = compatEnv): string {
  env = compatEnvironment(env);
  const override = env.OMB_WHATSAPP_CHROME_PATH?.trim();
  return override
    ? `OMB_WHATSAPP_CHROME_PATH points to ${override}, which does not exist.`
    : "No Chrome or Chromium was found. Install Google Chrome, or set OMB_WHATSAPP_CHROME_PATH.";
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
