import { STAGING } from "./release-channel.mjs";
import { readUpdaterCapability } from "./updater-capability.mjs";
// In-app auto-updater (electron-updater). Downloads are user-driven; macOS
// stages the downloaded ZIP immediately and the explicit restart applies it.
// One state object is broadcast on every transition.
//
// Only runs in packaged builds with explicit native policy and valid metadata.
// Staging and local/offline packages never load the vendor. mac auto-update
// requires the signed+notarized app; the 1.0 Windows build is unsigned, and its
// app-update.yml carries no publisherName, so electron-updater installs the
// sha512-verified installer without an Authenticode check (see
// electron-builder.live.cjs). In dev it's a no-op so the browser/dev shell is
// unaffected.
// electron-updater is vendored (electron/vendor/electron-updater.cjs) because
// the packaged app ships no node_modules.
import { app, clipboard, ipcMain } from "electron";
import localOriginModule from "./local-origin.cjs";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  stagedInstallFile,
} from "./package-install-command.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | preparing | downloaded | installing | handed-off | error
let state = { status: "idle" };
let updaterCoordinator = null;
let started = false;
let capability = { available: false, reason: "not-initialized", message: "Native updates are not initialized." };
state = { ...state, capability: capability.reason, available: false };

function unavailableState() {
  setState({ status: "error", available: false, capability: capability.reason, message: capability.message, retryable: false });
  return { ...state };
}

function runUpdateAction(action) {
  if (!capability.available || !updaterCoordinator) return unavailableState();
  return action(updaterCoordinator);
}

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {
      // Logging must never make updating unavailable.
    }
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

// A system package is the distro's to install, not ours. Left to
// electron-updater, a .deb update raises a polkit root prompt out of a chat
// app, runs `dpkg -i` (which resolves no dependencies) and replaces
// /opt/OpenMausBot while this very process is still running.
const HAND_OFF_TYPES = new Set(HAND_OFF_PACKAGE_TYPES);

// Do what this app already does for engine installs: put the exact command on
// the clipboard and open a blank terminal to paste it into. The command is
// never executed for the user, so nothing here becomes a process argument.
export function handOffDownloadedPackage(packageType) {
  return async (files) => {
    const target = stagedInstallFile(files);
    const command = packageInstallCommand(packageType, target);
    clipboard.writeText(command);
    return { command, terminalOpened: await openBlankTerminal() };
  };
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    win?.webContents?.send("update:state", state);
  } catch {
    /* window gone */
  }
}

// The updater changes THIS app: only the local server's UI may drive it.
const { localOnly } = localOriginModule;

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", localOnly("update:get-state", () => state));
  ipcMain.handle("update:check", localOnly("update:check", () => runUpdateAction((coordinator) => coordinator.check(true))));
  ipcMain.handle("update:download", localOnly("update:download", () => runUpdateAction((coordinator) => coordinator.download())));
  ipcMain.handle("update:install", localOnly("update:install", () => runUpdateAction((coordinator) => coordinator.install())));
}

// macOS keeps the process (and updater) alive after its window closes.
// Retarget broadcasts on every window creation without adding more timers
// or event listeners to the process-wide updater.
export function attachUpdaterWindow(mainWindow) {
  win = mainWindow;
}

export function startUpdater({ prepareInstall = null } = {}) {
  if (started) return;
  started = true;
  capability = readUpdaterCapability({ isPackaged: app.isPackaged, staging: STAGING, resourcesPath: process.resourcesPath });
  if (!capability.available) {
    setState({ status: "idle", available: false, capability: capability.reason, message: capability.message, retryable: false });
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
    // Pin the parsed, policy-matched configuration; do not defer the first
    // feed read to a timer or manual action inside the vendor.
    autoUpdater.setFeedURL(capability.metadata);
  } catch {
    autoUpdater = null;
    capability = { available: false, reason: "unavailable", message: "Native updater is unavailable in this package." };
    unavailableState();
    return;
  }
  setState({ available: true, capability: "configured", message: undefined, retryable: undefined });
  autoUpdater.autoDownload = false; // button-driven download
  // Stable line only: a GitHub release marked pre-release (or a beta feed
  // file) is never offered to installed apps.
  autoUpdater.allowPrerelease = false;
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Start it immediately so "Restart to update" never has to begin that slow
  // pass and wait indefinitely. Windows keeps the explicit installer click.
  autoUpdater.autoInstallOnAppQuit = false; // explicit idle-gated install only
  autoUpdater.logger = updaterLogger();

  // Broadcast the install flavour before the first check so the banner never
  // offers a restart it cannot deliver.
  const packageType = linuxPackageType({ readMarker: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null) });
  const handOff = HAND_OFF_TYPES.has(packageType);
  setState({ installMode: handOff ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    nativeStaging: process.platform === "darwin",
    prepareInstall,
  });

  // first check ~15s after launch (let the app settle), then hourly — both
  // silent on failure, hence the arrow: a bare `check` would receive the
  // timer's argument as `manual` and start reporting errors again.
  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
