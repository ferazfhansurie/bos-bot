import { STAGING } from "./release-channel.mjs";
import { readUpdaterCapability } from "./updater-capability.mjs";
// In-app auto-updater (electron-updater). Downloads run quietly; macOS
// stages the downloaded ZIP immediately and a protected quit applies it.
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
import { belowMinimumVersion, fetchUpdatePolicy, persistUpdateState } from "./update-policy.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
// status: idle | checking | available | downloading | preparing | downloaded | installing | handed-off | error
let state = { status: "idle" };
let updaterCoordinator = null;
let started = false;
let stateDirectory = null;
let configOperation = Promise.resolve();
let capability = { available: false, reason: "not-initialized", message: "Native updates are not initialized." };
state = { ...state, capability: capability.reason, available: false };

function unavailableState() {
  setState({ status: "error", available: false, capability: capability.reason, message: capability.message, retryable: false });
  return { ...state };
}

function runUpdateAction(action) {
  if (!capability.available || !updaterCoordinator) return unavailableState();
  return configOperation.then(() => action(updaterCoordinator));
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
// /opt/BOS Bot while this very process is still running.
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
  persistUpdateState(stateDirectory, state);
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
  // A held quit (busy server) offers "Quit without waiting"; it never waits
  // on the update config and works whether or not the updater is available.
  ipcMain.handle("update:quit-now", localOnly("update:quit-now", () => {
    if (!updaterCoordinator?.quitWithoutWaiting()) app.quit();
  }));
}

// macOS keeps the process (and updater) alive after its window closes.
// Retarget broadcasts on every window creation without adding more timers
// or event listeners to the process-wide updater.
export function attachUpdaterWindow(mainWindow) {
  win = mainWindow;
}

function installRequiredUpdate() {
  if (!state.required) return;
  if (typeof state.version !== "string" || !/^\d+\.\d+\.\d+$/.test(state.version) || belowMinimumVersion(state.version, state.minimumVersion)) {
    updaterCoordinator.hold();
    setState({ status: "error", retryable: false, message: "No published update meets the required version. Download the latest installer." });
    return;
  }
  if (state.installMode !== "handoff") void updaterCoordinator.install();
}

export function startUpdater({ prepareInstall = null, dataDir = null, fetchPolicy = fetchUpdatePolicy } = {}) {
  if (started) return;
  started = true;
  stateDirectory = dataDir;
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
  autoUpdater.autoDownload = false; // coordinator owns automatic downloads + native-ready promise
  // Stable line only: a GitHub release marked pre-release (or a beta feed
  // file) is never offered to installed apps.
  autoUpdater.allowPrerelease = false;
  // Squirrel.Mac has a second, native staging pass after the ZIP download.
  // Mac's flag enables native staging (it has no vendor quit hook). Other
  // platforms must not arm the vendor's unprotected onQuit installer. Our
  // before-quit handler runs every install through the busy-turn lifecycle.
  autoUpdater.autoInstallOnAppQuit = process.platform === "darwin";
  autoUpdater.logger = updaterLogger();
  // Staged rollout gates only quiet background checks. A floor applies to
  // every old install, and a user who presses "Check for updates" asked for
  // the published version: both bypass rollout eligibility for that check.
  // OS/signature support checks stay intact.
  const vendorRollout = autoUpdater.isUserWithinRollout;
  autoUpdater.isUserWithinRollout = info => state.required === true || updaterCoordinator?.manualCheckActive() === true ||
    (typeof vendorRollout === "function" ? vendorRollout(info) : true);

  // Broadcast the install flavour before the first check so the banner never
  // offers a restart it cannot deliver.
  const packageType = linuxPackageType({ readMarker: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null) });
  const handOff = HAND_OFF_TYPES.has(packageType);
  setState({ installMode: handOff ? "handoff" : "restart" });
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    nativeStaging: process.platform === "darwin",
    prepareInstall,
    automaticDownload: () => state.automaticUpdates === true,
    acceptUpdate: version => !state.required || (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) && !belowMinimumVersion(version, state.minimumVersion)),
    onDownloaded: installRequiredUpdate,
  });

  // A known minimum triggers a launch check; offline/missing config preserves
  // normal startup. Errors are state, including checks made by these timers.
  // The policy is refetched hourly so an install that launched offline still
  // sees flag and floor changes; a later offline fetch keeps the last policy.
  const applyPolicy = (policy, launch) => {
    if (!policy && !launch) return;
    const minimum = policy?.minimumVersion;
    const required = belowMinimumVersion(app.getVersion(), minimum);
    const wasRequired = state.required === true;
    setState({automaticUpdates: policy?.autoUpdates === true || required});
    if (required) {
      setState({ required: true, minimumVersion: minimum });
      if (state.status === "downloaded") return installRequiredUpdate();
      // Hourly refreshes are followed by the timer's own check.
      if (launch) return updaterCoordinator.check();
    } else if (wasRequired) {
      setState({ required: false, minimumVersion: undefined });
    }
  };
  const refreshPolicy = launch => Promise.resolve().then(() => fetchPolicy()).then(policy => applyPolicy(policy, launch)).catch(() => {});
  configOperation = refreshPolicy(true);
  setTimeout(() => void configOperation.then(() => updaterCoordinator?.check()), 15_000).unref?.();
  setInterval(() => {
    configOperation = configOperation.then(() => refreshPolicy(false));
    void configOperation.then(() => updaterCoordinator?.check());
  }, 60 * 60 * 1000).unref?.();
}

// Dynamic facade: main registers private RPC before the updater/feed starts.
// Packaged staging may restart even though it has no release feed.
export const windowsUpdateCoordinator = {
  candidate: () => updaterCoordinator?.candidate() ?? null,
  admit(mode) {
    if (updaterCoordinator) return updaterCoordinator.admit(mode);
    if (mode !== "restart") throw Object.assign(new Error("No verified Windows installer is staged"), { status: 409 });
  },
  hold: () => updaterCoordinator?.hold(),
  install: options => updaterCoordinator?.install(options),
};

// Call before any shutdown side effects. Never let a vendor quit hook bypass
// the server's idle check. Failed admission can be retried by quitting again.
export function handleUpdaterQuit(event) {
  if (updaterCoordinator?.protectQuit(event, () => app.quit())) return true;
  if ((!state.automaticUpdates && !state.required) || !updaterCoordinator?.shouldInstallOnQuit()) {
    // Shutdown may defer its final quit while helpers stop. A late feed/config
    // response must not start native staging after the server is already gone.
    // The hold lapses, so a quit cancelled later leaves updates working.
    updaterCoordinator?.holdForQuit();
    return false;
  }
  event.preventDefault();
  void updaterCoordinator.install();
  return true;
}
