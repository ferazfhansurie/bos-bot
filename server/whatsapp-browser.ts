import { compatEnv, compatEnvironment } from "../electron/branding-env.cjs";
// Which Chrome/Chromium the native WhatsApp client drives.
//
// puppeteer's own downloaded Chromium usually does not exist: the packaged
// app ships no node_modules and installs skip puppeteer's postinstall. So:
//   1. OMB_WHATSAPP_CHROME_PATH (explicit override)
//   2. an installed Google Chrome (then Chromium)
//   3. the desktop app's bundled chrome-headless-shell (Resources/browser-engine)
//   4. a chrome-headless-shell or Chrome for Testing in puppeteer's cache
// and null — reported on the tile — when none exists.
//
// On macOS the installed Google Chrome goes last. Running its binary headless
// registers the process as the Chrome app with LaunchServices, so the person's
// own Chrome then refuses to open from the Dock until WhatsApp's copy quits.
// A headless shell or Chrome for Testing is a different app and leaves it alone.
// It is skipped only when it is a major version older than the session
// profile's "Last Version" (a session first made by a newer Chrome), because
// opening a profile with an older Chrome can corrupt it and unlink WhatsApp.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  /** the WhatsApp session's Chrome profile; its "Last Version" gates older browsers */
  profileDir?: string;
  readText?: (path: string) => string | null;
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

const PUPPETEER_HEADLESS_SHELL: Record<string, string[]> = {
  darwin: [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
  ],
  linux: ["chrome-headless-shell-linux64/chrome-headless-shell"],
  win32: ["chrome-headless-shell-win64/chrome-headless-shell.exe"],
};

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
  const readText = lookup.readText ?? ((path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  });

  const override = env.OMB_WHATSAPP_CHROME_PATH?.trim();
  // An override that points nowhere is reported, not silently replaced: the
  // person set it for a reason and should see why it did not take.
  if (override) return exists(override) ? { path: override, source: "env" } : null;

  const profileMajor = majorVersion(lookup.profileDir ? readText(join(lookup.profileDir, "Last Version")) : null);
  // too old for the session profile: opening it would downgrade it
  const tooOld = (version: string | null) => profileMajor !== null && (majorVersion(version) ?? 0) < profileMajor;

  const installed = (): BrowserResolution | null => {
    for (const [path, source] of installedCandidates(platform, home, env)) {
      if (exists(path)) return { path, source };
    }
    return null;
  };

  const bundled = (): BrowserResolution | null => {
    if (!env.OMB_RESOURCES_PATH) return null;
    try {
      const directory = join(resolve(env.OMB_RESOURCES_PATH), "browser-engine");
      const bundle = browserBundlePaths(directory, `${platform}-${arch}`);
      if (!exists(bundle.chrome)) return null;
      if (platform === "darwin" && tooOld(bundledVersion(readText(bundle.manifest)))) return null;
      return { path: bundle.chrome, source: "bundled-headless-shell" };
    } catch {
      // no desktop bundle for this platform/architecture
      return null;
    }
  };

  const cache = env.PUPPETEER_CACHE_DIR?.trim() || join(home, ".cache", "puppeteer");
  const cached = (): BrowserResolution | null => {
    const found: Array<{ path: string; version: string }> = [];
    for (const [folder, executables] of [["chrome-headless-shell", PUPPETEER_HEADLESS_SHELL], ["chrome", PUPPETEER_EXECUTABLES]] as const) {
      const dir = join(cache, folder);
      for (const entry of listDir(dir)) {
        for (const relative of executables[platform] ?? []) {
          const path = join(dir, entry, relative);
          if (exists(path)) found.push({ path, version: entry.replace(/^[^-]*-/, "") });
        }
      }
    }
    found.sort((a, b) => compareVersions(b.version, a.version));
    const usable = found.find((entry) => platform !== "darwin" || !tooOld(entry.version));
    return usable ? { path: usable.path, source: "puppeteer" } : null;
  };

  const order = platform === "darwin" ? [bundled, cached, installed] : [installed, bundled, cached];
  for (const candidate of order) {
    const found = candidate();
    if (found) return found;
  }
  return null;
}

function majorVersion(version: string | null | undefined): number | null {
  const match = version?.trim().match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function bundledVersion(manifest: string | null): string | null {
  try {
    return manifest ? (JSON.parse(manifest)?.chrome?.version ?? null) : null;
  } catch {
    return null;
  }
}

export function noBrowserReason(env: NodeJS.ProcessEnv = compatEnv): string {
  env = compatEnvironment(env);
  const override = env.OMB_WHATSAPP_CHROME_PATH?.trim();
  return override
    ? `OMB_WHATSAPP_CHROME_PATH points to ${override}, which does not exist.`
    : "No Chrome or Chromium was found. Install Google Chrome, or set OMB_WHATSAPP_CHROME_PATH.";
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
