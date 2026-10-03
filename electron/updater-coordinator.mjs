// `handOffInstall` swaps the terminal step: instead of quitting and letting
// electron-updater run the installer, the downloaded file is handed to the
// user. Ubuntu system packages use it — see electron/updater.mjs for why a
// chat app must not run dpkg itself. Everything before the install is shared.
// It receives the staged paths and resolves with an optional state patch
// describing what is left to do, which the card renders.
import { updateErrorMessage } from "./update-errors.mjs";

export function createUpdaterCoordinator(updater, setState, { handOffInstall = null, nativeStaging = false, prepareInstall = null } = {}) {
  let checkOperation = null;
  // Set from downloadUpdate's resolution: the paths electron-updater staged.
  // Only the hand-off needs them; quitAndInstall reads its own copy.
  let downloadedFiles = null;
  let stagedCandidate = null;
  let downloadOperation = null;
  let installOperation = null;
  let nativeStagingStarted = false;
  let nativeReady = false;
  // Squirrel has no cancellation or attempt ID. After a staging failure a
  // second attempt could consume the first attempt's late ready event.
  let recoveryRequired = false;
  let contractHeld = false;
  // A staged update, install hand-off, or failed user action remains useful
  // until the user acts again. Hourly checks must not replace its controls.
  let actionOwnsState = false;
  const routedErrors = new WeakSet();

  const routeError = (manual, error) => {
    if (recoveryRequired) return;
    if (installOperation?.dispatched) {
      recoveryRequired = true;
      setState({ status: "error", retryable: false, message: `${updateErrorMessage(error)} Update handoff is uncertain; installation remains held.` });
      return;
    }
    actionOwnsState = manual;
    if (error instanceof Error) routedErrors.add(error);
    if (downloadOperation) {
      downloadOperation.failed = true;
      clearTimeout(downloadOperation.timer);
    }
    if (checkOperation) checkOperation.failed = true;
    if (installOperation) {
      installOperation.failed = true;
      clearTimeout(installOperation.timer);
      installOperation = null;
    }
    if (nativeStagingStarted) {
      recoveryRequired = true;
      nativeReady = false;
      setState({
        status: "error",
        retryable: false,
        message: `${updateErrorMessage(error)} Quit and reopen OpenMausBot before trying the update again.`,
      });
      return;
    }
    if (!manual) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "error", message: updateErrorMessage(error) });
  };

  function handleRejectedOperation(manual, error) {
    if (error instanceof Error && routedErrors.has(error)) return;
    routeError(manual, error);
  }

  function checkOwnsState() {
    return !recoveryRequired && !actionOwnsState && !installOperation && !downloadOperation && !checkOperation?.supersededByDownload;
  }

  updater.on("checking-for-update", () => {
    if (checkOwnsState()) setState({ status: "checking" });
  });
  updater.on("update-available", (info) => {
    if (checkOwnsState()) {
      setState({ status: "available", version: info?.version, message: undefined });
    }
  });
  updater.on("update-not-available", () => {
    if (checkOwnsState()) setState({ status: "idle" });
  });
  // downloadUpdate/checkForUpdates reject after most updater errors, but the
  // macOS native staging pass used by quitAndInstall is event-only. Without
  // this listener a Squirrel.Mac failure leaves the renderer on "Restarting"
  // forever because quitAndInstall itself returns void.
  updater.on("error", (error) => {
    // Shared error events do not identify their operation. If a download
    // overtook a check, let their individual promises route failures instead.
    if (checkOperation?.supersededByDownload && !installOperation) return;
    const manual = Boolean(installOperation || downloadOperation || checkOperation?.manual || nativeStagingStarted);
    routeError(manual, error);
  });
  updater.on("download-progress", (progress) => {
    if (contractHeld || recoveryRequired || installOperation || nativeStagingStarted) return;
    setState({ status: "downloading", percent: Math.round(progress?.percent ?? 0) });
  });
  updater.on("update-downloaded", (info) => {
    if (recoveryRequired || installOperation) return;
    // On macOS electron-updater emits this before Squirrel.Mac has finished
    // staging the ZIP. Our vendor patch resolves downloadUpdate only on the
    // native ready event, not merely when the local ZIP transfer finishes.
    if (downloadOperation) {
      downloadOperation.downloadedInfo = info;
      if (nativeStaging && !nativeStagingStarted) {
        nativeStagingStarted = true;
        setState({ status: "preparing", version: info?.version, message: undefined });
        downloadOperation.timer = setTimeout(() => {
          updater.logger?.warn?.("Native update preparation exceeded the five-minute deadline; restart is required before retrying.");
          routeError(true, new Error("Preparing the update took too long."));
        }, 5 * 60 * 1000);
        downloadOperation.timer.unref?.();
      }
      return;
    }
    // No native attempt may become actionable from an uncorrelated late event.
    if (nativeStaging) return;
    actionOwnsState = true;
    setState({ status: "downloaded", version: info?.version });
  });

  function check(manual = false) {
    if (contractHeld || recoveryRequired || installOperation || (nativeStaging && (downloadOperation || nativeStagingStarted)) || (!manual && actionOwnsState)) return Promise.resolve();
    if (checkOperation) {
      // A manual caller upgrades the shared operation; a timer never downgrades it.
      if (manual) checkOperation.manual = true;
      return checkOperation.promise;
    }

    if (manual) actionOwnsState = false;
    const operation = { manual, supersededByDownload: Boolean(downloadOperation), failed: false, promise: null };
    checkOperation = operation;
    try {
      operation.promise = Promise.resolve(updater.checkForUpdates())
        .catch((error) => {
          if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
        })
        .finally(() => {
          if (checkOperation === operation) checkOperation = null;
        });
    } catch (error) {
      if (!operation.supersededByDownload) handleRejectedOperation(operation.manual, error);
      checkOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  function download() {
    if (contractHeld || recoveryRequired || installOperation || nativeStagingStarted) return Promise.resolve();
    if (checkOperation) checkOperation.supersededByDownload = true;
    if (downloadOperation) return downloadOperation.promise;

    stagedCandidate = null;
    const operation = { downloadedInfo: null, failed: false, promise: null, timer: null };
    downloadOperation = operation;
    // Own the state before the request goes out: the first "download-progress"
    // can be seconds away (connection setup, redirects), and until then the
    // renderer would still show an untouched "Download" button. No percent yet
    // — the UI reads a missing percent as "starting".
    setState({ status: "downloading" });
    try {
      operation.promise = Promise.resolve(updater.downloadUpdate())
        .then((result) => {
          if (!operation.failed) {
            downloadedFiles = Array.isArray(result) ? result.filter((file) => typeof file === "string") : null;
          }
          if (!operation.failed && operation.downloadedInfo) {
            const info = operation.downloadedInfo;
            const exe = info.files?.find(file => /\.exe(?:$|\?)/i.test(file.url ?? ""));
            const digest = exe?.sha512 ?? info.sha512;
            if (downloadedFiles?.some(file => /\.exe$/i.test(file)) && typeof digest === "string" &&
                (/^[a-f0-9]{128}$/i.test(digest) || /^[A-Za-z0-9+/]{86}==$/.test(digest))) {
              stagedCandidate = { version: info.version, sha: /^[a-f0-9]{128}$/i.test(digest) ? digest.toLowerCase() : Buffer.from(digest, "base64").toString("hex"), stagedAt: new Date().toISOString() };
            }
            nativeReady = nativeStaging;
            actionOwnsState = true;
            setState({ status: "downloaded", version: operation.downloadedInfo?.version });
          }
          return result;
        })
        .catch((error) => handleRejectedOperation(true, error))
        .finally(() => {
          clearTimeout(operation.timer);
          if (downloadOperation === operation) downloadOperation = null;
        });
    } catch (error) {
      handleRejectedOperation(true, error);
      downloadOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  async function install({ prepareInstall: coordinatedPrepare = prepareInstall } = {}) {
    if ((contractHeld && coordinatedPrepare === prepareInstall) || recoveryRequired || installOperation || downloadOperation || (nativeStaging && !nativeReady)) return { dispatched: false, error: "Update installation is held or in progress" };
    actionOwnsState = true;
    if (handOffInstall) {
      handOff();
      return;
    }
    const operation = { failed: false, timer: null, dispatched: false };
    installOperation = operation;
    setState({ status: "installing" });
    try {
      if (typeof coordinatedPrepare !== "function") throw new Error("Update lifecycle protection is unavailable");
      await coordinatedPrepare();
      if (installOperation !== operation || operation.failed) return { dispatched: false, error: "Update preparation failed" };
    } catch (error) {
      routeError(true, error);
      return { dispatched: false, error: updateErrorMessage(error) };
    }
    try {
      operation.dispatched = true;
      updater.quitAndInstall(true, true);
    } catch (error) {
      routeError(true, error);
      return { dispatched: true, error: updateErrorMessage(error) };
    }
    // quitAndInstall is void and cannot be canceled. A slow handoff must stay
    // busy: exposing Retry here used to arm another native quit callback.
    if (installOperation === operation) {
      operation.timer = setTimeout(() => {
        if (installOperation !== operation) return;
        updater.logger?.warn?.("Update restart handoff exceeded two minutes; keeping installation locked to prevent overlapping retries.");
        setState({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen OpenMausBot to finish the update." });
      }, 2 * 60 * 1000);
      operation.timer.unref?.();
    }
    return { dispatched: true };
  }

  // The platform owns the install from here: a terminal opens with the
  // command on the clipboard and the user finishes there. No quit — the
  // running app stays usable, and the new version is picked up next launch.
  function handOff() {
    const operation = { failed: false, timer: null };
    installOperation = operation;
    setState({ status: "installing" });
    Promise.resolve()
      .then(() => handOffInstall(downloadedFiles))
      .then((patch) => {
        if (installOperation !== operation) return;
        installOperation = null;
        setState({ status: "handed-off", ...patch });
      })
      .catch((error) => {
        if (installOperation !== operation) return;
        routeError(true, error);
      });
  }

  function candidate() { return stagedCandidate && !recoveryRequired ? { ...stagedCandidate } : null; }
  function admit(mode) {
    if (!["update", "restart"].includes(mode)) throw Object.assign(new Error("Invalid update mode"), { status: 400 });
    if (contractHeld || recoveryRequired || installOperation || downloadOperation || checkOperation) throw Object.assign(new Error("Update installation is held or in progress"), { status: 409 });
    if (mode === "update" && !candidate()) throw Object.assign(new Error("No verified Windows installer is staged"), { status: 409 });
  }
  return { check, download, install, candidate, admit, hold: () => { contractHeld = true; } };
}
