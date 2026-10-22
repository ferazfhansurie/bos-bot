// `handOffInstall` swaps the terminal step: instead of quitting and letting
// electron-updater run the installer, the downloaded file is handed to the
// user. Ubuntu system packages use it — see electron/updater.mjs for why a
// chat app must not run dpkg itself. Everything before the install is shared.
// It receives the staged paths and resolves with an optional state patch
// describing what is left to do, which the card renders.
import { updateErrorMessage } from "./update-errors.mjs";

export function createUpdaterCoordinator(updater, setState, { handOffInstall = null, nativeStaging = false, prepareInstall = null, automaticDownload = false, onDownloaded = null, acceptUpdate = () => true, quitRetryMs: QUIT_RETRY_MS = 5_000, quitRetryLimit: QUIT_RETRY_LIMIT = 24, shutdownHoldMs: SHUTDOWN_HOLD_MS = 2 * 60 * 1000 } = {}) {
  let lastStatus = "idle";
  const publish = setState;
  setState = patch => { lastStatus = patch.status ?? lastStatus; publish(patch); };
  let quitOperation = null;
  let quitAdmitted = false;
  let quitPending = false;
  let quitResume = null;
  let quitRetries = 0;
  let quitRetryTimer = null;
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
  // Quit-time hold: a late feed response must not start native staging while
  // shutdown runs, but a quit cancelled after before-quit must not disable
  // updates for the rest of the session. It lapses on its own.
  let shutdownHeld = false;
  let shutdownHoldTimer = null;
  const held = () => contractHeld || shutdownHeld;
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
        message: `${updateErrorMessage(error)} Quit and reopen BOS Bot before trying the update again.`,
      });
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
      if (!acceptUpdate(info?.version)) {
        contractHeld = true;
        setState({status: "error", retryable: false, message: "No published update meets the required version. Download the latest installer."});
        return;
      }
      setState({ status: "available", version: info?.version, message: undefined });
      // Own downloadUpdate's promise, including Squirrel's native staging.
      // Vendor autoDownload would hide that promise from this coordinator.
      if (typeof automaticDownload === "function" ? automaticDownload() : automaticDownload) queueMicrotask(() => void download());
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
    if (quitOperation || held() || recoveryRequired || installOperation || nativeStagingStarted) return;
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
    if (quitOperation || held() || recoveryRequired || installOperation || (nativeStaging && (downloadOperation || nativeStagingStarted)) || (!manual && actionOwnsState)) return Promise.resolve();
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
    if (quitOperation || held() || recoveryRequired || installOperation || nativeStagingStarted) return Promise.resolve();
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
          if (!operation.failed && lastStatus === "downloaded") onDownloaded?.();
        });
    } catch (error) {
      handleRejectedOperation(true, error);
      downloadOperation = null;
      operation.promise = Promise.resolve();
    }
    return operation.promise;
  }

  async function install({ prepareInstall: coordinatedPrepare = prepareInstall } = {}) {
    if (quitOperation || shutdownHeld || (contractHeld && coordinatedPrepare === prepareInstall) || recoveryRequired || installOperation || downloadOperation || (nativeStaging && !nativeReady)) return { dispatched: false, error: "Update installation is held or in progress" };
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
        setState({ status: "installing", message: "Restart is taking longer than expected. Quit and reopen BOS Bot to finish the update." });
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
    if (quitOperation || held() || recoveryRequired || installOperation || downloadOperation || checkOperation) throw Object.assign(new Error("Update installation is held or in progress"), { status: 409 });
    if (mode === "update" && !candidate()) throw Object.assign(new Error("No verified Windows installer is staged"), { status: 409 });
  }
  // Squirrel writes a persistent install request while staging: ordinary
  // termination can apply it without quitAndInstall. Protect every exit from
  // that point, even failed native readiness or failed idle admission.
  // The guard is bounded: a refused admission retries quietly (the quit goes
  // through once active tasks finish), and a repeated quit after a refusal
  // tries once more, then quits without waiting. Cmd+Q must always work.
  function finishQuit() {
    clearTimeout(quitRetryTimer);
    quitRetryTimer = null;
    quitPending = false;
    quitAdmitted = true;
    const resume = quitResume;
    quitResume = null;
    resume?.();
  }
  function attemptQuit(insisted) {
    const attempt = Promise.resolve()
      .then(() => {
        if (typeof prepareInstall !== "function") throw new Error("Update lifecycle protection is unavailable");
        return prepareInstall();
      })
      .then(() => { quitOperation = null; finishQuit(); }, error => {
        quitOperation = null;
        if (quitAdmitted) return;
        if (insisted) {
          updater.logger?.warn?.(`Quit admission refused twice; quitting without waiting: ${updateErrorMessage(error)}`);
          finishQuit();
          return;
        }
        quitPending = true;
        setState({status: "error", retryable: false, quitHeld: true, message: `${updateErrorMessage(error)} BOS Bot quits as soon as active tasks finish. Quit again to quit without waiting.`});
        if (quitRetries >= QUIT_RETRY_LIMIT) return;
        quitRetries++;
        quitRetryTimer = setTimeout(() => {
          quitRetryTimer = null;
          if (!quitOperation && !quitAdmitted && quitPending) attemptQuit(false);
        }, QUIT_RETRY_MS);
        quitRetryTimer.unref?.();
      });
    quitOperation = attempt;
  }
  function protectQuit(event, resumeQuit) {
    if (handOffInstall || quitAdmitted || installOperation?.dispatched) return false;
    if (!nativeStagingStarted && !(nativeStaging && downloadOperation) && !installOperation && !quitOperation && !quitPending) return false;
    event.preventDefault();
    quitResume = resumeQuit;
    if (installOperation || quitOperation) return true;
    const insisted = quitPending;
    clearTimeout(quitRetryTimer);
    quitRetryTimer = null;
    quitRetries = insisted ? quitRetries : 0;
    attemptQuit(insisted);
    return true;
  }
  // The held-quit card's "Quit without waiting". False when no quit is held.
  function quitWithoutWaiting() {
    if (quitAdmitted || (!quitPending && !quitOperation)) return false;
    finishQuit();
    return true;
  }

  function shouldInstallOnQuit() {
    return !quitAdmitted && lastStatus === "downloaded" && !handOffInstall && !held() && !recoveryRequired &&
      !installOperation && !downloadOperation && (!nativeStaging || nativeReady);
  }
  function holdForQuit(ms = SHUTDOWN_HOLD_MS) {
    shutdownHeld = true;
    clearTimeout(shutdownHoldTimer);
    shutdownHoldTimer = setTimeout(() => { shutdownHeld = false; shutdownHoldTimer = null; }, ms);
    shutdownHoldTimer.unref?.();
  }
  // True while a user-initiated check (Settings → Updates) is resolving.
  const manualCheckActive = () => checkOperation?.manual === true;
  return { check, download, install, candidate, admit, shouldInstallOnQuit, protectQuit, quitWithoutWaiting, manualCheckActive, hold: () => { contractHeld = true; }, holdForQuit };
}
