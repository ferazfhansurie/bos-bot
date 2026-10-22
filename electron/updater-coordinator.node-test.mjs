import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(options) {
  const updater = new EventEmitter();
  // electron-updater has its own error listener; model that without routing it.
  updater.on("error", () => {});
  let state = { status: "idle" };
  const states = [];
  const coordinator = createUpdaterCoordinator(
    updater,
    (patch) => {
      state = { ...state, ...patch };
      states.push({ ...state });
    },
    { prepareInstall: async () => ({}), ...options },
  );
  return { updater, coordinator, states, getState: () => state };
}

// Drives a successful download so install() has staged paths to hand off.
async function downloadInto(h, files = ["/tmp/BOS-Bot-2.0.0-amd64.deb"]) {
  h.updater.downloadUpdate = () => {
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return Promise.resolve(files);
  };
  await h.coordinator.download();
}

function errorStates(states) {
  return states.filter((entry) => entry.status === "error");
}

test("automatic check rejection is handled and exposes an error state", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("offline"));

  await assert.doesNotReject(coordinator.check());

  assert.equal(getState().status, "error");
});

test("manual check rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => Promise.reject(new Error("feed failed"));

  await assert.doesNotReject(coordinator.check(true));

  assert.deepEqual(getState(), { status: "error", message: "feed failed" });
});

test("download rejection is handled as a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.downloadUpdate = () => Promise.reject(new Error("download failed"));

  await assert.doesNotReject(coordinator.download());

  assert.deepEqual(getState(), { status: "error", message: "download failed" });
});

test("synchronous check and download throws are handled", async () => {
  const { updater, coordinator, getState } = harness();
  updater.checkForUpdates = () => {
    throw new Error("check threw");
  };

  await assert.doesNotReject(coordinator.check(true));
  assert.deepEqual(getState(), { status: "error", message: "check threw" });

  updater.downloadUpdate = () => {
    throw new Error("download threw");
  };

  await assert.doesNotReject(coordinator.download());
  assert.deepEqual(getState(), { status: "error", message: "download threw" });
});

test("a concurrent background check cannot downgrade a manual check", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const manual = coordinator.check(true);
  const background = coordinator.check();
  assert.strictEqual(background, manual);
  assert.equal(calls, 1);

  pending.reject(new Error("manual failure"));
  await manual;

  assert.deepEqual(getState(), { status: "error", message: "manual failure" });
});

test("a manual request during a background check preserves user-visible errors", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  let calls = 0;
  updater.checkForUpdates = () => {
    calls += 1;
    return pending.promise;
  };

  const background = coordinator.check();
  const manual = coordinator.check(true);
  assert.strictEqual(manual, background);
  assert.equal(calls, 1);

  pending.reject(new Error("background request failed"));
  await background;

  assert.deepEqual(getState(), { status: "error", message: "background request failed" });
});

test("download reports downloading before the first progress event", async () => {
  const { updater, coordinator, getState, states } = harness();
  const pending = deferred();
  // a real transfer stays silent until bytes arrive; the button must not wait
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading" });
  assert.equal(states[0].status, "downloading");

  updater.emit("download-progress", { percent: 12 });
  assert.deepEqual(getState(), { status: "downloading", percent: 12 });

  pending.resolve();
  await download;
});

test("downloaded waits for the updater download promise before becoming actionable", async () => {
  const { updater, coordinator, getState } = harness();
  const pending = deferred();
  updater.downloadUpdate = () => pending.promise;

  const download = coordinator.download();
  updater.emit("update-downloaded", { version: "2.0.0" });
  assert.deepEqual(getState(), { status: "downloading" });

  pending.resolve(["update.zip"]);
  await download;
  assert.deepEqual(getState(), { status: "downloaded", version: "2.0.0" });
});

test("Mac transfer failures cannot overlap a pending download and remain retryable after it settles", async () => {
  const h = harness({ nativeStaging: true });
  const pending = deferred();
  let calls = 0;
  h.updater.downloadUpdate = () => { calls += 1; return pending.promise; };
  h.updater.checkForUpdates = () => assert.fail("a check cannot overlap a Mac download");
  h.updater.quitAndInstall = () => assert.fail("an incomplete transfer cannot install");
  const first = h.coordinator.download();
  const failure = new Error("connection lost before ZIP completed");
  h.updater.emit("error", failure);
  assert.equal(h.getState().status, "error");
  assert.notEqual(h.getState().retryable, false);
  assert.strictEqual(h.coordinator.download(), first);
  await h.coordinator.check(true);
  await h.coordinator.install();
  assert.equal(calls, 1);
  pending.reject(failure);
  await first;

  h.updater.downloadUpdate = async () => {
    calls += 1;
    h.updater.emit("update-downloaded", { version: "2.0.0" });
    return ["update.zip"];
  };
  await h.coordinator.download();
  assert.equal(calls, 2);
  assert.equal(h.getState().status, "downloaded");
});

test("a restart watchdog keeps Windows/AppImage installs locked against overlapping retries", async (t) => {
  const h = harness();
  let quits = 0;
  let watchdog;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    assert.equal(delay, 120_000);
    watchdog = callback;
    return { unref() {} };
  });
  h.updater.quitAndInstall = () => { quits += 1; };
  h.updater.checkForUpdates = () => assert.fail("install still owns the updater");
  await downloadInto(h);
  await h.coordinator.install();
  watchdog();
  h.updater.downloadUpdate = () => assert.fail("a retry must not overlap a slow installer");
  await h.coordinator.download();
  await h.coordinator.check(true);
  await h.coordinator.install();
  assert.equal(h.getState().status, "installing");
  assert.match(h.getState().message, /Quit and reopen/);
  assert.equal(quits, 1);
});

test("an asynchronous native install error escapes the restarting spinner", async () => {
  const { updater, coordinator, getState, states } = harness();
  const error = new Error("native staging failed");
  updater.quitAndInstall = () => updater.emit("error", error);

  await coordinator.install();

  assert.deepEqual(getState(), { status: "error", retryable: false, message: "native staging failed Update handoff is uncertain; installation remains held." });
  assert.equal(errorStates(states).length, 1);
});

test("a synchronous install failure becomes a user-visible error", async () => {
  const { updater, coordinator, getState } = harness();
  updater.quitAndInstall = () => {
    throw new Error("install threw");
  };

  await coordinator.install();

  assert.deepEqual(getState(), { status: "error", retryable: false, message: "install threw Update handoff is uncertain; installation remains held." });
});

test("an active download state survives a later background check failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 42 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => {
    updater.emit("checking-for-update");
    updater.emit("update-available", { version: "2.1.0" });
    updater.emit("update-not-available");
    return checkPending.promise;
  };

  const download = coordinator.download();
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  const background = coordinator.check();
  checkPending.reject(new Error("background check failed"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 42 });

  downloadPending.resolve();
  await download;
});

test("a download error remains authoritative after a later background failure", async () => {
  const { updater, coordinator, getState } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 75 });
    return downloadPending.promise;
  };
  updater.checkForUpdates = () => checkPending.promise;

  const download = coordinator.download();
  const background = coordinator.check();

  const downloadError = new Error("download failed first");
  downloadPending.reject(downloadError);
  await download;
  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed later"));
  await background;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 75,
    message: "download failed first",
  });
});

test("a background failure stays silent before a later download failure", async () => {
  const { updater, coordinator, getState, states } = harness();
  const downloadPending = deferred();
  const checkPending = deferred();
  updater.checkForUpdates = () => checkPending.promise;
  updater.downloadUpdate = () => {
    updater.emit("download-progress", { percent: 18 });
    return downloadPending.promise;
  };

  const background = coordinator.check();
  const download = coordinator.download();

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "2.1.0" });
  updater.emit("update-not-available");
  checkPending.reject(new Error("background check failed first"));
  await background;
  assert.deepEqual(getState(), { status: "downloading", percent: 18 });
  assert.equal(errorStates(states).length, 0);

  const downloadError = new Error("download failed later");
  downloadPending.reject(downloadError);
  await download;

  assert.deepEqual(getState(), {
    status: "error",
    percent: 18,
    message: "download failed later",
  });
});

test("available, not-available, progress, and downloaded events preserve success behavior", async () => {
  const available = harness();
  available.updater.checkForUpdates = () => {
    available.updater.emit("checking-for-update");
    queueMicrotask(() => available.updater.emit("update-available", { version: "2.0.0" }));
    return Promise.resolve({ isUpdateAvailable: true });
  };
  await available.coordinator.check(true);
  assert.equal(available.getState().status, "available");
  assert.equal(available.getState().version, "2.0.0");

  available.updater.downloadUpdate = () => {
    available.updater.emit("download-progress", { percent: 42.4 });
    return Promise.resolve().then(() => {
      available.updater.emit("update-downloaded", { version: "2.0.0" });
      return ["update.zip"];
    });
  };
  await available.coordinator.download();
  assert.deepEqual(available.getState(), {
    status: "downloaded",
    version: "2.0.0",
    message: undefined,
    percent: 42,
  });

  const notAvailable = harness();
  notAvailable.updater.checkForUpdates = () => {
    notAvailable.updater.emit("checking-for-update");
    notAvailable.updater.emit("update-not-available");
    return Promise.resolve({ isUpdateAvailable: false });
  };
  await notAvailable.coordinator.check();
  assert.equal(notAvailable.getState().status, "idle");
});

test("an updater error event and rejected promise produce one deterministic state", async () => {
  const check = harness();
  const checkError = new Error("check failed once");
  check.updater.checkForUpdates = () =>
    Promise.reject(checkError).catch((error) => {
      check.updater.emit("error", error);
      throw error;
    });

  await check.coordinator.check(true);
  assert.equal(errorStates(check.states).length, 1);
  assert.deepEqual(check.getState(), { status: "error", message: "check failed once" });

  const download = harness();
  const downloadError = new Error("download failed once");
  download.updater.downloadUpdate = () =>
    Promise.reject(downloadError).catch((error) => {
      download.updater.emit("error", error);
      throw error;
    });

  await download.coordinator.download();
  assert.equal(errorStates(download.states).length, 1);
  assert.deepEqual(download.getState(), { status: "error", message: "download failed once" });
});

test("the hand-off install opens the staged package instead of quitting", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
      // what the user still has to do travels back with the state
      return Promise.resolve({ command: "sudo apt-get install -y '/tmp/x.deb'", terminalOpened: true });
    },
  });
  h.updater.quitAndInstall = () => assert.fail("a system package must not be installed by quitAndInstall");

  await downloadInto(h);
  assert.equal(h.getState().status, "downloaded");

  await h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, [["/tmp/BOS-Bot-2.0.0-amd64.deb"]]);
  assert.equal(h.getState().status, "handed-off");
  // the user watched something happen between the click and the result
  assert.ok(h.states.some((entry) => entry.status === "installing"));
  assert.equal(h.getState().command, "sudo apt-get install -y '/tmp/x.deb'");
  assert.equal(h.getState().terminalOpened, true);
});

test("a failed hand-off is reported instead of leaving the card spinning", async () => {
  const h = harness({ handOffInstall: () => Promise.reject(new Error("no handler for .deb")) });

  await downloadInto(h);
  await h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  // version survives the merge from the download — assert what the card reads
  assert.equal(h.getState().status, "error");
  assert.equal(h.getState().message, "no handler for .deb");
});

test("the hand-off sees no staged file when nothing downloaded", async () => {
  const received = [];
  const h = harness({
    handOffInstall: (files) => {
      received.push(files);
      return Promise.resolve();
    },
  });

  await h.coordinator.install();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(received, [null]);
});

test("without a hand-off the install still quits and installs", async () => {
  const h = harness();
  let called = 0;
  h.updater.quitAndInstall = () => {
    called += 1;
  };

  await downloadInto(h, ["/tmp/BOS-Bot-2.0.0.AppImage"]);
  await h.coordinator.install();

  assert.equal(called, 1);
  assert.equal(h.getState().status, "installing");
});

test("a staged update survives hourly checks until the user explicitly checks again", async () => {
  const h = harness();
  let checks = 0;
  h.updater.checkForUpdates = async () => {
    checks += 1;
    h.updater.emit("checking-for-update");
    h.updater.emit("update-available", { version: "2.1.0" });
  };
  await downloadInto(h);
  const staged = h.getState();

  await h.coordinator.check();
  assert.equal(checks, 0);
  assert.deepEqual(h.getState(), staged);

  await h.coordinator.check(true);
  assert.equal(checks, 1);
  assert.equal(h.getState().status, "available");
  assert.equal(h.getState().version, "2.1.0");
});

test("a superseded check error event cannot invalidate a completed download", async () => {
  const h = harness();
  const pending = deferred();
  h.updater.checkForUpdates = () => pending.promise;
  const check = h.coordinator.check();
  await downloadInto(h);

  const error = new Error("the earlier feed request failed");
  h.updater.emit("error", error);
  pending.reject(error);
  await check;

  assert.equal(h.getState().status, "downloaded");
  assert.equal(h.getState().version, "2.0.0");
});

test("checks cannot replace an install in progress or its completed hand-off", async () => {
  const pending = deferred();
  const h = harness({ handOffInstall: () => pending.promise });
  h.updater.checkForUpdates = () => assert.fail("installation owns the updater");
  await downloadInto(h);
  await h.coordinator.install();

  await h.coordinator.check();
  await h.coordinator.check(true);
  assert.equal(h.getState().status, "installing");

  pending.resolve({ command: "install the staged package", terminalOpened: false });
  await new Promise((resolve) => setImmediate(resolve));
  const handedOff = h.getState();
  await h.coordinator.check();
  assert.equal(h.getState().status, "handed-off");
  assert.deepEqual(h.getState(), handedOff);
});

test("failed download and hand-off actions survive automatic checks but remain retryable", async () => {
  for (const failure of ["download", "hand-off"]) {
    const h = harness({ handOffInstall: () => Promise.reject(new Error("hand-off failed")) });
    if (failure === "download") {
      h.updater.downloadUpdate = () => Promise.reject(new Error("download failed"));
      await h.coordinator.download();
    } else {
      await downloadInto(h);
      await h.coordinator.install();
      await new Promise((resolve) => setImmediate(resolve));
    }
    let checks = 0;
    h.updater.checkForUpdates = async () => {
      checks += 1;
      h.updater.emit("checking-for-update");
      h.updater.emit("update-available", { version: "2.0.0" });
    };
    const failed = h.getState();
    assert.equal(failed.status, "error");
    await h.coordinator.check();
    assert.equal(checks, 0);
    assert.deepEqual(h.getState(), failed);
    await h.coordinator.check(true);
    assert.equal(checks, 1);
    assert.equal(h.getState().status, "available");
  }
});

test("install reserves ownership and waits for the idle gate before dispatch", async () => {
  const gate = deferred();
  const h = harness({ prepareInstall: () => gate.promise });
  let installs = 0;
  h.updater.quitAndInstall = () => { installs++; };
  const first = h.coordinator.install();
  h.coordinator.install();
  assert.equal(installs, 0);
  gate.resolve({ nonce: "prepared" });
  await first;
  assert.equal(installs, 1);
});

test("install without a lifecycle gate fails closed", async () => {
  const h = harness({ prepareInstall: null });
  let installs = 0;
  h.updater.quitAndInstall = () => { installs++; };
  await h.coordinator.install();
  assert.equal(installs, 0);
  assert.equal(h.getState().status, "error");
});

test("uncertain native dispatch retains ownership after an error", async () => {
  const h = harness({ prepareInstall: async () => ({ nonce: "prepared" }) });
  let installs = 0;
  h.updater.quitAndInstall = () => { installs++; throw new Error("uncertain handoff"); };
  await h.coordinator.install();
  await h.coordinator.install();
  assert.equal(installs, 1);
  assert.equal(h.getState().retryable, false);
});

const digest = Buffer.alloc(64, 7).toString("base64");
async function stagedWindows(h) {
  h.updater.downloadUpdate = async () => {
    h.updater.emit("update-downloaded", { version: "1.3.0", sha512: digest });
    return ["/synthetic/BOS.exe"];
  };
  await h.coordinator.download();
}
test("contract candidate exists only after verified download resolves", async () => {
  const h = harness();
  assert.equal(h.coordinator.candidate?.(), null);
  await stagedWindows(h);
  assert.deepEqual(h.coordinator.candidate(), {version:"1.3.0", sha:Buffer.from(digest,"base64").toString("hex"), stagedAt:h.coordinator.candidate().stagedAt});
  assert.ok(Number.isFinite(Date.parse(h.coordinator.candidate().stagedAt)));
});
test("contract install uses the coordinated lifecycle once and reports dispatch", async () => {
  const h=harness({prepareInstall:async()=>{throw new Error("legacy gate must not be called");}});
  await stagedWindows(h); let prepared=0, installed=0;
  h.updater.quitAndInstall=()=>{installed++;};
  const result=await h.coordinator.install({prepareInstall:async()=>{prepared++;}});
  assert.equal(result.dispatched,true); assert.equal(prepared,1); assert.equal(installed,1);
  assert.throws(()=>h.coordinator.admit("restart"),/held|progress/);
});
test("contract admission refuses update without staged metadata", () => {
  const h=harness(); assert.throws(()=>h.coordinator.admit("update"),/staged/);
  assert.doesNotThrow(()=>h.coordinator.admit("restart"));
});
test("contract install reports preparation refusal without dispatch", async () => {
  const h=harness(); await stagedWindows(h); let installed=0;
  h.updater.quitAndInstall=()=>{installed++;};
  const result=await h.coordinator.install({prepareInstall:async()=>{throw new Error("checkpoint missing");}});
  assert.equal(result.dispatched,false); assert.match(result.error,/checkpoint missing/); assert.equal(installed,0);
});
test("contract hold prevents legacy UI and timers from racing a restart", async () => {
 const h=harness();await stagedWindows(h);let installs=0,checks=0;
 h.updater.quitAndInstall=()=>installs++;h.updater.checkForUpdates=()=>{checks++;};
 h.coordinator.hold();await h.coordinator.install();await h.coordinator.check(true);await h.coordinator.download();
 assert.equal(installs,0);assert.equal(checks,0);assert.throws(()=>h.coordinator.admit("restart"),/held|progress/);
});

test("automatic updates download without a renderer action and track native readiness", async () => {
  const h = harness({ automaticDownload: true, nativeStaging: true });
  let downloads = 0;
  h.updater.downloadUpdate = async () => {
    downloads++;
    h.updater.emit("update-downloaded", { version: "2.1.3" });
    return ["update.zip"];
  };
  h.updater.checkForUpdates = async () => {
    h.updater.emit("update-available", { version: "2.1.3" });
  };
  await h.coordinator.check();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(downloads, 1);
  assert.equal(h.getState().status, "downloaded");
  assert.ok(h.states.some(state => state.status === "preparing"));
});

test("install on quit runs lifecycle protection and refuses a busy turn", async () => {
  let installs = 0;
  const h = harness({ prepareInstall: async () => { throw new Error("busy turn"); } });
  h.updater.quitAndInstall = () => installs++;
  await downloadInto(h);
  assert.equal(h.coordinator.shouldInstallOnQuit(), true);
  await h.coordinator.install();
  assert.equal(installs, 0);
  assert.equal(h.coordinator.shouldInstallOnQuit(), false);
});

test("install on quit dispatches once and skips terminal handoffs", async () => {
  const h = harness();
  let installs = 0;
  h.updater.quitAndInstall = () => installs++;
  assert.equal(h.coordinator.shouldInstallOnQuit(), false);
  await downloadInto(h);
  assert.equal(h.coordinator.shouldInstallOnQuit(), true);
  await h.coordinator.install();
  assert.equal(h.coordinator.shouldInstallOnQuit(), false);
  assert.equal(installs, 1);
  const terminal = harness({ handOffInstall: async () => ({}) });
  await downloadInto(terminal);
  assert.equal(terminal.coordinator.shouldInstallOnQuit(), false);
});

test("Mac quit admission protects native preparation and repeated quits", async () => {
  const admission = deferred();
  let prepares = 0;
  let resumes = 0;
  let prevented = 0;
  const h = harness({nativeStaging: true, prepareInstall: () => { prepares++; return admission.promise; }});
  const bytes = deferred();
  h.updater.downloadUpdate = () => bytes.promise;
  const downloading = h.coordinator.download();
  h.updater.emit("update-downloaded", {version:"2.1.3"});
  const event = {preventDefault() { prevented++; }};
  assert.equal(h.coordinator.protectQuit(event, () => resumes++), true);
  assert.equal(h.coordinator.protectQuit(event, () => resumes++), true);
  await Promise.resolve();
  assert.equal(prepares, 1);
  assert.equal(resumes, 0);
  admission.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumes, 1);
  assert.equal(prevented, 2);
  assert.equal(h.coordinator.protectQuit(event, () => resumes++), false);
  bytes.resolve(["update.zip"]);
  await downloading;
});

test("failed native quit admission remains guarded and can retry the lifecycle", async () => {
  let busy = true;
  let resumed = 0;
  const h = harness({nativeStaging:true, prepareInstall: async () => {if (busy) throw new Error("busy turn");}});
  await downloadInto(h, ["update.zip"]);
  const event = {preventDefault() {}};
  assert.equal(h.coordinator.protectQuit(event, () => resumed++), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, 0);
  busy = false;
  assert.equal(h.coordinator.protectQuit(event, () => resumed++), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, 1);
});

test("a second quit cannot bypass pending explicit install admission", async () => {
  const admission = deferred();
  const h = harness({prepareInstall: () => admission.promise});
  let installs = 0;
  h.updater.quitAndInstall = () => installs++;
  await downloadInto(h);
  const installing = h.coordinator.install();
  assert.equal(h.coordinator.protectQuit({preventDefault() {}}, () => assert.fail("early quit")), true);
  assert.equal(installs, 0);
  admission.resolve();
  await installing;
  assert.equal(h.coordinator.protectQuit({preventDefault() {}}, () => {}), false);
  assert.equal(installs, 1);
});

test("Mac quit protects binary transfer before native preparation can race shutdown", async () => {
  const admission = deferred();
  const bytes = deferred();
  const h = harness({nativeStaging:true, prepareInstall: () => admission.promise});
  h.updater.downloadUpdate = () => bytes.promise;
  const downloading = h.coordinator.download();
  let resumed = 0;
  assert.equal(h.coordinator.protectQuit({preventDefault() {}}, () => resumed++), true);
  h.updater.emit("update-downloaded", {version:"2.1.3"});
  bytes.resolve(["update.zip"]);
  await downloading;
  assert.equal(resumed, 0);
  admission.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumed, 1);
});

test("shutdown hold prevents a late feed response from starting native download", async () => {
  const h = harness({automaticDownload:true, nativeStaging:true});
  const feed = deferred();
  h.updater.checkForUpdates = () => feed.promise;
  h.updater.downloadUpdate = () => assert.fail("shutdown must not start native work");
  const checking = h.coordinator.check();
  assert.equal(h.coordinator.protectQuit({preventDefault() {}}, () => {}), false);
  h.coordinator.hold();
  h.updater.emit("update-available", {version:"2.1.3"});
  feed.resolve();
  await checking;
  await new Promise(resolve => setImmediate(resolve));
});

const settle = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async (predicate) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2)); };

test("Mac quit with no owned server is admitted at once", async () => {
  const { createUpdateLifecycleClient } = await import("./update-lifecycle.mjs");
  const lifecycle = createUpdateLifecycleClient({ getConnection: () => null, recordIntent: async () => {}, fetch: async () => assert.fail("no server") });
  const h = harness({ nativeStaging: true, prepareInstall: lifecycle.prepareInstall });
  await downloadInto(h, ["update.zip"]);
  let resumed = 0;
  assert.equal(h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++), true);
  await settle();
  assert.equal(resumed, 1);
  assert.equal(h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++), false);
});

test("a busy quit retries quietly and goes through once the server is idle", async () => {
  let busy = true;
  let resumed = 0;
  const h = harness({ nativeStaging: true, quitRetryMs: 1, prepareInstall: async () => { if (busy) throw new Error("busy turn"); } });
  await downloadInto(h, ["update.zip"]);
  h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++);
  await settle();
  assert.equal(h.getState().quitHeld, true);
  assert.equal(resumed, 0);
  busy = false;
  await waitFor(() => resumed > 0);
  assert.equal(resumed, 1);
});

test("quit retries are bounded and a repeated quit then quits without waiting", async () => {
  let prepares = 0;
  let resumed = 0;
  const h = harness({ nativeStaging: true, quitRetryMs: 1, quitRetryLimit: 2, prepareInstall: async () => { prepares++; throw new Error("busy turn"); } });
  await downloadInto(h, ["update.zip"]);
  h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++);
  await waitFor(() => prepares >= 3);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(prepares, 3);
  assert.equal(resumed, 0);
  assert.equal(h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++), true);
  await settle();
  assert.equal(prepares, 4);
  assert.equal(resumed, 1);
  assert.equal(h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++), false);
});

test("quit without waiting releases a held quit and is a no-op otherwise", async () => {
  let resumed = 0;
  const h = harness({ nativeStaging: true, quitRetryMs: 60_000, prepareInstall: async () => { throw new Error("Owned desktop server connection is unavailable"); } });
  await downloadInto(h, ["update.zip"]);
  assert.equal(h.coordinator.quitWithoutWaiting(), false);
  h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++);
  await settle();
  assert.equal(h.getState().quitHeld, true);
  assert.equal(h.coordinator.quitWithoutWaiting(), true);
  assert.equal(resumed, 1);
  assert.equal(h.coordinator.protectQuit({ preventDefault() {} }, () => resumed++), false);
});

test("a quit-time hold lapses so a cancelled quit does not disable updates for the session", async () => {
  const h = harness({ shutdownHoldMs: 5 });
  let checks = 0;
  h.updater.checkForUpdates = async () => { checks++; };
  h.coordinator.holdForQuit();
  await h.coordinator.check(true);
  assert.equal(checks, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  await h.coordinator.check(true);
  assert.equal(checks, 1);
  h.coordinator.hold();
  await h.coordinator.check(true);
  assert.equal(checks, 1);
});
